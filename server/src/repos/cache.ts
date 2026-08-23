import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { ensurePrReviewExcluded } from '../review/contextPack.js'
import type { PrRef } from '../types.js'

const execFileAsync = promisify(execFile)

/** Strips embedded `user:pass@` credentials from any URL in a git error string before it
 * reaches run transcripts or thrown errors. Modern git already redacts credentials in most
 * "unable to access" fatal messages, but this is defense in depth against transports/error
 * paths that don't. */
export function redactCredentials(s: string): string {
  return s.replace(/:\/\/[^\s/@]+:[^\s/@]+@/g, '://***:***@')
}

async function git(cwd: string | undefined, label: string, args: string[]): Promise<void> {
  try {
    await execFileAsync('git', args, { cwd })
  } catch (err: any) {
    const raw = String(err.stderr ?? err.message)
    throw new Error(`git ${label} failed: ${redactCredentials(raw)}`)
  }
}

/** Serializes git-level work per base repo. Module-level because executeRun constructs a
 * fresh RepoCache per run — instance state would not be shared across concurrent runs. */
const repoLocks = new Map<string, Promise<void>>()

function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn)
  repoLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/** Startup companion to sweepStrandedRuns: delete every leftover per-run worktree dir and
 * prune stale registrations in each base repo, so crashed runs never leak directories. */
export function sweepStrandedWorktrees(root: string): void {
  rmSync(join(root, '.worktrees'), { recursive: true, force: true })
  for (const provider of ['bitbucket', 'github']) {
    const providerDir = join(root, provider)
    if (!existsSync(providerDir)) continue
    for (const ws of readdirSync(providerDir)) {
      const wsDir = join(providerDir, ws)
      for (const repo of readdirSync(wsDir)) {
        const repoDir = join(wsDir, repo)
        if (!existsSync(join(repoDir, '.git'))) continue
        try {
          execFileSync('git', ['worktree', 'prune'], { cwd: repoDir })
        } catch {
          // best-effort: a broken base repo must not stop server startup
        }
      }
    }
  }
}

export class RepoCache {
  constructor(private root: string) {}

  repoDir(pr: PrRef): string {
    return join(this.root, pr.provider, pr.workspace, pr.repo)
  }

  worktreeDir(pr: PrRef, runId: string): string {
    return join(this.root, '.worktrees', pr.provider, pr.workspace, pr.repo, runId)
  }

  /** Ensures the base clone (clone/fetch serialized per repo), then checks the commit out
   * into a per-run worktree. Returns the worktree path. */
  async ensureWorktree(
    pr: PrRef,
    opts: { cloneUrl: string; sourceBranch: string; commit: string; runId: string },
  ): Promise<string> {
    const base = this.repoDir(pr)
    const wt = this.worktreeDir(pr, opts.runId)
    return withRepoLock(base, async () => {
      if (!existsSync(join(base, '.git'))) {
        rmSync(base, { recursive: true, force: true })
        mkdirSync(join(this.root, pr.provider, pr.workspace), { recursive: true })
        await git(undefined, 'clone', ['clone', '--depth', '50', opts.cloneUrl, base])
      }
      ensurePrReviewExcluded(base)
      await git(base, 'fetch', ['fetch', '--depth', '50', 'origin', opts.sourceBranch])
      // A crashed run may have left the dir or a stale registration — clear both first.
      rmSync(wt, { recursive: true, force: true })
      await git(base, 'worktree prune', ['worktree', 'prune'])
      mkdirSync(join(this.root, '.worktrees', pr.provider, pr.workspace, pr.repo), { recursive: true })
      await git(base, 'worktree add', ['worktree', 'add', '--detach', wt, opts.commit])
      return wt
    })
  }

  /** Removes a run's worktree. --force because the machine-managed tree may hold the
   * untracked .pr-review pack; findings live in the run store. Never throws for a missing
   * worktree or base. */
  async removeWorktree(pr: PrRef, runId: string): Promise<void> {
    const base = this.repoDir(pr)
    const wt = this.worktreeDir(pr, runId)
    await withRepoLock(base, async () => {
      if (existsSync(join(base, '.git'))) {
        if (existsSync(wt)) await git(base, 'worktree remove', ['worktree', 'remove', '--force', wt])
        await git(base, 'worktree prune', ['worktree', 'prune'])
      } else {
        rmSync(wt, { recursive: true, force: true })
      }
    })
  }

  clear(pr: PrRef): void {
    const root = resolve(this.root)
    const dir = resolve(this.repoDir(pr))
    const rel = relative(root, dir)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Refusing to clear a path outside the cache root: ${dir}`)
    }
    rmSync(dir, { recursive: true, force: true })
    const wtDir = resolve(join(this.root, '.worktrees', pr.provider, pr.workspace, pr.repo))
    const wtRel = relative(root, wtDir)
    if (wtRel === '' || wtRel === '..' || wtRel.startsWith(`..${sep}`) || isAbsolute(wtRel)) {
      throw new Error(`Refusing to clear a path outside the cache root: ${wtDir}`)
    }
    rmSync(wtDir, { recursive: true, force: true })
  }
}
