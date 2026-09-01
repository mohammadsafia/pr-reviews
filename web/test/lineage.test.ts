import { describe, it, expect } from 'vitest'
import { diffFindings, scopeToRetriedSkills } from '../src/lib/lineage.js'
import type { Finding } from '../src/types.js'

const f = (overrides: Partial<Finding> = {}): Finding => ({
  file: 'a.ts',
  line: 1,
  severity: 'low',
  category: 'style',
  summary: 'summary',
  detail: 'd',
  suggestion: 'x',
  skills: ['sec'],
  verdict: 'confirmed',
  ...overrides,
})

describe('diffFindings', () => {
  it('classifies a finding present in both as still open', () => {
    const parent = [f({ summary: 'Same issue' })]
    const child = [f({ summary: 'Same issue' })]
    const delta = diffFindings(parent, child)
    expect(delta.stillOpen).toHaveLength(1)
    expect(delta.newFindings).toHaveLength(0)
    expect(delta.resolved).toHaveLength(0)
  })

  it('classifies a finding only in the child as new', () => {
    const parent: Finding[] = []
    const child = [f({ summary: 'Fresh issue' })]
    const delta = diffFindings(parent, child)
    expect(delta.newFindings).toEqual(child)
    expect(delta.stillOpen).toHaveLength(0)
    expect(delta.resolved).toHaveLength(0)
  })

  it('classifies a finding only in the parent as resolved', () => {
    const parent = [f({ summary: 'Fixed now' })]
    const child: Finding[] = []
    const delta = diffFindings(parent, child)
    expect(delta.resolved).toEqual(parent)
    expect(delta.newFindings).toHaveLength(0)
    expect(delta.stillOpen).toHaveLength(0)
  })

  it('matches on file + category + normalized summary, ignoring case and extra whitespace', () => {
    const parent = [f({ file: 'a.ts', category: 'bug', summary: '  Null   check  missing ' })]
    const child = [f({ file: 'a.ts', category: 'bug', summary: 'null check missing' })]
    const delta = diffFindings(parent, child)
    expect(delta.stillOpen).toHaveLength(1)
  })

  it('treats a different file or category as a different finding, even with the same summary', () => {
    const parent = [f({ file: 'a.ts', category: 'bug', summary: 'Same text' })]
    const child = [f({ file: 'b.ts', category: 'bug', summary: 'Same text' })]
    const delta = diffFindings(parent, child)
    expect(delta.newFindings).toHaveLength(1)
    expect(delta.resolved).toHaveLength(1)
  })
})

describe('scopeToRetriedSkills', () => {
  it('keeps a parent finding whose skills overlap the retried set', () => {
    const parent = [f({ skills: ['sec', 'perf'] })]
    expect(scopeToRetriedSkills(parent, ['perf'])).toEqual(parent)
  })

  it('drops a parent finding whose skills do not overlap the retried set', () => {
    const parent = [f({ skills: ['perf'] })]
    expect(scopeToRetriedSkills(parent, ['sec'])).toEqual([])
  })

  it('is a no-op when the child retried every skill the parent finding has', () => {
    const parent = [f({ skills: ['sec'] }), f({ skills: ['perf'], file: 'b.ts' })]
    expect(scopeToRetriedSkills(parent, ['sec', 'perf'])).toEqual(parent)
  })
})
