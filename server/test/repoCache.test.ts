import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { RepoCache, redactCredentials, sweepStrandedWorktrees } from '../src/repos/cache.js'

let origin: string
let commit: string
const pr = { provider: 'bitbucket' as const, workspace: 'ws', repo: 'fixture', id: 1 }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

beforeAll(() => {
  origin = mkdtempSync(join(tmpdir(), 'prr-origin-'))
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

describe('RepoCache', () => {
  it('clones the base, fetches the PR branch, and checks the commit out in a per-run worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const dir = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'run-1' })
    expect(dir).toBe(join(root, '.worktrees', 'bitbucket', 'ws', 'fixture', 'run-1'))
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('feature\n')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(commit)
    // worktree .git is a pointer FILE, and the base clone's exclude covers .pr-review/
    expect(statSync(join(dir, '.git')).isFile()).toBe(true)
    const base = join(root, 'bitbucket', 'ws', 'fixture')
    expect(readFileSync(join(base, '.git', 'info', 'exclude'), 'utf8')).toContain('.pr-review/')
  })

  it('two runs of the same repo get coexisting worktrees at their own commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const opts = { cloneUrl: origin, sourceBranch: 'feat/x', commit }
    const [a, b] = await Promise.all([
      cache.ensureWorktree(pr, { ...opts, runId: 'run-a' }),
      cache.ensureWorktree(pr, { ...opts, runId: 'run-b' }),
    ])
    expect(a).not.toBe(b)
    expect(git(a, 'rev-parse', 'HEAD')).toBe(commit)
    expect(git(b, 'rev-parse', 'HEAD')).toBe(commit)
  })

  it('reuses the base clone for a second run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const opts = { cloneUrl: origin, sourceBranch: 'feat/x', commit }
    await cache.ensureWorktree(pr, { ...opts, runId: 'r1' })
    const marker = join(root, 'bitbucket', 'ws', 'fixture', 'marker.txt')
    writeFileSync(marker, 'still here means no re-clone')
    await cache.ensureWorktree(pr, { ...opts, runId: 'r2' })
    expect(existsSync(marker)).toBe(true)
  })

  it('self-heals a stale base dir without .git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const repoPath = join(root, 'bitbucket', 'ws', 'fixture')
    mkdirSync(repoPath, { recursive: true })
    writeFileSync(join(repoPath, 'stale.txt'), 'junk')
    const dir = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'r1' })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('feature\n')
    expect(existsSync(join(repoPath, 'stale.txt'))).toBe(false)
  })

  it('surfaces git stderr on failure', async () => {
    const cache = new RepoCache(mkdtempSync(join(tmpdir(), 'prr-cache-')))
    await expect(
      cache.ensureWorktree(pr, { cloneUrl: '/nonexistent/repo', sourceBranch: 'x', commit: 'y', runId: 'r' }),
    ).rejects.toThrow(/git clone failed/)
  })

  it('namespaces the repo dir by provider, so bitbucket and github clones of the same workspace/repo do not collide', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const bbPr = { provider: 'bitbucket' as const, workspace: 'ws', repo: 'fixture', id: 1 }
    const ghPr = { provider: 'github' as const, workspace: 'ws', repo: 'fixture', id: 1 }
    expect(cache.repoDir(bbPr)).toBe(join(root, 'bitbucket', 'ws', 'fixture'))
    expect(cache.repoDir(ghPr)).toBe(join(root, 'github', 'ws', 'fixture'))
    expect(cache.repoDir(bbPr)).not.toBe(cache.repoDir(ghPr))
  })

  it('clear removes the base clone AND the repo worktree subtree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const wt = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'r1' })
    cache.clear(pr)
    expect(existsSync(join(root, 'bitbucket', 'ws', 'fixture'))).toBe(false)
    expect(existsSync(wt)).toBe(false)
  })

  it('removeWorktree deletes the worktree and is a no-op when it never existed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const wt = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'r1' })
    // an untracked file (like the .pr-review pack) must not block removal
    writeFileSync(join(wt, 'untracked.txt'), 'x')
    await cache.removeWorktree(pr, 'r1')
    expect(existsSync(wt)).toBe(false)
    await cache.removeWorktree(pr, 'never-existed') // must not throw
  })

  it('a removed runId can be reused (stale registration pruned before add)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const opts = { cloneUrl: origin, sourceBranch: 'feat/x', commit }
    const first = await cache.ensureWorktree(pr, { ...opts, runId: 'r1' })
    rmSync(first, { recursive: true, force: true }) // simulate a crash leaving git's registration stale
    const second = await cache.ensureWorktree(pr, { ...opts, runId: 'r1' })
    expect(readFileSync(join(second, 'a.txt'), 'utf8')).toBe('feature\n')
  })

  it('sweepStrandedWorktrees deletes the .worktrees tree and prunes base registrations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const wt = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'r1' })
    sweepStrandedWorktrees(root)
    expect(existsSync(join(root, '.worktrees'))).toBe(false)
    // registration pruned: the same runId is usable again immediately
    const again = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'r1' })
    expect(existsSync(again)).toBe(true)
    expect(wt).toBe(again)
  })

  it('redacts embedded user:pass@ credentials from a URL in a git error message', () => {
    const msg =
      "fatal: unable to access 'https://user%40x.io:secrettoken@bitbucket.org/ws/repo.git/': " +
      'Could not resolve host'
    const redacted = redactCredentials(msg)
    expect(redacted).not.toContain('secrettoken')
    expect(redacted).toBe(
      "fatal: unable to access 'https://***:***@bitbucket.org/ws/repo.git/': Could not resolve host",
    )
  })

  it('leaves git error messages with no embedded credentials untouched', () => {
    const msg = "fatal: repository 'https://bitbucket.org/ws/repo.git/' not found"
    expect(redactCredentials(msg)).toBe(msg)
  })

  it('clear refuses to delete a path that escapes the cache root (defense in depth)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const sentinelDir = join(dirname(root), 'sentinel-outside-cache')
    mkdirSync(sentinelDir, { recursive: true })
    writeFileSync(join(sentinelDir, 'keep.txt'), 'keep me')
    expect(() =>
      cache.clear({ provider: 'bitbucket', workspace: '../..', repo: 'sentinel-outside-cache', id: 0 }),
    ).toThrow(/outside/i)
    expect(existsSync(join(sentinelDir, 'keep.txt'))).toBe(true)
  })
})
