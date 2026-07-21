import { describe, it, expect } from 'vitest'
import { groupFindingsBySeverity } from '../src/pages/RunView.js'
import type { Finding } from '../src/types.js'

const f = (severity: Finding['severity'], file: string): Finding => ({
  file,
  line: 1,
  severity,
  category: 'bug',
  summary: 's',
  detail: 'd',
  suggestion: 'x',
  skill: 'review-code',
})

describe('groupFindingsBySeverity', () => {
  it('orders high→info, keeps original indexes, omits empty groups', () => {
    const groups = groupFindingsBySeverity([f('low', 'a'), f('high', 'b'), f('low', 'c')])
    expect(groups.map((g) => g.severity)).toEqual(['high', 'low'])
    expect(groups[0].items[0].index).toBe(1)
    expect(groups[1].items.map((i) => i.index)).toEqual([0, 2])
  })
})
