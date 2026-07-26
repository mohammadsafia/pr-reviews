import { describe, it, expect } from 'vitest'
import { applyPostResult, formatCommentBody, groupFindingsBySeverity } from '../src/pages/RunView.js'
import type { Finding } from '../src/types.js'

const f = (severity: Finding['severity'], file: string): Finding => ({
  file,
  line: 1,
  severity,
  category: 'bug',
  summary: 's',
  detail: 'd',
  suggestion: 'x',
  skills: ['review-code'],
  verdict: 'confirmed',
})

describe('groupFindingsBySeverity', () => {
  it('orders high→info, keeps original indexes, omits empty groups', () => {
    const groups = groupFindingsBySeverity([f('low', 'a'), f('high', 'b'), f('low', 'c')])
    expect(groups.map((g) => g.severity)).toEqual(['high', 'low'])
    expect(groups[0].items[0].index).toBe(1)
    expect(groups[1].items.map((i) => i.index)).toEqual([0, 2])
  })
})

describe('formatCommentBody', () => {
  it('renders the exact body the server posts, so the confirm dialog matches reality', () => {
    const finding: Finding = {
      file: 'a.ts',
      line: 12,
      severity: 'high',
      category: 'security',
      summary: 'SQL injection',
      detail: 'User input is concatenated into the query string.',
      suggestion: 'Use parameterized queries.',
      skills: ['review-code'],
      verdict: 'confirmed',
    }
    expect(formatCommentBody(finding)).toBe(
      '**[AI review — high/security]** SQL injection\n\n' +
        'User input is concatenated into the query string.\n\n' +
        '**Suggestion:** Use parameterized queries.',
    )
  })
})

describe('applyPostResult', () => {
  it('clears only the successfully-posted finding indexes from checked, keeping unattempted/failed ones checked', () => {
    const sentIndexes = [0, 1, 2]
    const checked = new Set([0, 1, 2])
    const result = { posted: [111], failed: [{ index: 1, error: 'bitbucket down' }] }
    const { message, remainingChecked } = applyPostResult(sentIndexes, result, checked)
    expect(remainingChecked).toEqual(new Set([1, 2]))
    expect(message).toContain('Posted 1 comment')
    expect(message).toContain('bitbucket down')
  })

  it('reports a clean success with no failures and clears all checked', () => {
    const sentIndexes = [0, 1]
    const checked = new Set([0, 1])
    const result = { posted: [111, 222], failed: [] as { index: number; error: string }[] }
    const { message, remainingChecked } = applyPostResult(sentIndexes, result, checked)
    expect(remainingChecked).toEqual(new Set())
    expect(message).toBe('Posted 2 comments.')
  })
})
