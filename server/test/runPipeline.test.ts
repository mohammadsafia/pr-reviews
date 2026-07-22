import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { loadConfig, saveConfig } from '../src/config.js'
import type { BitbucketLike } from '../src/bitbucket/client.js'
import type { AgentQuery } from '../src/review/runner.js'
import type { PrMeta } from '../src/types.js'

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

function fakeBitbucket(meta: PrMeta, diff: string): BitbucketLike {
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
      bitbucketFactory: () => fakeBitbucket({ ...meta, sourceCommit: commit }, diff),
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
    expect(run.findings).toEqual([finding])
  })

  it('409s an oversized diff without force, and 202s (and completes) with force', async () => {
    const path = tempConfig(2) // tiny threshold so a 3-changed-line diff already exceeds it
    const diff = '+line1\n+line2\n+line3\n'
    const app = buildApp({
      configPath: path,
      bitbucketFactory: () => fakeBitbucket({ ...meta, sourceCommit: commit }, diff),
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
})
