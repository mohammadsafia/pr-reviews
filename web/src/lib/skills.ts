import type { SkillInfo } from '../types.js'

const PREFIX_CATEGORIES = new Set(['create', 'audit', 'review', 'debug'])

export function inferCategory(skill: SkillInfo): string {
  if (skill.category) return skill.category
  const unnamespaced = skill.name.slice(skill.name.lastIndexOf(':') + 1)
  const prefix = unnamespaced.split('-')[0]
  return PREFIX_CATEGORIES.has(prefix) ? prefix : 'other'
}

export function filterSkills(skills: SkillInfo[], query: string, category: string): SkillInfo[] {
  const q = query.trim().toLowerCase()
  return skills.filter((s) => {
    if (category !== 'all' && inferCategory(s) !== category) return false
    if (!q) return true
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  })
}

/** Mirrors the server's `join(dirname(cacheDir), 'skill-repos')` — the root GitHub clones live under. */
export function skillReposDir(cacheDir: string): string {
  const trimmed = cacheDir.replace(/\/+$/, '')
  const parent = trimmed.slice(0, trimmed.lastIndexOf('/')) || '/'
  return `${parent}/skill-repos`
}

/** True when `dir` is a skill source cloned from GitHub (lives under the skill-repos dir). */
export function isSkillRepoDir(dir: string, cacheDir: string): boolean {
  const reposDir = skillReposDir(cacheDir)
  return dir === reposDir || dir.startsWith(`${reposDir}/`)
}
