import { describe, it, expect } from 'vitest'
import { dedupeFindings } from '../src/review/dedup.js'
import type { Finding } from '../src/types.js'

const f = (o: Partial<Finding>): Finding => ({
  file: 'a.ts', line: 10, severity: 'low', category: 'bug',
  summary: 's', detail: 'd', suggestion: 'x', skills: ['s1'],
  verdict: 'confirmed', ...o,
})

describe('dedupeFindings', () => {
  it('merges same file+line+category: max severity, union skills, longest detail/suggestion', () => {
    const out = dedupeFindings([
      f({ skills: ['review-code'], severity: 'low', detail: 'short', suggestion: 'a' }),
      f({ skills: ['audit-a11y'], severity: 'high', detail: 'a much longer detail', suggestion: 'bb' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].severity).toBe('high')
    expect(out[0].skills).toEqual(['review-code', 'audit-a11y'])
    expect(out[0].detail).toBe('a much longer detail')
    expect(out[0].suggestion).toBe('bb')
  })

  it('does NOT merge different category on the same line', () => {
    const out = dedupeFindings([f({ category: 'bug' }), f({ category: 'style' })])
    expect(out).toHaveLength(2)
  })

  it('does NOT merge different lines', () => {
    const out = dedupeFindings([f({ line: 10 }), f({ line: 11 })])
    expect(out).toHaveLength(2)
  })

  it('preserves first-seen group order and dedupes repeated skills', () => {
    const out = dedupeFindings([
      f({ file: 'z.ts', skills: ['s1'] }),
      f({ file: 'a.ts', skills: ['s2'] }),
      f({ file: 'z.ts', skills: ['s1'] }),
    ])
    expect(out.map((x) => x.file)).toEqual(['z.ts', 'a.ts'])
    expect(out[0].skills).toEqual(['s1'])
  })
})
