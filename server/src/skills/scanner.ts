import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import type { SkillInfo } from '../types.js'

function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

/** Name filters shared by every recursive walk: skip dotdirs and node_modules at any depth. */
function isIgnoredDirName(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

/**
 * Recursively walks `dir`, invoking `onSkillDir(skillDir)` for every directory that directly
 * contains a SKILL.md. Does not descend into a directory once it has been identified as a
 * skill (a skill's own reference subdirs must not become phantom skills). Skips dotdirs and
 * node_modules at every level.
 */
function walkForSkillDirs(dir: string, onSkillDir: (skillDir: string) => void): void {
  if (!existsSync(dir)) return
  if (existsSync(join(dir, 'SKILL.md'))) {
    onSkillDir(dir)
    return
  }
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // Unreadable dir (permissions, race with deletion, etc.) — skip it rather than
    // aborting the whole scan.
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (isIgnoredDirName(entry.name)) continue
    walkForSkillDirs(join(dir, entry.name), onSkillDir)
  }
}

/** True if `dir` itself, or anything beneath it (skipping dotdirs/node_modules), has a SKILL.md. */
export function containsSkillMd(dir: string): boolean {
  let found = false
  walkForSkillDirs(dir, () => {
    found = true
  })
  return found
}

export function scanSkillDirs(dirs: string[]): SkillInfo[] {
  const skills: SkillInfo[] = []
  for (const root of dirs) {
    if (!existsSync(root)) continue
    walkForSkillDirs(root, (skillDir) => {
      const skillFile = join(skillDir, 'SKILL.md')
      const fm = parseFrontmatter(readFileSync(skillFile, 'utf8'))
      const skillName = basename(skillDir)
      skills.push({
        name: fm.name ?? skillName,
        description: fm.description ?? '',
        dir: skillDir,
        source: root,
        ...(fm.category ? { category: fm.category } : {}),
      })
    })
  }
  return skills
}

export function readSkillContent(skill: SkillInfo): string {
  return readFileSync(join(skill.dir, 'SKILL.md'), 'utf8')
}
