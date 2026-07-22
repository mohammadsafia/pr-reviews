import { describe, it, expect } from 'vitest'
import { inferCategory, filterSkills } from '../src/lib/skills.js'
import type { SkillInfo } from '../src/types.js'

function skill(over: Partial<SkillInfo>): SkillInfo {
  return { name: 'x', description: '', dir: '/d/x', source: '/d', ...over }
}

describe('inferCategory', () => {
  it('prefers an explicit frontmatter category over the name prefix', () => {
    expect(inferCategory(skill({ name: 'create-thing', category: 'quality' }))).toBe('quality')
  })

  it('infers "create" from a create- prefix', () => {
    expect(inferCategory(skill({ name: 'create-component' }))).toBe('create')
  })

  it('infers "audit" from an audit- prefix', () => {
    expect(inferCategory(skill({ name: 'audit-a11y' }))).toBe('audit')
  })

  it('infers "review" from a review- prefix', () => {
    expect(inferCategory(skill({ name: 'review-code' }))).toBe('review')
  })

  it('infers "debug" from a debug- prefix', () => {
    expect(inferCategory(skill({ name: 'debug-build' }))).toBe('debug')
  })

  it('falls back to "other" for unrecognized prefixes', () => {
    expect(inferCategory(skill({ name: 'frontend-design' }))).toBe('other')
  })

  it('falls back to "other" when there is no prefix separator', () => {
    expect(inferCategory(skill({ name: 'skillname' }))).toBe('other')
  })

  it('strips a namespace prefix before inferring "audit"', () => {
    expect(inferCategory(skill({ name: 'forge:audit-a11y' }))).toBe('audit')
  })

  it('strips a namespace prefix before inferring "create"', () => {
    expect(inferCategory(skill({ name: 'forge:create-form' }))).toBe('create')
  })

  it('falls back to "other" for a namespaced name with no recognized prefix', () => {
    expect(inferCategory(skill({ name: 'forge:changelog' }))).toBe('other')
  })

  it('still infers "audit" for a plain (non-namespaced) name', () => {
    expect(inferCategory(skill({ name: 'audit-z' }))).toBe('audit')
  })
})

describe('filterSkills', () => {
  const skills: SkillInfo[] = [
    skill({ name: 'create-component', description: 'Build a reusable widget' }),
    skill({ name: 'audit-a11y', description: 'Check ARIA and keyboard nav' }),
    skill({ name: 'review-code', description: 'Review against standards' }),
  ]

  it('matches the query against the name case-insensitively', () => {
    expect(filterSkills(skills, 'CREATE', 'all').map((s) => s.name)).toEqual(['create-component'])
  })

  it('matches the query against the description case-insensitively', () => {
    expect(filterSkills(skills, 'aria', 'all').map((s) => s.name)).toEqual(['audit-a11y'])
  })

  it('passes everything when category is "all" and query is empty', () => {
    expect(filterSkills(skills, '', 'all')).toHaveLength(3)
  })

  it('filters by inferred category', () => {
    expect(filterSkills(skills, '', 'audit').map((s) => s.name)).toEqual(['audit-a11y'])
  })

  it('combines category and query filters', () => {
    expect(filterSkills(skills, 'standards', 'review').map((s) => s.name)).toEqual(['review-code'])
    expect(filterSkills(skills, 'standards', 'audit')).toEqual([])
  })
})
