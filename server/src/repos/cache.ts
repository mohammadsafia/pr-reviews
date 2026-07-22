import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { PrRef } from '../types.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string | undefined, label: string, args: string[]): Promise<void> {
  try {
    await execFileAsync('git', args, { cwd })
  } catch (err: any) {
    throw new Error(`git ${label} failed: ${err.stderr ?? err.message}`)
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
