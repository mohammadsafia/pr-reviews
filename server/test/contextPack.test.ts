import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPrManifest, parseDiffStats, writeContextPack } from '../src/review/contextPack.js'
import type { PrMeta } from '../src/types.js'

const meta: PrMeta = {
  title: 'My PR',
  description: 'does things',
  sourceBranch: 'feat/x',
  destinationBranch: 'main',
  sourceCommit: 'abc',
}

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' unchanged',
  '+added one',
  '+added two',
  '-removed one',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/old.ts b/new.ts',
  '--- a/old.ts',
  '+++ b/new.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
].join('\n')

describe('parseDiffStats', () => {
  it('counts added/removed per file, ignores +++/--- headers, handles binary and renames', () => {
    expect(parseDiffStats(diff)).toEqual([
      { file: 'src/a.ts', added: 2, removed: 1 },
      { file: 'img.png', added: 0, removed: 0 },
      { file: 'new.ts', added: 1, removed: 1 }, // rename: the b/ path wins
    ])
  })

  it('returns [] for an empty diff', () => {
    expect(parseDiffStats('')).toEqual([])
  })
})

describe('buildPrManifest', () => {
  it('renders title, description, branches, and the changed-file list with counts', () => {
    const md = buildPrManifest(meta, diff)
    expect(md).toContain('# PR: My PR')
    expect(md).toContain('does things')
    expect(md).toContain('feat/x → main')
    expect(md).toContain('## Changed files (3)')
    expect(md).toContain('- src/a.ts (+2/-1)')
  })

  it('renders (none) when the description is empty', () => {
    expect(buildPrManifest({ ...meta, description: '' }, diff)).toContain('(none)')
  })
})

describe('writeContextPack', () => {
  function tempCheckout(): string {
    const dir = mkdtempSync(join(tmpdir(), 'prr-pack-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    return dir
  }

  it('writes diff.patch and pr.md and excludes .pr-review/ via .git/info/exclude', () => {
    const cwd = tempCheckout()
    writeContextPack(cwd, meta, diff)
    expect(readFileSync(join(cwd, '.pr-review', 'diff.patch'), 'utf8')).toBe(diff)
    expect(readFileSync(join(cwd, '.pr-review', 'pr.md'), 'utf8')).toContain('# PR: My PR')
    expect(readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')).toContain('.pr-review/')
  })

  it('removes stale contents from a previous run and does not duplicate the exclude entry', () => {
    const cwd = tempCheckout()
    mkdirSync(join(cwd, '.pr-review'), { recursive: true })
    writeFileSync(join(cwd, '.pr-review', 'stale.txt'), 'old')
    writeContextPack(cwd, meta, diff)
    writeContextPack(cwd, meta, diff) // second run: exclude entry must not duplicate
    expect(existsSync(join(cwd, '.pr-review', 'stale.txt'))).toBe(false)
    const exclude = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter((l) => l === '.pr-review/')).toHaveLength(1)
  })

  it('skips the exclude write when .git is a file (worktree checkout) without crashing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prr-pack-wt-'))
    const gitPointer = 'gitdir: /elsewhere/.git/worktrees/x\n'
    writeFileSync(join(cwd, '.git'), gitPointer)
    writeContextPack(cwd, meta, diff)
    expect(readFileSync(join(cwd, '.pr-review', 'diff.patch'), 'utf8')).toBe(diff)
    expect(readFileSync(join(cwd, '.git'), 'utf8')).toBe(gitPointer) // pointer untouched
  })
})
