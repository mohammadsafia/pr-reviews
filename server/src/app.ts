import { rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { BitbucketAuthError, BitbucketClient } from './bitbucket/client.js'
import { parsePrUrl } from './bitbucket/parsePrUrl.js'
import { DEFAULT_CONFIG_PATH, loadConfig, saveConfig, type Config } from './config.js'
import { RepoCache } from './repos/cache.js'
import { countDiffLines } from './review/findings.js'
import { runReview, sdkQuery, type AgentQuery } from './review/runner.js'
import { makeSerialQueue } from './queue.js'
import { readSkillContent, scanSkillDirs } from './skills/scanner.js'
import { addGithubSource, refreshGithubSource, skillRepoCloneDir } from './skills/sources.js'
import { RunStore } from './store/runs.js'
import type { PrMeta, PrRef, RunEvent, RunRecord } from './types.js'

const MASK = '***'

export function buildApp(deps: { configPath?: string; agentQuery?: AgentQuery } = {}): FastifyInstance {
  const configPath = deps.configPath ?? DEFAULT_CONFIG_PATH
  const agentQuery = deps.agentQuery ?? sdkQuery
  const app = Fastify()
  const events = new EventEmitter()
  const runQueue = makeSerialQueue((err) => app.log.error(err))

  const cfg = (): Config => loadConfig(configPath)
  const store = (): RunStore => new RunStore(cfg().runsDir)
  const skillReposDir = (): string => join(dirname(cfg().cacheDir), 'skill-repos')

  app.get('/api/config', async () => {
    const c = cfg()
    return { ...c, bitbucketToken: c.bitbucketToken ? MASK : '' }
  })

  app.put('/api/config', async (req) => {
    const incoming = req.body as Config
    const current = cfg()
    if (incoming.bitbucketToken === MASK) incoming.bitbucketToken = current.bitbucketToken
    saveConfig(incoming, configPath)
    return { ok: true }
  })

  app.get('/api/skills', async () => scanSkillDirs(cfg().skillDirs))

  app.post('/api/skill-sources/github', async (req, reply) => {
    const { repo } = req.body as { repo: string }
    let result: { dir: string; skillCount: number }
    try {
      result = await addGithubSource(repo, { reposDir: skillReposDir() })
    } catch (err: any) {
      const invalid = /^(Invalid GitHub repo|No skills found)/.test(err.message)
      return reply.code(invalid ? 400 : 502).send({ error: err.message })
    }
    const c = cfg()
    if (!c.skillDirs.includes(result.dir)) {
      c.skillDirs.push(result.dir)
      saveConfig(c, configPath)
    }
    return result
  })

  app.delete('/api/skill-sources', async (req) => {
    const { dir } = req.body as { dir: string }
    const c = cfg()
    c.skillDirs = c.skillDirs.filter((d) => d !== dir)
    saveConfig(c, configPath)
    if (skillRepoCloneDir(dir, skillReposDir())) {
      rmSync(dir, { recursive: true, force: true })
    }
    return { ok: true }
  })

  app.post('/api/skill-sources/refresh', async (req, reply) => {
    const { dir } = req.body as { dir: string }
    try {
      const result = await refreshGithubSource(dir, { reposDir: skillReposDir() })
      return result
    } catch (err: any) {
      const notGithub = /^Not a GitHub-backed/.test(err.message)
      return reply.code(notGithub ? 400 : 502).send({ error: err.message })
    }
  })

  app.get('/api/runs', async () => store().list())

  app.get('/api/runs/:id', async (req, reply) => {
    const run = store().get((req.params as { id: string }).id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    return run
  })

  app.post('/api/runs', async (req, reply) => {
    const body = req.body as { url: string; skills: string[]; focus?: string; force?: boolean }
    const c = cfg()
    let pr: PrRef
    try {
      pr = parsePrUrl(body.url)
    } catch (err: any) {
      return reply.code(400).send({ error: err.message })
    }
    const client = new BitbucketClient(c.bitbucketEmail, c.bitbucketToken)
    let meta: PrMeta
    let diff: string
    try {
      meta = await client.getPullRequest(pr)
      diff = await client.getDiff(pr)
    } catch (err: any) {
      const code = err instanceof BitbucketAuthError ? 401 : 502
      return reply.code(code).send({ error: err.message })
    }
    const diffLines = countDiffLines(diff)
    if (diffLines > c.diffWarnLines && !body.force) {
      return reply.code(409).send({
        error: `Diff has ${diffLines} changed lines (threshold ${c.diffWarnLines}). Re-submit with force to proceed.`,
        diffLines,
      })
    }
    const run = store().create({
      pr,
      prTitle: meta.title,
      skills: body.skills,
      focus: body.focus,
      status: 'queued',
    })
    runQueue.push(() => executeRun(run.id, { pr, meta, diff, body }))
    return reply.code(202).send({ id: run.id })
  })

  async function executeRun(
    runId: string,
    ctx: { pr: PrRef; meta: PrMeta; diff: string; body: { skills: string[]; focus?: string } },
  ): Promise<void> {
    let s: RunStore | undefined
    let run: RunRecord | undefined
    try {
      const c = cfg()
      s = store()
      run = s.get(runId)
      if (!run) return
      const emit = (e: RunEvent) => {
        run!.transcript.push(e)
        s!.save(run!)
        events.emit(runId, e)
      }
      run.status = 'running'
      s.save(run)
      emit({ kind: 'status', text: 'Preparing repository checkout…', at: new Date().toISOString() })
      const client = new BitbucketClient(c.bitbucketEmail, c.bitbucketToken)
      const cache = new RepoCache(c.cacheDir)
      const cwd = await cache.ensureCheckout(ctx.pr, {
        cloneUrl: client.cloneUrl(ctx.pr, c.cloneProtocol),
        sourceBranch: ctx.meta.sourceBranch,
        commit: ctx.meta.sourceCommit,
      })
      emit({ kind: 'status', text: 'Starting review agent…', at: new Date().toISOString() })
      const all = scanSkillDirs(c.skillDirs)
      const skills = all
        .filter((sk) => ctx.body.skills.includes(sk.name))
        .map((sk) => ({ name: sk.name, content: readSkillContent(sk) }))
      run.findings = await runReview(
        { meta: ctx.meta, diff: ctx.diff, skills, focus: ctx.body.focus, cwd, model: c.model },
        emit,
        agentQuery,
      )
      run.status = 'completed'
    } catch (err: any) {
      if (s && run) {
        run.status = 'failed'
        run.error = err.message
        const errorEvent: RunEvent = { kind: 'error', text: err.message, at: new Date().toISOString() }
        run.transcript.push(errorEvent)
        events.emit(runId, errorEvent)
      }
    } finally {
      if (s && run) {
        run.finishedAt = new Date().toISOString()
        s.save(run)
      }
      events.emit(runId, { kind: 'done' })
    }
  }

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
        events.removeListener(id, send)
      } else {
        reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
      }
    }
    events.on(id, send)
    const run = new RunStore(cfg().runsDir).get(id)
    if (run && run.status !== 'running' && run.status !== 'queued') send({ kind: 'done' })
    req.raw.on('close', () => events.removeListener(id, send))
  })

  app.post('/api/runs/:id/comments', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const { findingIndexes } = req.body as { findingIndexes: number[] }
    const s = store()
    const run = s.get(id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    const c = cfg()
    const client = new BitbucketClient(c.bitbucketEmail, c.bitbucketToken)
    const posted: number[] = []
    for (const i of findingIndexes) {
      const f = run.findings[i]
      if (!f) continue
      const text = `**[AI review — ${f.severity}/${f.category}]** ${f.summary}\n\n${f.detail}\n\n**Suggestion:** ${f.suggestion}`
      posted.push(await client.postInlineComment(run.pr, { path: f.file, line: f.line, text }))
    }
    run.postedCommentIds.push(...posted)
    s.save(run)
    return { posted }
  })

  app.delete('/api/cache/:workspace/:repo', async (req) => {
    const { workspace, repo } = req.params as { workspace: string; repo: string }
    new RepoCache(cfg().cacheDir).clear({ workspace, repo, id: 0 })
    return { ok: true }
  })

  return app
}
