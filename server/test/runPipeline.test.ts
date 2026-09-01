import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { loadConfig, saveConfig } from '../src/config.js'
import type { AgentQuery } from '../src/review/runner.js'
import type { PrMeta, PrProviderClient } from '../src/types.js'

// Integration coverage for the full run pipeline: POST /api/runs -> queued executeRun ->
// real RepoCache checkout against a local git fixture (mirroring repoCache.test.ts's
// approach, so no network is needed) -> mocked agent -> findings persisted on the run.
// Also covers the oversized-diff 409/force-202 gate, which no per-unit test exercised.

let origin: string
let commit: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeAll(() => {
  origin = mkdtempSync(join(tmpdir(), 'prr-pipeline-origin-'))
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'config', 'user.email', 't@t')
  git(origin, 'config', 'user.name', 't')
  writeFileSync(join(origin, 'a.txt'), 'main\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'init')
  git(origin, 'checkout', '-qb', 'feat/x')
  writeFileSync(join(origin, 'a.txt'), 'feature\n')
  git(origin, 'commit', '-aqm', 'feature change')
  commit = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'checkout', '-q', 'main')
})

function tempConfig(diffWarnLines = 8000): string {
  const dir = mkdtempSync(join(tmpdir(), 'prr-pipeline-'))
  const path = join(dir, 'config.json')
  const cfg = loadConfig(path)
  cfg.bitbucketEmail = 'e@x.io'
  cfg.bitbucketToken = 'tok'
  cfg.skillDirs = []
  cfg.runsDir = join(dir, 'runs')
  cfg.cacheDir = join(dir, 'repos')
  cfg.diffWarnLines = diffWarnLines
  saveConfig(cfg, path)
  return path
}

/** Like tempConfig but seeds one skill directory per name in `names`, so scanSkillDirs
 * (and therefore the executeRun fan-out) picks them up as selectable skills. */
function tempConfigWithSkills(names: string[], diffWarnLines = 8000): string {
  const dir = mkdtempSync(join(tmpdir(), 'prr-pipeline-skills-'))
  const skillsDir = join(dir, 'skills')
  for (const name of names) {
    mkdirSync(join(skillsDir, name), { recursive: true })
    writeFileSync(join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody for ${name}`)
  }
  const path = join(dir, 'config.json')
  const cfg = loadConfig(path)
  cfg.bitbucketEmail = 'e@x.io'
  cfg.bitbucketToken = 'tok'
  cfg.skillDirs = [skillsDir]
  cfg.runsDir = join(dir, 'runs')
  cfg.cacheDir = join(dir, 'repos')
  cfg.diffWarnLines = diffWarnLines
  saveConfig(cfg, path)
  return path
}

function fakeClient(meta: PrMeta, diff: string): PrProviderClient {
  return {
    getPullRequest: async () => meta,
    getDiff: async () => diff,
    postInlineComment: async () => 1,
    listComments: async () => [],
    cloneUrl: () => origin,
  }
}

/** Answers a batch-verify prompt by parsing the findings fence it embeds and confirming
 * every index (verdictFor overrides per summary). Reasons are omitted for confirmed so
 * exact-equality assertions on findings stay clean. */
function batchVerdicts(
  prompt: string,
  verdictFor: (summary: string) => 'confirmed' | 'unverified' = () => 'confirmed',
): string {
  const items = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)![1]) as { index: number; summary: string }[]
  const verdicts = items.map((it) => {
    const verdict = verdictFor(it.summary)
    return verdict === 'confirmed' ? { index: it.index, verdict } : { index: it.index, verdict, reason: 'nope' }
  })
  return '```json\n' + JSON.stringify(verdicts) + '\n```'
}

// Every finding now goes through a verify pass by default, so the shared fakes must answer
// the batched verifier's prompt (recognizable by its distinctive "adversarially verifying"
// text) as well as the initial review prompt — otherwise every pre-existing test in this
// file would pick up a spurious fail-open verifierReason and its exact-equality assertions
// would break.
function fakeAgent(findings: unknown[]): AgentQuery {
  return async function* (prompt: string) {
    if (/adversarially verifying/.test(prompt)) {
      yield { type: 'result' as const, ok: true, text: batchVerdicts(prompt) }
      return
    }
    yield { type: 'assistant' as const, text: 'reviewing' }
    yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify(findings) + '\n```' }
  }
}

/** Dispatches per-skill, based on the "## Skill: <name>" section runner.ts's buildReviewPrompt
 * injects for each selected skill (absent → "general", the synthetic no-skills-selected unit).
 * `bySkill[name]` is either an array of raw findings to report, or the literal 'fail' to make
 * that skill's subagent report an agent failure (mirrors a real SDK error result). */
function fakeAgentPerSkill(bySkill: Record<string, unknown[] | 'fail'>): AgentQuery {
  return async function* (prompt: string) {
    if (/adversarially verifying/.test(prompt)) {
      yield { type: 'result' as const, ok: true, text: batchVerdicts(prompt) }
      return
    }
    const match = /## Skill: (\S+)/.exec(prompt)
    const skillName = match ? match[1] : 'general'
    const outcome = bySkill[skillName]
    yield { type: 'assistant' as const, text: `reviewing ${skillName}` }
    if (outcome === 'fail') {
      yield { type: 'result' as const, ok: false, text: `boom from ${skillName}` }
      return
    }
    yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify(outcome ?? []) + '\n```' }
  }
}

async function pollRun(app: ReturnType<typeof buildApp>, id: string, timeoutMs = 5000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${id}` })
    const body = res.json()
    if (body.status === 'completed' || body.status === 'failed') return body
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('run did not reach a terminal status in time')
}

const meta: PrMeta = {
  title: 'T',
  description: '',
  sourceBranch: 'feat/x',
  destinationBranch: 'main',
  sourceCommit: '',
}

describe('run pipeline integration', () => {
  it('drives POST /api/runs through executeRun to completed with findings from a mocked agent', async () => {
    const path = tempConfig()
    const diff = '+line1\n+line2\n'
    const finding = {
      file: 'a.txt',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 's',
      detail: 'd',
      suggestion: 'x',
      skill: 'review-code',
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgent([finding]),
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [] },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    // No skills selected -> the synthetic "general" unit runs with validSkills ['general'],
    // so the fixture's "review-code" label is reattributed to ["general"].
    const { skill: _skill1, ...findingRest } = finding
    expect(run.findings).toEqual([{ ...findingRest, example: '', skills: ['general'], verdict: 'confirmed' }])
    expect(run.skillResults).toEqual([{ skill: 'general', status: 'completed', findingCount: 1 }])
  })

  it('attaches diff context to a finding whose line is present in the diff', async () => {
    const path = tempConfig()
    const diff = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1,1 +1,1 @@', '-main', '+feature'].join(
      '\n',
    )
    const finding = {
      file: 'a.txt',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 's',
      detail: 'd',
      suggestion: 'x',
      skill: 'review-code',
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgent([finding]),
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [] },
    })
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    expect(run.findings[0].context).toEqual([
      { type: 'remove', text: 'main', oldLine: 1 },
      { type: 'add', text: 'feature', newLine: 1 },
    ])
  })

  it('accumulates usage from review and verify sessions onto the run record', async () => {
    const path = tempConfig()
    const diff = '+line1\n+line2\n'
    const finding = {
      file: 'a.txt',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 's',
      detail: 'd',
      suggestion: 'x',
      skill: 'review-code',
    }
    const agent: AgentQuery = async function* (prompt) {
      if (/adversarially verifying/.test(prompt)) {
        const items = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)![1]) as { index: number }[]
        yield {
          type: 'result' as const,
          ok: true,
          text: '```json\n' + JSON.stringify(items.map((it) => ({ index: it.index, verdict: 'confirmed' }))) + '\n```',
          usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
        }
        return
      }
      yield {
        type: 'result' as const,
        ok: true,
        text: '```json\n' + JSON.stringify([finding]) + '\n```',
        usage: { inputTokens: 500, outputTokens: 80, costUsd: 0.05 },
      }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [] },
    })
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    expect(run.usage).toEqual({ inputTokens: 600, outputTokens: 100, costUsd: 0.06 })
  })

  it('reports a partial total when only some sessions in the run measure usage', async () => {
    // Mirrors a CLI-profile review paired with a Claude-SDK verify pass: the review
    // session reports no usage at all (like cliQuery never does), only verify does.
    const path = tempConfig()
    const diff = '+line1\n+line2\n'
    const finding = {
      file: 'a.txt',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 's',
      detail: 'd',
      suggestion: 'x',
      skill: 'review-code',
    }
    const agent: AgentQuery = async function* (prompt) {
      if (/adversarially verifying/.test(prompt)) {
        const items = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)![1]) as { index: number }[]
        yield {
          type: 'result' as const,
          ok: true,
          text: '```json\n' + JSON.stringify(items.map((it) => ({ index: it.index, verdict: 'confirmed' }))) + '\n```',
          usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
        }
        return
      }
      // No `usage` field at all — the review session reports nothing, as a CLI adapter would.
      yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [] },
    })
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    // Only the verify session's numbers show up — never a fabricated figure for the
    // review session that reported nothing.
    expect(run.usage).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 })
  })

  it('persists parentRunId when provided on create', async () => {
    const path = tempConfig()
    const diff = '+line1\n'
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgent([]),
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], parentRunId: 'parent-123' },
    })
    const { id } = createRes.json()
    const getRes = await app.inject({ method: 'GET', url: `/api/runs/${id}` })
    expect(getRes.json().parentRunId).toBe('parent-123')
  })

  it('409s an oversized diff without force, and 202s (and completes) with force', async () => {
    const path = tempConfig(2) // tiny threshold so a 3-changed-line diff already exceeds it
    const diff = '+line1\n+line2\n+line3\n'
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgent([]),
    })

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [] },
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().diffLines).toBe(3)

    const forced = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], force: true },
    })
    expect(forced.statusCode).toBe(202)
    const { id } = forced.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
  })

  it('fans out into one subagent per selected skill and merges findings from both', async () => {
    const path = tempConfigWithSkills(['skill-a', 'skill-b'])
    const diff = '+line1\n+line2\n'
    const findingA = {
      file: 'a.txt',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 'from a',
      detail: 'd',
      suggestion: 'x',
      skill: 'wrong-label',
    }
    const findingB = {
      file: 'a.txt',
      line: 2,
      severity: 'high',
      category: 'bug',
      summary: 'from b',
      detail: 'd',
      suggestion: 'x',
      skill: 'wrong-label',
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgentPerSkill({ 'skill-a': [findingA], 'skill-b': [findingB] }),
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'], depth: 'thorough' },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    // The "wrong-label" skill isn't in either session's validSkills, so each finding is
    // reattributed to its own session's (single) skill.
    const { skill: _skillA, ...findingARest } = findingA
    const { skill: _skillB, ...findingBRest } = findingB
    expect(run.findings).toEqual(
      expect.arrayContaining([
        { ...findingARest, example: '', skills: ['skill-a'], verdict: 'confirmed' },
        { ...findingBRest, example: '', skills: ['skill-b'], verdict: 'confirmed' },
      ]),
    )
    expect(run.findings).toHaveLength(2)
    expect(run.skillResults).toEqual(
      expect.arrayContaining([
        { skill: 'skill-a', status: 'completed', findingCount: 1 },
        { skill: 'skill-b', status: 'completed', findingCount: 1 },
      ]),
    )
    expect(run.skillResults).toHaveLength(2)
    // Streamed events are tagged with the skill that produced them.
    expect(run.transcript.some((e: any) => e.skill === 'skill-a')).toBe(true)
    expect(run.transcript.some((e: any) => e.skill === 'skill-b')).toBe(true)
  })

  it('keeps the run completed with partial findings when only one of two skills fails', async () => {
    const path = tempConfigWithSkills(['skill-a', 'skill-b'])
    const diff = '+line1\n+line2\n'
    const findingA = {
      file: 'a.txt',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 'from a',
      detail: 'd',
      suggestion: 'x',
      skill: 'skill-a',
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgentPerSkill({ 'skill-a': [findingA], 'skill-b': 'fail' }),
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'], depth: 'thorough' },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    const { skill: _skillA2, ...findingARest2 } = findingA
    expect(run.findings).toEqual([{ ...findingARest2, example: '', skills: ['skill-a'], verdict: 'confirmed' }])
    const bySkill = Object.fromEntries(run.skillResults.map((r: any) => [r.skill, r]))
    expect(bySkill['skill-a']).toEqual({ skill: 'skill-a', status: 'completed', findingCount: 1 })
    expect(bySkill['skill-b'].status).toBe('failed')
    expect(bySkill['skill-b'].findingCount).toBe(0)
    expect(bySkill['skill-b'].error).toBeTruthy()
  })

  it('marks the whole run failed when every skill subagent fails', async () => {
    const path = tempConfigWithSkills(['skill-a', 'skill-b'])
    const diff = '+line1\n+line2\n'
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgentPerSkill({ 'skill-a': 'fail', 'skill-b': 'fail' }),
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'], depth: 'thorough' },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/all 2 skill reviews failed/i)
    expect(run.findings).toEqual([])
    expect(run.skillResults.every((r: any) => r.status === 'failed')).toBe(true)
    expect(run.skillResults).toHaveLength(2)
  })

  it('drives a GitHub PR URL through the same pipeline to completed with findings (provider-agnostic fan-out)', async () => {
    const path = tempConfig()
    const diff = '+line1\n+line2\n'
    const finding = {
      file: 'a.txt',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 's',
      detail: 'd',
      suggestion: 'x',
      skill: 'review-code',
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgent([finding]),
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://github.com/ws/repo/pull/1', skills: [] },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    expect(run.pr).toEqual({ provider: 'github', workspace: 'ws', repo: 'repo', id: 1 })
    const { skill: _skill2, ...findingRest2 } = finding
    expect(run.findings).toEqual([{ ...findingRest2, example: '', skills: ['general'], verdict: 'confirmed' }])
    expect(run.skillResults).toEqual([{ skill: 'general', status: 'completed', findingCount: 1 }])
  })

  it('dedupes same-location findings across skills and verifies once each', async () => {
    const path = tempConfigWithSkills(['skill-a', 'skill-b'])
    const diff = '+line1\n+line2\n'
    const finding = {
      file: 'a.ts',
      line: 5,
      severity: 'high',
      category: 'bug',
      summary: 's',
      detail: 'd',
      suggestion: 'x',
      skill: 'ignored',
    }
    let verifyCalls = 0
    const agent: AgentQuery = async function* (prompt: string) {
      if (/adversarially verifying/.test(prompt)) {
        verifyCalls++
        yield { type: 'result' as const, ok: true, text: batchVerdicts(prompt) }
        return
      }
      yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'], depth: 'thorough' },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0].skills.slice().sort()).toEqual(['skill-a', 'skill-b'])
    expect(run.findings[0].verdict).toBe('confirmed')
    expect(verifyCalls).toBe(1)
  })

  it('skips verification when verify:false — no verifier agent calls, all confirmed', async () => {
    const path = tempConfigWithSkills(['skill-a'])
    const diff = '+line1\n+line2\n'
    const finding = {
      file: 'a.ts',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 's',
      detail: 'd',
      suggestion: 'x',
      skill: 'ignored',
    }
    let verifyCalls = 0
    const agent: AgentQuery = async function* (prompt: string) {
      if (/adversarially verifying/.test(prompt)) {
        verifyCalls++
        yield { type: 'result' as const, ok: true, text: '```json\n{"verdict":"confirmed"}\n```' }
        return
      }
      yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a'], verify: false },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    expect(run.verify).toBe(false)
    expect(verifyCalls).toBe(0)
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0].verdict).toBe('confirmed')
  })

  it('sorts unverified findings after confirmed, regardless of severity', async () => {
    const path = tempConfigWithSkills(['skill-a', 'skill-b'])
    const diff = '+line1\n+line2\n'
    const findingLow = {
      file: 'a.ts',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 'keep',
      detail: 'd',
      suggestion: 'x',
      skill: 'ignored',
    }
    const findingHigh = {
      file: 'a.ts',
      line: 2,
      severity: 'high',
      category: 'bug',
      summary: 'drop',
      detail: 'd',
      suggestion: 'x',
      skill: 'ignored',
    }
    const agent: AgentQuery = async function* (prompt: string) {
      if (/adversarially verifying/.test(prompt)) {
        yield {
          type: 'result' as const,
          ok: true,
          text: batchVerdicts(prompt, (s) => (s === 'drop' ? 'unverified' : 'confirmed')),
        }
        return
      }
      const match = /## Skill: (\S+)/.exec(prompt)
      const skillName = match ? match[1] : 'general'
      const finding = skillName === 'skill-a' ? findingLow : findingHigh
      yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'], depth: 'thorough' },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    expect(run.findings).toHaveLength(2)
    expect(run.findings[0].summary).toBe('keep')
    expect(run.findings[0].verdict).toBe('confirmed')
    expect(run.findings[1].summary).toBe('drop')
    expect(run.findings[1].verdict).toBe('unverified')
  })

  it('rejects an invalid depth with 400', async () => {
    const path = tempConfig()
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      agentQuery: fakeAgent([]),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], depth: 'bogus' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('balanced depth reviews grouped skills in ONE session, attributes per skill, and never embeds the diff', async () => {
    const path = tempConfigWithSkills(['skill-a', 'skill-b'])
    const diff = '+line1\n+line2\n'
    const mk = (skill: string, line: number) => ({
      file: 'a.txt', line, severity: 'low', category: 'style', summary: `from ${skill}`,
      detail: 'd', suggestion: 'x', skill,
    })
    const reviewPrompts: string[] = []
    const agent: AgentQuery = async function* (prompt: string) {
      if (/adversarially verifying/.test(prompt)) {
        yield { type: 'result' as const, ok: true, text: batchVerdicts(prompt) }
        return
      }
      reviewPrompts.push(prompt)
      yield {
        type: 'result' as const,
        ok: true,
        text: '```json\n' + JSON.stringify([mk('skill-a', 1), mk('skill-b', 2)]) + '\n```',
      }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'], depth: 'balanced' },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    expect(run.depth).toBe('balanced')
    expect(reviewPrompts).toHaveLength(1) // one grouped session, not two
    expect(reviewPrompts[0]).toContain('## Skill: skill-a')
    expect(reviewPrompts[0]).toContain('## Skill: skill-b')
    expect(reviewPrompts[0]).toContain('.pr-review/diff.patch')
    expect(reviewPrompts[0]).not.toContain('+line1') // the diff body stays out of the prompt
    const bySkill = Object.fromEntries(run.skillResults.map((r: any) => [r.skill, r]))
    expect(bySkill['skill-a']).toEqual({ skill: 'skill-a', status: 'completed', findingCount: 1 })
    expect(bySkill['skill-b']).toEqual({ skill: 'skill-b', status: 'completed', findingCount: 1 })
    expect(run.transcript.some((e: any) => e.skill === 'skill-a, skill-b')).toBe(true)
  })

  it('a failed grouped session marks every skill in the group failed', async () => {
    const path = tempConfigWithSkills(['skill-a', 'skill-b'])
    const agent: AgentQuery = async function* (prompt: string) {
      if (/adversarially verifying/.test(prompt)) {
        yield { type: 'result' as const, ok: true, text: batchVerdicts(prompt) }
        return
      }
      yield { type: 'result' as const, ok: false, text: 'boom' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      agentQuery: agent,
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'], depth: 'balanced' },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/all 2 skill reviews failed/i)
    expect(run.skillResults).toHaveLength(2)
    expect(run.skillResults.every((r: any) => r.status === 'failed')).toBe(true)
  })

  it('runs two PRs of the same repo concurrently in isolated worktrees (agent phases overlap)', async () => {
    const path = tempConfig()
    const diff = '+line1\n'
    const finding = {
      file: 'a.txt', line: 1, severity: 'low', category: 'style',
      summary: 's', detail: 'd', suggestion: 'x', skill: 'general',
    }
    let reviewStarts = 0
    const bothStarted = deferred()
    // Each review session blocks until BOTH runs' sessions have started — the test can only
    // pass if the two runs' agent phases truly overlap.
    const agent: AgentQuery = async function* () {
      reviewStarts++
      if (reviewStarts >= 2) bothStarted.resolve()
      await bothStarted.promise
      yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], verify: false },
    })
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/2', skills: [], verify: false },
    })
    const run1 = await pollRun(app, res1.json().id)
    const run2 = await pollRun(app, res2.json().id)
    expect(run1.status).toBe('completed')
    expect(run2.status).toBe('completed')
    expect(run1.findings).toHaveLength(1)
    expect(run2.findings).toHaveLength(1)
  })

  it('holds the second run queued when maxConcurrentRuns is 1', async () => {
    const path = tempConfig()
    const cfgObj = loadConfig(path)
    cfgObj.maxConcurrentRuns = 1
    saveConfig(cfgObj, path)
    const gate = deferred()
    const agent: AgentQuery = async function* () {
      await gate.promise
      yield { type: 'result' as const, ok: true, text: '```json\n[]\n```' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      agentQuery: agent,
    })
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], verify: false },
    })
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/2', skills: [], verify: false },
    })
    // give run 1 time to start; run 2 must still be queued behind the cap
    await new Promise((r) => setTimeout(r, 150))
    const r1 = (await app.inject({ method: 'GET', url: `/api/runs/${res1.json().id}` })).json()
    const r2 = (await app.inject({ method: 'GET', url: `/api/runs/${res2.json().id}` })).json()
    expect(r1.status).toBe('running')
    expect(r2.status).toBe('queued')
    gate.resolve()
    expect((await pollRun(app, res1.json().id)).status).toBe('completed')
    expect((await pollRun(app, res2.json().id)).status).toBe('completed')
  })

  it('rejects an unknown profile id with 400', async () => {
    const path = tempConfig()
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      agentQuery: fakeAgent([]),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], profile: 'ghost' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('ghost')
  })

  it('routes review and verify to their profiles via queryFactory and stores reviewProfile', async () => {
    const path = tempConfig()
    const cfgObj = loadConfig(path)
    cfgObj.modelProfiles = [
      ...cfgObj.modelProfiles,
      { id: 'codex', label: 'Codex', kind: 'cli', command: 'noop', args: [] },
    ]
    saveConfig(cfgObj, path)
    const finding = {
      file: 'a.txt', line: 1, severity: 'low', category: 'style',
      summary: 's', detail: 'd', suggestion: 'x', skill: 'general',
    }
    const used: string[] = []
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      queryFactory: (profile) =>
        async function* (prompt: string) {
          used.push(profile.id)
          if (/adversarially verifying/.test(prompt)) {
            yield { type: 'result' as const, ok: true, text: batchVerdicts(prompt) }
            return
          }
          yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
        },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], profile: 'codex' },
    })
    expect(res.statusCode).toBe(202)
    const run = await pollRun(app, res.json().id)
    expect(run.status).toBe('completed')
    expect(run.reviewProfile).toBe('codex')
    expect(used).toContain('codex') // review ran on the chosen profile
    expect(used).toContain('claude-haiku') // verify ran on the verify profile
  })

  it('falls back with a transcript note when the stored profile was deleted before the run started', async () => {
    const path = tempConfig()
    // config only has the claude defaults; simulate a stale reference by pointing reviewProfile at a ghost
    const cfgObj = loadConfig(path)
    cfgObj.reviewProfile = 'deleted-profile'
    saveConfig(cfgObj, path)
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      agentQuery: fakeAgent([]),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [] },
    })
    const run = await pollRun(app, res.json().id)
    expect(run.status).toBe('completed')
    expect(run.transcript.some((e: any) => /deleted-profile.*claude-sonnet/.test(e.text))).toBe(true)
  })

  it('auto-submit posts the filtered findings on completion and records the result', async () => {
    const path = tempConfigWithSkills(['skill-a'])
    const high = { file: 'a.txt', line: 1, severity: 'high', category: 'bug', summary: 'bad', detail: 'd', suggestion: 'x', skill: 'skill-a' }
    const low = { file: 'a.txt', line: 2, severity: 'low', category: 'style', summary: 'meh', detail: 'd', suggestion: 'x', skill: 'skill-a' }
    const postedTexts: string[] = []
    const client = {
      ...fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      postInlineComment: async (_pr: any, c: any) => {
        postedTexts.push(c.text)
        return postedTexts.length
      },
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => client,
      agentQuery: fakeAgentPerSkill({ 'skill-a': [high, low] }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        url: 'https://bitbucket.org/ws/repo/pull-requests/1',
        skills: ['skill-a'],
        autoSubmit: { threshold: 'medium', confirmedOnly: true },
      },
    })
    expect(res.statusCode).toBe(202)
    const run = await pollRun(app, res.json().id)
    expect(run.status).toBe('completed')
    expect(postedTexts).toHaveLength(1) // only the high finding passes threshold 'medium'
    expect(postedTexts[0]).toContain('bad')
    expect(run.autoSubmitResult).toEqual({ posted: 1, skipped: 0, failed: 0, dedupeChecked: true })
    expect(run.postedCommentIds).toEqual([1])
    expect(run.transcript.some((e: any) => /auto-posted 1 comment/i.test(e.text))).toBe(true)
  })

  it('auto-submit posts nothing when the existing-comment read fails (fail-closed)', async () => {
    const path = tempConfigWithSkills(['skill-a'])
    const high = { file: 'a.txt', line: 1, severity: 'high', category: 'bug', summary: 'bad', detail: 'd', suggestion: 'x', skill: 'skill-a' }
    const postedTexts: string[] = []
    const client = {
      ...fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      listComments: async () => {
        throw new Error('read failed')
      },
      postInlineComment: async () => {
        postedTexts.push('x')
        return 1
      },
    }
    const app = buildApp({ configPath: path, clientFactory: () => client, agentQuery: fakeAgentPerSkill({ 'skill-a': [high] }) })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        url: 'https://bitbucket.org/ws/repo/pull-requests/1',
        skills: ['skill-a'],
        autoSubmit: { threshold: 'all', confirmedOnly: false },
      },
    })
    const run = await pollRun(app, res.json().id)
    expect(run.status).toBe('completed')
    expect(postedTexts).toHaveLength(0)
    expect(run.autoSubmitResult?.dedupeChecked).toBe(false)
  })

  it('rejects a malformed autoSubmit with 400 and never auto-posts on failed runs', async () => {
    const path = tempConfigWithSkills(['skill-a'])
    const postedTexts: string[] = []
    const client = {
      ...fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      postInlineComment: async () => {
        postedTexts.push('x')
        return 1
      },
    }
    const app = buildApp({ configPath: path, clientFactory: () => client, agentQuery: fakeAgentPerSkill({ 'skill-a': 'fail' }) })
    const bad = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], autoSubmit: { threshold: 'urgent', confirmedOnly: true } },
    })
    expect(bad.statusCode).toBe(400)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        url: 'https://bitbucket.org/ws/repo/pull-requests/1',
        skills: ['skill-a'],
        autoSubmit: { threshold: 'all', confirmedOnly: false },
      },
    })
    const run = await pollRun(app, res.json().id)
    expect(run.status).toBe('failed')
    expect(postedTexts).toHaveLength(0)
  })
})
