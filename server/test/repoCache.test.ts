import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoCache } from '../src/repos/cache.js'

let origin: string
let commit: string
const pr = { workspace: 'ws', repo: 'fixture', id: 1 }

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
  it('clones, fetches the PR branch, and checks out the commit detached', async () => {
    const cache = new RepoCache(mkdtempSync(join(tmpdir(), 'prr-cache-')))
    const dir = await cache.ensureCheckout(pr, {
      cloneUrl: origin,
      sourceBranch: 'feat/x',
      commit,
    })
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('feature\n')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(commit)
  })

  it('reuses an existing clone on second call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const opts = { cloneUrl: origin, sourceBranch: 'feat/x', commit }
    const first = await cache.ensureCheckout(pr, opts)
    const second = await cache.ensureCheckout(pr, opts)
    expect(second).toBe(first)
  })

  it('clear removes the cached repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const dir = await cache.ensureCheckout(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit })
    cache.clear(pr)
    expect(existsSync(dir)).toBe(false)
  })

  it('self-heals a stale repo dir without .git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const repoPath = join(root, 'ws', 'fixture')
    mkdirSync(repoPath, { recursive: true })
    writeFileSync(join(repoPath, 'stale.txt'), 'junk')
    const dir = await cache.ensureCheckout(pr, {
      cloneUrl: origin,
      sourceBranch: 'feat/x',
      commit,
    })
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('feature\n')
    expect(existsSync(join(dir, 'stale.txt'))).toBe(false)
  })

  it('surfaces git stderr on failure', async () => {
    const cache = new RepoCache(mkdtempSync(join(tmpdir(), 'prr-cache-')))
    await expect(
      cache.ensureCheckout(pr, { cloneUrl: '/nonexistent/repo', sourceBranch: 'x', commit: 'y' }),
    ).rejects.toThrow(/git clone failed/)
  })
})
