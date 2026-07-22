import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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

export function scanSkillDirs(dirs: string[]): SkillInfo[] {
  const skills: SkillInfo[] = []
  for (const root of dirs) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillDir = join(root, entry.name)
      const skillFile = join(skillDir, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const fm = parseFrontmatter(readFileSync(skillFile, 'utf8'))
      skills.push({
        name: fm.name ?? entry.name,
        description: fm.description ?? '',
        dir: skillDir,
        source: root,
        ...(fm.category ? { category: fm.category } : {}),
      })
    }
  }
  return skills
}

export function readSkillContent(skill: SkillInfo): string {
  return readFileSync(join(skill.dir, 'SKILL.md'), 'utf8')
}
