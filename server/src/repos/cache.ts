import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
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

export class RepoCache {
  constructor(private root: string) {}

  repoDir(pr: PrRef): string {
    return join(this.root, pr.workspace, pr.repo)
  }

  async ensureCheckout(
    pr: PrRef,
    opts: { cloneUrl: string; sourceBranch: string; commit: string },
  ): Promise<string> {
    const dir = this.repoDir(pr)
    if (!existsSync(join(dir, '.git'))) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(join(this.root, pr.workspace), { recursive: true })
      await git(undefined, 'clone', ['clone', '--depth', '50', opts.cloneUrl, dir])
    }
    await git(dir, 'fetch', ['fetch', '--depth', '50', 'origin', opts.sourceBranch])
    await git(dir, 'checkout', ['checkout', '--detach', '-f', opts.commit])
    return dir
  }

  clear(pr: PrRef): void {
    const root = resolve(this.root)
    const dir = resolve(this.repoDir(pr))
    const rel = relative(root, dir)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Refusing to clear a path outside the cache root: ${dir}`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
}
