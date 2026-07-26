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
    cloneUrl: () => origin,
  }
}

function fakeAgent(findings: unknown[]): AgentQuery {
  return async function* () {
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
    // No skills selected -> the synthetic "general" unit runs, and executeRun force-attributes
    // finding.skills = [unit.name] regardless of what the (fixture) finding claims, so it
    // comes back as ["general"] rather than the "review-code" the fixture data sets.
    const { skill: _skill1, ...findingRest } = finding
    expect(run.findings).toEqual([{ ...findingRest, skills: ['general'], verdict: 'confirmed' }])
    expect(run.skillResults).toEqual([{ skill: 'general', status: 'completed', findingCount: 1 }])
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
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'] },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    // Force-attribution overrides whatever skill label the agent claimed.
    const { skill: _skillA, ...findingARest } = findingA
    const { skill: _skillB, ...findingBRest } = findingB
    expect(run.findings).toEqual(
      expect.arrayContaining([
        { ...findingARest, skills: ['skill-a'], verdict: 'confirmed' },
        { ...findingBRest, skills: ['skill-b'], verdict: 'confirmed' },
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
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'] },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    const { skill: _skillA2, ...findingARest2 } = findingA
    expect(run.findings).toEqual([{ ...findingARest2, skills: ['skill-a'], verdict: 'confirmed' }])
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
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'] },
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
    expect(run.findings).toEqual([{ ...findingRest2, skills: ['general'], verdict: 'confirmed' }])
    expect(run.skillResults).toEqual([{ skill: 'general', status: 'completed', findingCount: 1 }])
  })
})
