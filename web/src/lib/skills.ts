import type { SkillInfo } from '../types.js'

const PREFIX_CATEGORIES = new Set(['create', 'audit', 'review', 'debug'])

export function inferCategory(skill: SkillInfo): string {
  if (skill.category) return skill.category
  const prefix = skill.name.split('-')[0]
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
