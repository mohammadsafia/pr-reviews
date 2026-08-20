import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PrMeta } from '../types.js'

export interface DiffStat {
  file: string
  added: number
  removed: number
}

export function parseDiffStats(diff: string): DiffStat[] {
  const stats: DiffStat[] = []
  let cur: DiffStat | undefined
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (header) {
      cur = { file: header[2], added: 0, removed: 0 }
      stats.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) cur.added++
    else if (line.startsWith('-')) cur.removed++
  }
  return stats
}

export function buildPrManifest(meta: PrMeta, diff: string): string {
  const stats = parseDiffStats(diff)
  const files = stats.map((s) => `- ${s.file} (+${s.added}/-${s.removed})`).join('\n')
  return [
    `# PR: ${meta.title}`,
    '',
    meta.description || '(none)',
    '',
    `Branches: ${meta.sourceBranch} → ${meta.destinationBranch}`,
    '',
    `## Changed files (${stats.length})`,
    files,
    '',
  ].join('\n')
}

/** Writes the per-run context pack into the checkout. Deletes any previous pack first so a
 * run can never see stale data, and hides the directory from git via .git/info/exclude
 * (never the repo's tracked .gitignore). Throws on any fs error — callers treat that as
 * fatal to the run. */
export function writeContextPack(cwd: string, meta: PrMeta, diff: string): void {
  const dir = join(cwd, '.pr-review')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'diff.patch'), diff)
  writeFileSync(join(dir, 'pr.md'), buildPrManifest(meta, diff))
  const excludePath = join(cwd, '.git', 'info', 'exclude')
  mkdirSync(dirname(excludePath), { recursive: true })
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  if (!existing.split('\n').includes('.pr-review/')) {
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
    writeFileSync(excludePath, `${existing}${sep}.pr-review/\n`)
  }
}
