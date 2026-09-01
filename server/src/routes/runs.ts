import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { PrAuthError } from '../providers/errors.js'
import { parsePrUrl } from '../providers/parsePrUrl.js'
import { RepoCache } from '../repos/cache.js'
import { writeContextPack } from '../review/contextPack.js'
import { extractDiffContext } from '../review/diffContext.js'
import { dedupeFindings } from '../review/dedup.js'
import { fingerprint } from '../review/fingerprint.js'
import { autoSubmitIndexes, postFindingComments, readExistingFingerprints } from '../review/post.js'
import { countDiffLines, sortFindings } from '../review/findings.js'
import { groupSkills } from '../review/grouping.js'
import { profileById } from '../models/profiles.js'
import { runReview } from '../review/runner.js'
import { verifyFindingsBatch } from '../review/verify.js'
import { parseFrontmatter, readSkillContent, scanSkillDirs } from '../skills/scanner.js'
import { RunStore } from '../store/runs.js'
import type { AutoSubmit, Depth, Finding, PrMeta, PrRef, RunEvent, RunRecord, SkillRunResult } from '../types.js'

/**
 * Recovers runs left in `running`/`queued` state by a previous process that died or was
 * restarted mid-run — they can never make progress again since nothing is driving them, and
 * without this they'd sit forever showing "running" to the UI (and SSE clients waiting on
 * events that will never fire, see the /events route).
 */
export function sweepStrandedRuns(runsDir: string): void {
  const s = new RunStore(runsDir)
  for (const summary of s.list()) {
    if (summary.status !== 'running' && summary.status !== 'queued') continue
    const run = s.get(summary.id)
    if (!run) continue
    run.status = 'failed'
    run.error = 'Server restarted while this run was in progress'
    run.finishedAt = new Date().toISOString()
    s.save(run)
  }
}

export function registerRunRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/runs', async () => ctx.store().list().filter((r) => !r.isTest))

  app.get('/api/runs/:id', async (req, reply) => {
    const run = ctx.store().get((req.params as { id: string }).id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    return run
  })

  app.post('/api/runs', async (req, reply) => {
    const body = req.body as {
      url: string
      skills: string[]
      focus?: string
      force?: boolean
      verify?: boolean
      depth?: Depth
      profile?: string
      autoSubmit?: AutoSubmit
      parentRunId?: string
    }
    const c = ctx.cfg()
    let pr: PrRef
    try {
      pr = parsePrUrl(body.url)
    } catch (err: any) {
      return reply.code(400).send({ error: err.message })
    }
    const client = ctx.clientFactory(pr, c)
    let meta: PrMeta
    let diff: string
    try {
      meta = await client.getPullRequest(pr)
      diff = await client.getDiff(pr)
    } catch (err: any) {
      const code = err instanceof PrAuthError ? 401 : 502
      return reply.code(code).send({ error: err.message })
    }
    const diffLines = countDiffLines(diff)
    if (diffLines > c.diffWarnLines && !body.force) {
      return reply.code(409).send({
        error: `Diff has ${diffLines} changed lines (threshold ${c.diffWarnLines}). Re-submit with force to proceed.`,
        diffLines,
      })
    }
    const DEPTHS: readonly Depth[] = ['thorough', 'balanced', 'economy']
    if (body.depth !== undefined && !DEPTHS.includes(body.depth)) {
      return reply.code(400).send({ error: `Invalid depth: ${String(body.depth)}` })
    }
    const depth: Depth = body.depth ?? c.defaultDepth
    if (body.profile !== undefined && !c.modelProfiles.some((p) => p.id === body.profile)) {
      return reply.code(400).send({ error: `Unknown model profile: ${body.profile}` })
    }
    const reviewProfileId = body.profile ?? c.reviewProfile
    if (body.autoSubmit !== undefined) {
      const ok =
        ['high', 'medium', 'all'].includes(body.autoSubmit?.threshold as string) &&
        typeof body.autoSubmit?.confirmedOnly === 'boolean'
      if (!ok) return reply.code(400).send({ error: 'Invalid autoSubmit options' })
    }
    const run = ctx.store().create({
      pr,
      prTitle: meta.title,
      skills: body.skills,
      focus: body.focus,
      verify: body.verify !== false,
      depth,
      reviewProfile: reviewProfileId,
      autoSubmit: body.autoSubmit,
      parentRunId: body.parentRunId,
      status: 'queued',
    })
    ctx.runQueue.push(() => executeRun(ctx, run.id, { pr, meta, diff, depth, body }))
    return reply.code(202).send({ id: run.id })
  })

  app.post('/api/skills/test-run', async (req, reply) => {
    const body = req.body as { url: string; skillContent: string; profile?: string; force?: boolean }
    const c = ctx.cfg()
    let pr: PrRef
    try {
      pr = parsePrUrl(body.url)
    } catch (err: any) {
      return reply.code(400).send({ error: err.message })
    }
    const client = ctx.clientFactory(pr, c)
    let meta: PrMeta
    let diff: string
    try {
      meta = await client.getPullRequest(pr)
      diff = await client.getDiff(pr)
    } catch (err: any) {
      const code = err instanceof PrAuthError ? 401 : 502
      return reply.code(code).send({ error: err.message })
    }
    const diffLines = countDiffLines(diff)
    if (diffLines > c.diffWarnLines && !body.force) {
      return reply.code(409).send({
        error: `Diff has ${diffLines} changed lines (threshold ${c.diffWarnLines}). Re-submit with force to proceed.`,
        diffLines,
      })
    }
    if (body.profile !== undefined && !c.modelProfiles.some((p) => p.id === body.profile)) {
      return reply.code(400).send({ error: `Unknown model profile: ${body.profile}` })
    }
    const run = ctx.store().create({
      pr,
      prTitle: meta.title,
      skills: [],
      verify: false,
      isTest: true,
      testSkillContent: body.skillContent,
      status: 'queued',
    })
    ctx.runQueue.push(() =>
      executeTestRun(ctx, run.id, { pr, meta, diff, skillContent: body.skillContent, profile: body.profile }),
    )
    return reply.code(202).send({ id: run.id })
  })

  app.get('/api/runs/:id/events', (req, reply) => {
    const id = (req.params as { id: string }).id
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const send = (e: RunEvent | { kind: 'done' }) => {
      if (e.kind === 'done') {
        reply.raw.write('event: done\ndata: {}\n\n')
        reply.raw.end()
        ctx.events.removeListener(id, send)
      } else {
        reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
      }
    }
    ctx.events.on(id, send)
    const run = ctx.store().get(id)
    if (!run || (run.status !== 'running' && run.status !== 'queued')) send({ kind: 'done' })
    req.raw.on('close', () => ctx.events.removeListener(id, send))
  })

  app.post('/api/runs/:id/comments', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const { findingIndexes } = req.body as { findingIndexes: number[] }
    const s = ctx.store()
    const run = s.get(id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    if (run.isTest) return reply.code(400).send({ error: 'Cannot post comments from a test run.' })
    const client = ctx.clientFactory(run.pr, ctx.cfg())
    return postFindingComments(client, run, findingIndexes, (r) => s.save(r))
  })

  app.get('/api/runs/:id/post-preview', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const run = ctx.store().get(id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    const client = ctx.clientFactory(run.pr, ctx.cfg())
    const { fps, dedupeChecked } = await readExistingFingerprints(client, run.pr)
    const statuses = run.findings.map((f, index) => {
      const fp = fingerprint(run.pr, f)
      const status = !fps.has(fp) ? 'new' : fps.get(fp) ? 'resolved' : 'already-posted'
      return { index, status: status as 'new' | 'already-posted' | 'resolved' }
    })
    return { statuses, dedupeChecked }
  })
}

async function executeRun(
  ctx: AppContext,
  runId: string,
  runCtx: {
    pr: PrRef
    meta: PrMeta
    diff: string
    depth: Depth
    body: { skills: string[]; focus?: string; verify?: boolean }
  },
): Promise<void> {
  let s: RunStore | undefined
  let run: RunRecord | undefined
  let cache: RepoCache | undefined
  try {
    const c = ctx.cfg()
    s = ctx.store()
    run = s.get(runId)
    if (!run) return
    const emit = (e: RunEvent) => {
      run!.transcript.push(e)
      if (e.kind === 'usage') {
        run!.usage ??= { inputTokens: 0, outputTokens: 0 }
        run!.usage.inputTokens += e.inputTokens ?? 0
        run!.usage.outputTokens += e.outputTokens ?? 0
        // Round to avoid binary floating-point drift (e.g. 0.05 + 0.01 !== 0.06) while
        // still preserving sub-cent precision, which real per-token costs can have.
        if (e.costUsd !== undefined) run!.usage.costUsd = Math.round(((run!.usage.costUsd ?? 0) + e.costUsd) * 1e8) / 1e8
      }
      s!.save(run!)
      ctx.events.emit(runId, e)
    }
    run.status = 'running'
    s.save(run)
    emit({ kind: 'status', text: 'Preparing repository checkout…', at: new Date().toISOString() })
    const client = ctx.clientFactory(runCtx.pr, c)
    cache = new RepoCache(c.cacheDir)
    const cwd = await cache.ensureWorktree(runCtx.pr, {
      cloneUrl: client.cloneUrl(runCtx.pr, c.cloneProtocol),
      sourceBranch: runCtx.meta.sourceBranch,
      commit: runCtx.meta.sourceCommit,
      runId,
    })
    emit({ kind: 'status', text: 'Writing review context…', at: new Date().toISOString() })
    // Throws → the outer catch fails the run: never review without a fresh context pack.
    writeContextPack(cwd, runCtx.meta, runCtx.diff)
    emit({ kind: 'status', text: 'Starting review agent…', at: new Date().toISOString() })
    const requestedId = run.reviewProfile
    const reviewProfile = profileById(c, requestedId)
    if (requestedId !== undefined && reviewProfile.id !== requestedId) {
      emit({
        kind: 'status',
        text: `Model profile "${requestedId}" no longer exists — using "${reviewProfile.id}" instead.`,
        at: new Date().toISOString(),
      })
    }
    const reviewQuery = ctx.agentQuery ?? ctx.queryFactory(reviewProfile)
    const verifyQuery = ctx.agentQuery ?? ctx.queryFactory(profileById(c, c.verifyProfile))
    const all = scanSkillDirs(c.skillDirs)
    const selected = all
      .filter((sk) => runCtx.body.skills.includes(sk.name))
      .map((sk) => ({ name: sk.name, content: readSkillContent(sk) }))
    // Skills are chunked into session groups by the run's depth (thorough=1, balanced=3,
    // economy=all); groups run in parallel with no concurrency cap. When nothing is
    // selected, fall back to a single synthetic "general" unit so the run behaves as a
    // plain review.
    const groups: { name: string; content: string }[][] =
      selected.length > 0 ? groupSkills(selected, runCtx.depth) : [[{ name: 'general', content: '' }]]

    const outcomes = await Promise.all(
      groups.map(async (group): Promise<{ results: SkillRunResult[]; findings: Finding[] }> => {
        const label = group.map((g) => g.name).join(', ')
        const wrappedEmit = (e: RunEvent) => emit({ ...e, skill: label })
        try {
          wrappedEmit({
            kind: 'status',
            text: `Reviewing with: ${label}…`,
            at: new Date().toISOString(),
          })
          const findings = await runReview(
            {
              meta: runCtx.meta,
              skills: group[0].name === 'general' ? [] : group,
              focus: runCtx.body.focus,
              cwd,
              query: reviewQuery,
              reformatQuery: verifyQuery,
            },
            wrappedEmit,
          )
          return {
            results: group.map((g) => ({
              skill: g.name,
              status: 'completed' as const,
              findingCount: findings.filter((f) => f.skills.includes(g.name)).length,
            })),
            findings,
          }
        } catch (err: any) {
          wrappedEmit({ kind: 'error', text: err.message, at: new Date().toISOString() })
          return {
            results: group.map((g) => ({
              skill: g.name,
              status: 'failed' as const,
              findingCount: 0,
              error: err.message,
            })),
            findings: [],
          }
        }
      }),
    )

    const merged = outcomes.flatMap((o) => o.findings)
    run.skillResults = outcomes.flatMap((o) => o.results)
    const allFailed = run.skillResults.every((r) => r.status === 'failed')

    let findings = dedupeFindings(merged)
    const doVerify = runCtx.body.verify !== false
    run.verify = doVerify
    if (doVerify && findings.length > 0 && !allFailed) {
      emit({ kind: 'status', text: `Verifying ${findings.length} findings…`, at: new Date().toISOString() })
      const verdicts = await verifyFindingsBatch(findings, { meta: runCtx.meta, cwd }, emit, verifyQuery)
      findings.forEach((f, i) => {
        f.verdict = verdicts[i].verdict
        if (verdicts[i].reason) f.verifierReason = verdicts[i].reason
      })
    }
    sortFindings(findings)
    findings.forEach((f) => {
      f.context = extractDiffContext(runCtx.diff, f.file, f.line)
    })
    run.findings = findings

    if (allFailed) {
      run.status = 'failed'
      run.error = `All ${run.skillResults.length} skill reviews failed`
    } else {
      run.status = 'completed'
      if (run.autoSubmit && run.findings.length > 0) {
        const indexes = autoSubmitIndexes(run.findings, run.autoSubmit)
        if (indexes.length > 0) {
          emit({ kind: 'status', text: `Auto-posting ${indexes.length} findings…`, at: new Date().toISOString() })
          try {
            const result = await postFindingComments(client, run, indexes, (r) => s!.save(r), { requireDedupe: true })
            run.autoSubmitResult = {
              posted: result.posted.length,
              skipped: result.skipped.length,
              failed: result.failed.length,
              dedupeChecked: result.dedupeChecked,
            }
            const text = !result.dedupeChecked
              ? 'Auto-post skipped: could not check existing comments — findings left for manual review.'
              : `Auto-posted ${result.posted.length} comment${result.posted.length === 1 ? '' : 's'}.` +
                (result.skipped.length > 0 ? ` Skipped ${result.skipped.length}.` : '') +
                (result.failed.length > 0 ? ` Failed ${result.failed.length}.` : '')
            emit({ kind: 'status', text, at: new Date().toISOString() })
          } catch (err: any) {
            emit({ kind: 'error', text: `Auto-post failed: ${err.message}`, at: new Date().toISOString() })
          }
        }
      }
    }
  } catch (err: any) {
    if (s && run) {
      run.status = 'failed'
      run.error = err.message
      const errorEvent: RunEvent = { kind: 'error', text: err.message, at: new Date().toISOString() }
      run.transcript.push(errorEvent)
      ctx.events.emit(runId, errorEvent)
    }
  } finally {
    if (cache) {
      try {
        await cache.removeWorktree(runCtx.pr, runId)
      } catch (err: any) {
        // Cleanup must never change the run's outcome; the startup sweep is the backstop.
        if (run)
          run.transcript.push({
            kind: 'status',
            text: `Worktree cleanup failed: ${err.message}`,
            at: new Date().toISOString(),
          })
      }
    }
    if (s && run) {
      run.finishedAt = new Date().toISOString()
      s.save(run)
    }
    ctx.events.emit(runId, { kind: 'done' })
  }
}

async function executeTestRun(
  ctx: AppContext,
  runId: string,
  runCtx: { pr: PrRef; meta: PrMeta; diff: string; skillContent: string; profile?: string },
): Promise<void> {
  let s: RunStore | undefined
  let run: RunRecord | undefined
  let cache: RepoCache | undefined
  try {
    const c = ctx.cfg()
    s = ctx.store()
    run = s.get(runId)
    if (!run) return
    const emit = (e: RunEvent) => {
      run!.transcript.push(e)
      s!.save(run!)
      ctx.events.emit(runId, e)
    }
    run.status = 'running'
    s.save(run)
    emit({ kind: 'status', text: 'Preparing repository checkout…', at: new Date().toISOString() })
    const client = ctx.clientFactory(runCtx.pr, c)
    cache = new RepoCache(c.cacheDir)
    const cwd = await cache.ensureWorktree(runCtx.pr, {
      cloneUrl: client.cloneUrl(runCtx.pr, c.cloneProtocol),
      sourceBranch: runCtx.meta.sourceBranch,
      commit: runCtx.meta.sourceCommit,
      runId,
    })
    emit({ kind: 'status', text: 'Writing review context…', at: new Date().toISOString() })
    writeContextPack(cwd, runCtx.meta, runCtx.diff)
    const skillName = parseFrontmatter(runCtx.skillContent).name ?? 'test'
    emit({ kind: 'status', text: `Testing skill "${skillName}"…`, at: new Date().toISOString() })
    const profile = profileById(c, runCtx.profile)
    const query = ctx.agentQuery ?? ctx.queryFactory(profile)
    const findings = await runReview(
      {
        meta: runCtx.meta,
        skills: [{ name: skillName, content: runCtx.skillContent }],
        cwd,
        query,
        reformatQuery: query,
      },
      emit,
    )
    run.skills = [skillName]
    run.findings = sortFindings(findings)
    run.status = 'completed'
  } catch (err: any) {
    if (s && run) {
      run.status = 'failed'
      run.error = err.message
      const errorEvent: RunEvent = { kind: 'error', text: err.message, at: new Date().toISOString() }
      run.transcript.push(errorEvent)
      ctx.events.emit(runId, errorEvent)
    }
  } finally {
    if (cache) {
      try {
        await cache.removeWorktree(runCtx.pr, runId)
      } catch (err: any) {
        if (run)
          run.transcript.push({
            kind: 'status',
            text: `Worktree cleanup failed: ${err.message}`,
            at: new Date().toISOString(),
          })
      }
    }
    if (s && run) {
      run.finishedAt = new Date().toISOString()
      s.save(run)
    }
    ctx.events.emit(runId, { kind: 'done' })
  }
}
