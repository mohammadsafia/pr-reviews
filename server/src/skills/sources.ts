import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { scanSkillDirs } from './scanner.js'

const execFileAsync = promisify(execFile)

export type GitFn = (args: string[], cwd?: string) => Promise<void>

async function defaultGit(args: string[], cwd?: string): Promise<void> {
  try {
    await execFileAsync('git', args, { cwd })
  } catch (err: any) {
    throw new Error(`git ${args[0]} failed: ${err.stderr ?? err.message}`)
  }
}

export function parseGithubRepo(input: string): { owner: string; repo: string } {
  const s = input.trim().replace(/\/+$/, '')
  if (!s) throw new Error(`Invalid GitHub repo: ${JSON.stringify(input)}`)

  const urlMatch = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(s)
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] }

  if (!s.includes('://') && !/github\.com/.test(s)) {
    const shortMatch = /^([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/.exec(s)
    if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] }
  }

  throw new Error(`Invalid GitHub repo: ${JSON.stringify(input)}`)
}

function hasSkillSubdirs(dir: string): boolean {
  if (!existsSync(dir)) return false
  return readdirSync(dir, { withFileTypes: true }).some(
    (e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')),
  )
}

/** Locates the directory whose immediate subdirectories are skills (contain SKILL.md). */
export function findSkillRoot(cloneDir: string): string {
  const skillsSub = join(cloneDir, 'skills')
  if (hasSkillSubdirs(skillsSub)) return skillsSub
  if (hasSkillSubdirs(cloneDir)) return cloneDir
  throw new Error(`No skills found in ${cloneDir}`)
}

export async function addGithubSource(
  input: string,
  opts: { reposDir: string; git?: GitFn },
): Promise<{ dir: string; skillCount: number }> {
  const { owner, repo } = parseGithubRepo(input)
  const git = opts.git ?? defaultGit
  const cloneDir = join(opts.reposDir, `${owner}__${repo}`)
  if (existsSync(join(cloneDir, '.git'))) {
    await git(['-C', cloneDir, 'pull'])
  } else {
    mkdirSync(opts.reposDir, { recursive: true })
    rmSync(cloneDir, { recursive: true, force: true })
    await git(['clone', '--depth', '1', `https://github.com/${owner}/${repo}.git`, cloneDir])
  }
  const root = findSkillRoot(cloneDir)
  return { dir: root, skillCount: scanSkillDirs([root]).length }
}

/** Resolves the top-level `<reposDir>/<owner>__<repo>` clone that `dir` lives under, if any. */
export function skillRepoCloneDir(dir: string, reposDir: string): string | undefined {
  const rel = relative(reposDir, dir)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  const first = rel.split(sep)[0]
  return first ? join(reposDir, first) : undefined
}

export async function refreshGithubSource(
  dir: string,
  opts: { reposDir: string; git?: GitFn },
): Promise<{ skillCount: number }> {
  const cloneDir = skillRepoCloneDir(dir, opts.reposDir)
  if (!cloneDir || !existsSync(join(cloneDir, '.git'))) {
    throw new Error(`Not a GitHub-backed skill source: ${dir}`)
  }
  const git = opts.git ?? defaultGit
  await git(['-C', cloneDir, 'pull'])
  return { skillCount: scanSkillDirs([dir]).length }
}
