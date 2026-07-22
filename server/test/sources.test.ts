import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseGithubRepo,
  findSkillRoot,
  addGithubSource,
  refreshGithubSource,
  type GitFn,
} from '../src/skills/sources.js'

describe('parseGithubRepo', () => {
  it('accepts owner/repo', () => {
    expect(parseGithubRepo('acme/skills')).toEqual({ owner: 'acme', repo: 'skills' })
  })

  it('accepts a full github URL', () => {
    expect(parseGithubRepo('https://github.com/acme/skills')).toEqual({ owner: 'acme', repo: 'skills' })
  })

  it('accepts a full github URL with .git suffix', () => {
    expect(parseGithubRepo('https://github.com/acme/skills.git')).toEqual({ owner: 'acme', repo: 'skills' })
  })

  it('trims whitespace and trailing slashes', () => {
    expect(parseGithubRepo('  https://github.com/acme/skills/  ')).toEqual({
      owner: 'acme',
      repo: 'skills',
    })
    expect(parseGithubRepo(' acme/skills/ ')).toEqual({ owner: 'acme', repo: 'skills' })
  })

  it('rejects a bare name with no slash', () => {
    expect(() => parseGithubRepo('skills')).toThrow(/^Invalid GitHub repo/)
  })

  it('rejects a non-github URL', () => {
    expect(() => parseGithubRepo('https://gitlab.com/acme/skills')).toThrow(/^Invalid GitHub repo/)
  })

  it('rejects a path with extra segments', () => {
    expect(() => parseGithubRepo('acme/skills/extra')).toThrow(/^Invalid GitHub repo/)
  })

  it('rejects an empty string', () => {
    expect(() => parseGithubRepo('   ')).toThrow(/^Invalid GitHub repo/)
  })
})

describe('findSkillRoot', () => {
  it('prefers a skills/ subdirectory when it contains skills', () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-clone-'))
    mkdirSync(join(root, 'skills', 'foo'), { recursive: true })
    writeFileSync(join(root, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\n')
    expect(findSkillRoot(root)).toBe(join(root, 'skills'))
  })

  it('falls back to the clone root when it directly qualifies', () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-clone-'))
    mkdirSync(join(root, 'foo'), { recursive: true })
    writeFileSync(join(root, 'foo', 'SKILL.md'), '---\nname: foo\n---\n')
    expect(findSkillRoot(root)).toBe(root)
  })

  it('throws when neither the root nor skills/ qualify', () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-clone-'))
    mkdirSync(join(root, 'not-a-skill'), { recursive: true })
    writeFileSync(join(root, 'not-a-skill', 'README.md'), 'nope')
    expect(() => findSkillRoot(root)).toThrow(/^No skills found/)
  })

  it('throws when the clone dir does not exist at all', () => {
    expect(() => findSkillRoot('/does/not/exist')).toThrow(/^No skills found/)
  })
})

describe('addGithubSource', () => {
  let reposDir: string
  let calls: string[][]
  let git: GitFn

  function materializeClone(dest: string): void {
    mkdirSync(join(dest, 'skills', 'foo'), { recursive: true })
    writeFileSync(join(dest, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: d\n---\n')
    mkdirSync(join(dest, 'skills', 'bar'), { recursive: true })
    writeFileSync(join(dest, 'skills', 'bar', 'SKILL.md'), '---\nname: bar\ndescription: d\n---\n')
    mkdirSync(join(dest, '.git'), { recursive: true })
  }

  beforeEach(() => {
    reposDir = join(mkdtempSync(join(tmpdir(), 'prr-repos-')), 'skill-repos')
    calls = []
    git = async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'clone') materializeClone(args[args.length - 1])
    }
  })

  it('clones shallowly into <reposDir>/<owner>__<repo> and returns the skill root + count', async () => {
    const result = await addGithubSource('acme/skills', { reposDir, git })
    const cloneDir = join(reposDir, 'acme__skills')
    expect(calls).toEqual([['clone', '--depth', '1', 'https://github.com/acme/skills.git', cloneDir]])
    expect(result.dir).toBe(join(cloneDir, 'skills'))
    expect(result.skillCount).toBe(2)
  })

  it('pulls instead of cloning when the dir already has a .git', async () => {
    const cloneDir = join(reposDir, 'acme__skills')
    materializeClone(cloneDir)
    const result = await addGithubSource('acme/skills', { reposDir, git })
    expect(calls).toEqual([['-C', cloneDir, 'pull']])
    expect(result.dir).toBe(join(cloneDir, 'skills'))
    expect(result.skillCount).toBe(2)
  })

  it('rejects an invalid repo before touching git', async () => {
    await expect(addGithubSource('not-a-repo', { reposDir, git })).rejects.toThrow(/^Invalid GitHub repo/)
    expect(calls).toEqual([])
  })

  it('surfaces a "No skills found" error when the clone has none', async () => {
    const emptyGit: GitFn = async (args) => {
      calls.push(args)
      if (args[0] === 'clone') mkdirSync(args[args.length - 1], { recursive: true })
    }
    await expect(addGithubSource('acme/empty', { reposDir, git: emptyGit })).rejects.toThrow(
      /^No skills found/,
    )
  })

  it('surfaces git failures', async () => {
    const failingGit: GitFn = async () => {
      throw new Error('git clone failed: fatal: repository not found')
    }
    await expect(addGithubSource('acme/skills', { reposDir, git: failingGit })).rejects.toThrow(
      /repository not found/,
    )
  })
})

describe('refreshGithubSource', () => {
  it('pulls the clone root and returns a refreshed skill count', async () => {
    const reposDir = join(mkdtempSync(join(tmpdir(), 'prr-repos-')), 'skill-repos')
    const cloneDir = join(reposDir, 'acme__skills')
    mkdirSync(join(cloneDir, 'skills', 'foo'), { recursive: true })
    writeFileSync(join(cloneDir, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\n')
    mkdirSync(join(cloneDir, '.git'), { recursive: true })
    const calls: string[][] = []
    const git: GitFn = async (args) => {
      calls.push(args)
      mkdirSync(join(cloneDir, 'skills', 'baz'), { recursive: true })
      writeFileSync(join(cloneDir, 'skills', 'baz', 'SKILL.md'), '---\nname: baz\n---\n')
    }
    const result = await refreshGithubSource(join(cloneDir, 'skills'), { reposDir, git })
    expect(calls).toEqual([['-C', cloneDir, 'pull']])
    expect(result.skillCount).toBe(2)
  })

  it('rejects a dir that is not under reposDir', async () => {
    const reposDir = join(mkdtempSync(join(tmpdir(), 'prr-repos-')), 'skill-repos')
    await expect(refreshGithubSource('/some/local/dir', { reposDir })).rejects.toThrow(
      /^Not a GitHub-backed/,
    )
  })

  it('rejects a dir under reposDir with no .git clone', async () => {
    const reposDir = join(mkdtempSync(join(tmpdir(), 'prr-repos-')), 'skill-repos')
    const dir = join(reposDir, 'not-a-clone')
    mkdirSync(dir, { recursive: true })
    await expect(refreshGithubSource(dir, { reposDir })).rejects.toThrow(/^Not a GitHub-backed/)
    expect(existsSync(dir)).toBe(true)
  })
})
