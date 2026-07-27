import { describe, it, expect } from 'vitest'
import {
  applyPostResult,
  formatCommentBody,
  groupFindingsBySeverity,
  partitionFindingsByVerdict,
} from '../src/pages/RunView.js'
import type { Finding } from '../src/types.js'

const f = (severity: Finding['severity'], file: string, verdict: Finding['verdict'] = 'confirmed'): Finding => ({
  file,
  line: 1,
  severity,
  category: 'bug',
  summary: 's',
  detail: 'd',
  suggestion: 'x',
  skills: ['review-code'],
  verdict,
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
      '**[AI review — high/security · review-code]** SQL injection\n\n' +
        'User input is concatenated into the query string.\n\n' +
        '**Suggestion:** Use parameterized queries.',
    )
  })
})

describe('partitionFindingsByVerdict', () => {
  it('puts every confirmed finding ahead of every unverified one, regardless of severity, keeping real indexes', () => {
    // index: 0=high/unverified, 1=medium/confirmed, 2=low/confirmed, 3=high/confirmed
    const findings = [
      f('high', 'a', 'unverified'),
      f('medium', 'b', 'confirmed'),
      f('low', 'c', 'confirmed'),
      f('high', 'd', 'confirmed'),
    ]
    const { confirmed, unverified } = partitionFindingsByVerdict(findings)
    expect(confirmed.map((x) => x.index)).toEqual([1, 2, 3])
    expect(unverified.map((x) => x.index)).toEqual([0])
    expect(confirmed.every((x) => x.finding.verdict === 'confirmed')).toBe(true)
    expect(unverified.every((x) => x.finding.verdict === 'unverified')).toBe(true)
  })
})

describe('applyPostResult', () => {
  it('clears only the successfully-posted finding indexes from checked, keeping unattempted/failed ones checked', () => {
    const sentIndexes = [0, 1, 2]
    const checked = new Set([0, 1, 2])
    const result = {
      posted: [111],
      skipped: [] as { index: number; reason: 'already-posted' | 'resolved' }[],
      failed: [{ index: 1, error: 'bitbucket down' }],
      dedupeChecked: true,
    }
    const { message, remainingChecked } = applyPostResult(sentIndexes, result, checked)
    expect(remainingChecked).toEqual(new Set([1, 2]))
    expect(message).toContain('Posted 1 comment')
    expect(message).toContain('bitbucket down')
  })

  it('reports a clean success with no failures and clears all checked', () => {
    const sentIndexes = [0, 1]
    const checked = new Set([0, 1])
    const result = {
      posted: [111, 222],
      skipped: [] as { index: number; reason: 'already-posted' | 'resolved' }[],
      failed: [] as { index: number; error: string }[],
      dedupeChecked: true,
    }
    const { message, remainingChecked } = applyPostResult(sentIndexes, result, checked)
    expect(remainingChecked).toEqual(new Set())
    expect(message).toBe('Posted 2 comments.')
  })

  it('reports skipped counts alongside posted', () => {
    const { message } = applyPostResult(
      [0, 1, 2],
      {
        posted: [11],
        skipped: [
          { index: 1, reason: 'already-posted' },
          { index: 2, reason: 'resolved' },
        ],
        failed: [],
        dedupeChecked: true,
      },
      new Set([0, 1, 2]),
    )
    expect(message).toMatch(/Posted 1/)
    expect(message).toMatch(/skipped 2/i)
    expect(message).toMatch(/already posted/i)
    expect(message).toMatch(/resolved/i)
  })

  it('does not misattribute success by positional slice when a skip falls before a real post (preview-vs-post race)', () => {
    // Server processes sentIndexes in order: index 0 is skipped (already posted by someone
    // else between preview and post), index 1 is actually posted. A naive
    // sentIndexes.slice(0, posted.length) would wrongly treat index 0 as the "succeeded" one.
    const sentIndexes = [0, 1]
    const checked = new Set([0, 1])
    const result = {
      posted: [99],
      skipped: [{ index: 0, reason: 'already-posted' as const }],
      failed: [] as { index: number; error: string }[],
      dedupeChecked: true,
    }
    const { remainingChecked } = applyPostResult(sentIndexes, result, checked)
    // Both indexes should be cleared: 0 because it's skipped (already exists on the PR), 1
    // because it actually succeeded — but NOT via the wrong attribution.
    expect(remainingChecked).toEqual(new Set())
  })
})
