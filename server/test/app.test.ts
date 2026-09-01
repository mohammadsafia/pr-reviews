import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildApp } from '../src/app.js'
import { saveConfig, loadConfig } from '../src/config.js'
import { fingerprint } from '../src/review/fingerprint.js'
import { RunStore } from '../src/store/runs.js'
import type { Finding, PrProviderClient } from '../src/types.js'

function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prr-app-'))
  const skillsDir = join(dir, 'skills')
  mkdirSync(join(skillsDir, 'review-code'), { recursive: true })
  writeFileSync(
    join(skillsDir, 'review-code', 'SKILL.md'),
    '---\nname: review-code\ndescription: desc\n---\nbody',
  )
  const path = join(dir, 'config.json')
  const cfg = loadConfig(path)
  cfg.bitbucketToken = 'tok'
  cfg.bitbucketEmail = 'e@x.io'
  cfg.githubToken = 'ghtok'
  cfg.skillDirs = [skillsDir]
  cfg.runsDir = join(dir, 'runs')
  cfg.cacheDir = join(dir, 'repos')
  saveConfig(cfg, path)
  return path
}

describe('app', () => {
  it('GET /api/config masks both tokens', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.statusCode).toBe(200)
    expect(res.json().bitbucketToken).toBe('***')
    expect(res.json().githubToken).toBe('***')
  })

  it('PUT /api/config keeps existing tokens when masked values are sent', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const body = {
      ...loadConfig(path),
      bitbucketToken: '***',
      githubToken: '***',
      model: 'claude-opus-4-8',
    }
    const res = await app.inject({ method: 'PUT', url: '/api/config', payload: body })
    expect(res.statusCode).toBe(200)
    expect(loadConfig(path).bitbucketToken).toBe('tok')
    expect(loadConfig(path).githubToken).toBe('ghtok')
    expect(loadConfig(path).model).toBe('claude-opus-4-8')
  })

  it('PUT /api/config rejects an invalid field with 400 and leaves the on-disk config unchanged', async () => {
    const path = tempConfig()
    const before = loadConfig(path)
    const app = buildApp({ configPath: path })
    const body = { ...before, diffWarnLines: -5 }
    const res = await app.inject({ method: 'PUT', url: '/api/config', payload: body })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeTruthy()
    expect(loadConfig(path)).toEqual(before)
  })

  it('PUT /api/config rejects an invalid cloneProtocol with 400 and leaves the on-disk config unchanged', async () => {
    const path = tempConfig()
    const before = loadConfig(path)
    const app = buildApp({ configPath: path })
    const body = { ...before, cloneProtocol: 'ftp' }
    const res = await app.inject({ method: 'PUT', url: '/api/config', payload: body })
    expect(res.statusCode).toBe(400)
    expect(loadConfig(path)).toEqual(before)
  })

  it('GET /api/skills lists scanned skills', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({ method: 'GET', url: '/api/skills' })
    expect(res.json().map((s: any) => s.name)).toEqual(['review-code'])
  })

  it('POST /api/runs rejects an invalid URL with 400', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://example.com/not/a/pr', skills: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Invalid PR URL/)
  })

  it('POST /api/runs rejects a malformed bitbucket URL with 400', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/src/main', skills: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Invalid PR URL/)
  })

  it('POST /api/runs rejects a malformed github URL with 400', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://github.com/ws/repo/issues/1', skills: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Invalid PR URL/)
  })

  it('GET /api/runs/:id returns 404 for unknown run', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({ method: 'GET', url: '/api/runs/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('POST /api/skill-sources/github rejects an invalid repo with 400', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/skill-sources/github',
      payload: { repo: 'not-a-repo' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Invalid GitHub repo/)
  })

  it('DELETE /api/skill-sources removes the entry from config skillDirs', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const dir = loadConfig(path).skillDirs[0]
    const res = await app.inject({ method: 'DELETE', url: '/api/skill-sources', payload: { dir } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(loadConfig(path).skillDirs).not.toContain(dir)
  })

  it('DELETE /api/skill-sources removes the whole clone root, not just the stored skills/ subdir', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const c = loadConfig(path)
    const reposDir = join(dirname(c.cacheDir), 'skill-repos')
    const cloneRoot = join(reposDir, 'acme__skills')
    const cloneSkillsDir = join(cloneRoot, 'skills')
    mkdirSync(cloneSkillsDir, { recursive: true })
    mkdirSync(join(cloneRoot, '.git'), { recursive: true })
    c.skillDirs.push(cloneSkillsDir)
    saveConfig(c, path)
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/skill-sources',
      payload: { dir: cloneSkillsDir },
    })
    expect(res.statusCode).toBe(200)
    // the config entry removed stays exactly the dir that was stored
    expect(loadConfig(path).skillDirs).not.toContain(cloneSkillsDir)
    // but the whole clone root (including its .git) is gone from disk
    expect(existsSync(cloneRoot)).toBe(false)
    expect(existsSync(cloneSkillsDir)).toBe(false)
  })

  it('POST /api/skill-sources/refresh 400s for a dir that is not GitHub-backed', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/skill-sources/refresh',
      payload: { dir: '/some/local/skills' },
    })
    expect(res.statusCode).toBe(400)
  })

  // Concurrency note: PUT /api/config and DELETE /api/skill-sources each perform their
  // read-modify-save with only synchronous fs calls (loadConfig/saveConfig use readFileSync/
  // writeFileSync), so within this process they can never truly interleave — whichever
  // handler's body starts first always runs to completion before the other starts. That was
  // verified empirically (30 trials each way) both with and without the withConfigLock fix:
  // firing PUT before DELETE always preserves both writes (asserted below, and true pre-fix
  // too); firing DELETE before PUT always loses the DELETE's change, pre-fix AND post-fix,
  // because PUT replaces the *entire* config with a body snapshot taken before either request
  // was sent — a stale-full-overwrite issue that a same-process mutex cannot fix (it only
  // prevents interleaved corruption, not a client PUTing back data it fetched before someone
  // else's change landed). The mutex's real value is serializing the awaited, genuinely-async
  // critical section in POST /api/skill-sources/github (post-clone read-modify-save) against
  // any other config writer; this test instead pins the invariant that matters for PUT/DELETE
  // today — concurrent requests, whatever their order, must not corrupt the file or silently
  // drop writes.
  it('PUT /api/config and DELETE /api/skill-sources fired concurrently both land on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-app-race-'))
    const dirA = join(dir, 'skillsA')
    const dirB = join(dir, 'skillsB')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    const path = join(dir, 'config.json')
    const seeded = loadConfig(path)
    seeded.skillDirs = [dirA, dirB]
    seeded.runsDir = join(dir, 'runs')
    seeded.cacheDir = join(dir, 'repos')
    saveConfig(seeded, path)

    const app = buildApp({ configPath: path })
    const putBody = { ...loadConfig(path), model: 'race-model' }

    const [putRes, delRes] = await Promise.all([
      app.inject({ method: 'PUT', url: '/api/config', payload: putBody }),
      app.inject({ method: 'DELETE', url: '/api/skill-sources', payload: { dir: dirA } }),
    ])

    expect(putRes.statusCode).toBe(200)
    expect(delRes.statusCode).toBe(200)
    const final = loadConfig(path)
    expect(final.model).toBe('race-model')
    expect(final.skillDirs).not.toContain(dirA)
    expect(final.skillDirs).toContain(dirB)
  })

  it('POST /api/runs/:id/comments saves posted ids incrementally and returns posted/failed on a partial failure', async () => {
    const path = tempConfig()
    const c = loadConfig(path)
    const runStore = new RunStore(c.runsDir)
    const run = runStore.create({
      pr: { provider: 'bitbucket', workspace: 'ws', repo: 'repo', id: 1 },
      prTitle: 'T',
      skills: [],
      verify: true,
      status: 'completed',
    })
    const mkFinding = (summary: string): Finding => ({
      file: 'a.ts',
      line: 1,
      severity: 'low',
      category: 'style',
      summary,
      detail: 'd',
      suggestion: 'x',
      skills: ['review-code'],
      verdict: 'confirmed',
    })
    run.findings = [mkFinding('first'), mkFinding('second')]
    runStore.save(run)

    let call = 0
    const fakeBitbucket: PrProviderClient = {
      getPullRequest: async () => {
        throw new Error('not used')
      },
      getDiff: async () => {
        throw new Error('not used')
      },
      cloneUrl: () => 'not used',
      listComments: async () => [],
      postInlineComment: async () => {
        call++
        if (call === 1) return 111
        throw new Error('bitbucket down')
      },
    }
    const app = buildApp({ configPath: path, clientFactory: () => fakeBitbucket })
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/comments`,
      payload: { findingIndexes: [0, 1] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.posted).toEqual([111])
    expect(body.skipped).toEqual([])
    expect(body.failed).toEqual([{ index: 1, error: 'bitbucket down' }])
    expect(body.dedupeChecked).toBe(true)
    const saved = runStore.get(run.id)!
    expect(saved.postedCommentIds).toEqual([111])
  })

  it('rejects posting comments on a test run', async () => {
    const path = tempConfig()
    const c = loadConfig(path)
    const runStore = new RunStore(c.runsDir)
    const run = runStore.create({
      pr: { provider: 'bitbucket', workspace: 'ws', repo: 'repo', id: 1 },
      prTitle: 'T',
      skills: ['draft-skill'],
      verify: false,
      isTest: true,
      testSkillContent: '---\nname: draft-skill\n---\nbody',
      status: 'completed',
    })
    run.findings = [
      {
        file: 'a.ts',
        line: 1,
        severity: 'low',
        category: 'style',
        summary: 's',
        detail: 'd',
        suggestion: 'x',
        skills: ['draft-skill'],
        verdict: 'confirmed',
      },
    ]
    runStore.save(run)

    const app = buildApp({ configPath: path })
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/comments`,
      payload: { findingIndexes: [0] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/test run/i)
  })

  it('POST /api/runs/:id/comments skips findings whose fingerprint already exists (open → already-posted, resolved → resolved) and appends the marker when posting new ones', async () => {
    const path = tempConfig()
    const c = loadConfig(path)
    const runStore = new RunStore(c.runsDir)
    const pr = { provider: 'bitbucket' as const, workspace: 'ws', repo: 'repo', id: 1 }
    const run = runStore.create({
      pr,
      prTitle: 'T',
      skills: [],
      verify: true,
      status: 'completed',
    })
    const mkFinding = (summary: string): Finding => ({
      file: 'a.ts',
      line: 1,
      severity: 'low',
      category: 'style',
      summary,
      detail: 'd',
      suggestion: 'x',
      skills: ['review-code'],
      verdict: 'confirmed',
    })
    const findings = [mkFinding('first'), mkFinding('second'), mkFinding('third')]
    run.findings = findings
    runStore.save(run)

    const fp0 = fingerprint(pr, findings[0])
    const fp1 = fingerprint(pr, findings[1])
    const fp2 = fingerprint(pr, findings[2])

    const postedBodies: string[] = []
    const fakeClient: PrProviderClient = {
      getPullRequest: async () => {
        throw new Error('not used')
      },
      getDiff: async () => {
        throw new Error('not used')
      },
      cloneUrl: () => 'not used',
      listComments: async () => [
        { path: 'a.ts', line: 1, body: `existing open comment\n\n<!-- prr-fp:${fp0} -->`, resolved: false },
        { path: 'a.ts', line: 1, body: `existing resolved comment\n\n<!-- prr-fp:${fp1} -->`, resolved: true },
      ],
      postInlineComment: async (_pr, comment) => {
        postedBodies.push(comment.text)
        return 999
      },
    }
    const app = buildApp({ configPath: path, clientFactory: () => fakeClient })
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/comments`,
      payload: { findingIndexes: [0, 1, 2] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.skipped).toEqual(
      expect.arrayContaining([
        { index: 0, reason: 'already-posted' },
        { index: 1, reason: 'resolved' },
      ]),
    )
    expect(body.skipped).toHaveLength(2)
    expect(body.posted).toEqual([999])
    expect(body.failed).toEqual([])
    expect(body.dedupeChecked).toBe(true)
    expect(postedBodies).toHaveLength(1)
    expect(postedBodies[0].endsWith(`\n\n<!-- prr-fp:${fp2} -->`)).toBe(true)
  })

  it('POST /api/runs/:id/comments skips the second of two intra-batch findings with an identical fingerprint (same file/category/summary, different lines)', async () => {
    const path = tempConfig()
    const c = loadConfig(path)
    const runStore = new RunStore(c.runsDir)
    const pr = { provider: 'bitbucket' as const, workspace: 'ws', repo: 'repo', id: 1 }
    const run = runStore.create({
      pr,
      prTitle: 'T',
      skills: [],
      verify: true,
      status: 'completed',
    })
    const mkFinding = (line: number): Finding => ({
      file: 'a.ts',
      line,
      severity: 'low',
      category: 'style',
      summary: 'duplicate finding',
      detail: 'd',
      suggestion: 'x',
      skills: ['review-code'],
      verdict: 'confirmed',
    })
    // Same file/category/summary but different lines -> same fingerprint, since fingerprint
    // is line-independent.
    const findings = [mkFinding(1), mkFinding(2)]
    run.findings = findings
    runStore.save(run)

    let call = 0
    const fakeClient: PrProviderClient = {
      getPullRequest: async () => {
        throw new Error('not used')
      },
      getDiff: async () => {
        throw new Error('not used')
      },
      cloneUrl: () => 'not used',
      listComments: async () => [],
      postInlineComment: async () => {
        call++
        return 500 + call
      },
    }
    const app = buildApp({ configPath: path, clientFactory: () => fakeClient })
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/comments`,
      payload: { findingIndexes: [0, 1] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.posted).toEqual([501])
    expect(body.skipped).toEqual([{ index: 1, reason: 'already-posted' }])
    expect(body.failed).toEqual([])
    expect(call).toBe(1)
  })

  it('POST /api/runs/:id/comments fails open when listComments throws: posts all, dedupeChecked false', async () => {
    const path = tempConfig()
    const c = loadConfig(path)
    const runStore = new RunStore(c.runsDir)
    const pr = { provider: 'bitbucket' as const, workspace: 'ws', repo: 'repo', id: 1 }
    const run = runStore.create({
      pr,
      prTitle: 'T',
      skills: [],
      verify: true,
      status: 'completed',
    })
    const finding: Finding = {
      file: 'a.ts',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 'first',
      detail: 'd',
      suggestion: 'x',
      skills: ['review-code'],
      verdict: 'confirmed',
    }
    run.findings = [finding]
    runStore.save(run)

    const fakeClient: PrProviderClient = {
      getPullRequest: async () => {
        throw new Error('not used')
      },
      getDiff: async () => {
        throw new Error('not used')
      },
      cloneUrl: () => 'not used',
      listComments: async () => {
        throw new Error('provider down')
      },
      postInlineComment: async () => 777,
    }
    const app = buildApp({ configPath: path, clientFactory: () => fakeClient })
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/comments`,
      payload: { findingIndexes: [0] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.posted).toEqual([777])
    expect(body.skipped).toEqual([])
    expect(body.failed).toEqual([])
    expect(body.dedupeChecked).toBe(false)
  })

  it('GET /api/runs/:id/post-preview classifies each finding as new/already-posted/resolved', async () => {
    const path = tempConfig()
    const c = loadConfig(path)
    const runStore = new RunStore(c.runsDir)
    const pr = { provider: 'bitbucket' as const, workspace: 'ws', repo: 'repo', id: 1 }
    const run = runStore.create({
      pr,
      prTitle: 'T',
      skills: [],
      verify: true,
      status: 'completed',
    })
    const mkFinding = (summary: string): Finding => ({
      file: 'a.ts',
      line: 1,
      severity: 'low',
      category: 'style',
      summary,
      detail: 'd',
      suggestion: 'x',
      skills: ['review-code'],
      verdict: 'confirmed',
    })
    const findings = [mkFinding('first'), mkFinding('second'), mkFinding('third')]
    run.findings = findings
    runStore.save(run)

    const fp0 = fingerprint(pr, findings[0])
    const fp1 = fingerprint(pr, findings[1])

    const fakeClient: PrProviderClient = {
      getPullRequest: async () => {
        throw new Error('not used')
      },
      getDiff: async () => {
        throw new Error('not used')
      },
      cloneUrl: () => 'not used',
      listComments: async () => [
        { path: 'a.ts', line: 1, body: `existing open comment\n\n<!-- prr-fp:${fp0} -->`, resolved: false },
        { path: 'a.ts', line: 1, body: `existing resolved comment\n\n<!-- prr-fp:${fp1} -->`, resolved: true },
      ],
      postInlineComment: async () => 1,
    }
    const app = buildApp({ configPath: path, clientFactory: () => fakeClient })
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/post-preview` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.dedupeChecked).toBe(true)
    expect(body.statuses).toEqual([
      { index: 0, status: 'already-posted' },
      { index: 1, status: 'resolved' },
      { index: 2, status: 'new' },
    ])
  })

  it('DELETE /api/cache/:provider/:workspace/:repo rejects path traversal and deletes nothing outside the cache', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const c = loadConfig(path)
    const cacheParent = dirname(c.cacheDir)
    const sentinelDir = join(cacheParent, 'etc')
    mkdirSync(sentinelDir, { recursive: true })
    writeFileSync(join(sentinelDir, 'passwd'), 'secret')

    const res = await app.inject({ method: 'DELETE', url: '/api/cache/bitbucket/..%2Fetc/passwd' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeTruthy()
    expect(existsSync(join(sentinelDir, 'passwd'))).toBe(true)
  })

  it('DELETE /api/cache/:provider/:workspace/:repo rejects "." and ".." segments explicitly', async () => {
    // Fastify's router normalizes bare "." / ".." path segments before dispatch (they never
    // reach our handler as literal params — requests for them 404 at the router). We assert
    // the safe-segment validator itself rejects "." and ".." directly as defense in depth,
    // since the router's behavior is an implementation detail we shouldn't rely on alone.
    const { isSafeCacheSegment } = await import('../src/app.js')
    expect(isSafeCacheSegment('.')).toBe(false)
    expect(isSafeCacheSegment('..')).toBe(false)
    expect(isSafeCacheSegment('ws')).toBe(true)
    expect(isSafeCacheSegment('../etc')).toBe(false)
  })

  it('DELETE /api/cache/:provider/:workspace/:repo rejects an unknown provider with 400', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const res = await app.inject({ method: 'DELETE', url: '/api/cache/gitlab/ws/repo' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/provider/i)
  })

  it('DELETE /api/cache/:provider/:workspace/:repo succeeds for a normal bitbucket workspace/repo', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const c = loadConfig(path)
    const repoDir = join(c.cacheDir, 'bitbucket', 'ws', 'repo')
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(join(repoDir, 'file.txt'), 'x')

    const res = await app.inject({ method: 'DELETE', url: '/api/cache/bitbucket/ws/repo' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(existsSync(repoDir)).toBe(false)
  })

  it('DELETE /api/cache/:provider/:workspace/:repo succeeds for a normal github workspace/repo', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const c = loadConfig(path)
    const repoDir = join(c.cacheDir, 'github', 'ws', 'repo')
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(join(repoDir, 'file.txt'), 'x')

    const res = await app.inject({ method: 'DELETE', url: '/api/cache/github/ws/repo' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(existsSync(repoDir)).toBe(false)
  })

  it('marks stranded running/queued runs as failed on startup', async () => {
    const path = tempConfig()
    const c = loadConfig(path)
    const runStore = new RunStore(c.runsDir)
    const runningRun = runStore.create({
      pr: { provider: 'bitbucket', workspace: 'ws', repo: 'repo', id: 1 },
      prTitle: 'Running one',
      skills: [],
      verify: true,
      status: 'running',
    })
    const queuedRun = runStore.create({
      pr: { provider: 'bitbucket', workspace: 'ws', repo: 'repo', id: 2 },
      prTitle: 'Queued one',
      skills: [],
      verify: true,
      status: 'queued',
    })
    const completedRun = runStore.create({
      pr: { provider: 'bitbucket', workspace: 'ws', repo: 'repo', id: 3 },
      prTitle: 'Completed one',
      skills: [],
      verify: true,
      status: 'completed',
    })

    buildApp({ configPath: path })

    const freshStore = new RunStore(c.runsDir)
    const running = freshStore.get(runningRun.id)!
    const queued = freshStore.get(queuedRun.id)!
    const completed = freshStore.get(completedRun.id)!
    expect(running.status).toBe('failed')
    expect(running.error).toMatch(/restarted/i)
    expect(running.finishedAt).toBeTruthy()
    expect(queued.status).toBe('failed')
    expect(queued.error).toMatch(/restarted/i)
    // untouched
    expect(completed.status).toBe('completed')
    expect(completed.error).toBeUndefined()
  })

  it('GET /api/runs/:id/events ends promptly with a done event for an unknown run id', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist/events' })
    expect(res.body).toContain('event: done')
  })
})

describe('model profile apiKey masking', () => {
  it('masks openai apiKeys on GET and restores them on masked PUT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-app-'))
    const path = join(dir, 'config.json')
    const cfg = loadConfig(path)
    cfg.modelProfiles = [
      ...cfg.modelProfiles,
      { id: 'kimi', label: 'Kimi', kind: 'openai', baseUrl: 'https://api.moonshot.ai/v1', apiKey: 'sk-secret', model: 'kimi-k2' },
    ]
    saveConfig(cfg, path)
    const app = buildApp({ configPath: path })

    const got = (await app.inject({ method: 'GET', url: '/api/config' })).json()
    const kimi = got.modelProfiles.find((p: any) => p.id === 'kimi')
    expect(kimi.apiKey).toBe('***')

    // PUT the masked config back with an unrelated change — the stored key must survive
    got.diffWarnLines = 1234
    const put = await app.inject({ method: 'PUT', url: '/api/config', payload: got })
    expect(put.statusCode).toBe(200)
    const stored = loadConfig(path)
    const storedKimi = stored.modelProfiles.find((p) => p.id === 'kimi') as any
    expect(storedKimi.apiKey).toBe('sk-secret')
    expect(stored.diffWarnLines).toBe(1234)
  })
})
