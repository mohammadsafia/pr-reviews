import { describe, it, expect } from 'vitest'
import {
  applyPostResult,
  formatCommentBody,
  groupFindingsBySeverity,
  partitionFindingsByVerdict,
  postableIndexes,
  statusForIndex,
} from '../src/pages/RunView.js'
import type { Finding } from '../src/types.js'
import type { PostPreview } from '../src/api.js'

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

describe('formatCommentBody (compact template, mirrors server formatComment)', () => {
  const base: Finding = {
    file: 'a.ts',
    line: 3,
    severity: 'high',
    category: 'bug',
    summary: 'socket leaks on unmount',
    detail: 'Each remount opens a new connection.',
    suggestion: 'Return a cleanup from the effect.',
    example: '```tsx\n// before\n// after\n```',
    skills: ['react-hooks'],
    verdict: 'confirmed',
  }

  it('renders header, why, example, and fix', () => {
    expect(formatCommentBody(base)).toBe(
      '**🔴 High · bug** — socket leaks on unmount\n\n' +
        '**Why:** Each remount opens a new connection.\n\n' +
        base.example +
        '\n\n**Fix:** Return a cleanup from the effect.',
    )
  })

  it('omits example when empty/absent and fix when suggestion empty', () => {
    expect(formatCommentBody({ ...base, example: undefined })).not.toContain('```tsx')
    expect(formatCommentBody({ ...base, suggestion: '' })).not.toContain('**Fix:**')
  })

  it('maps each severity to its emoji', () => {
    expect(formatCommentBody({ ...base, severity: 'medium' })).toContain('🟠 Medium')
    expect(formatCommentBody({ ...base, severity: 'low' })).toContain('🟡 Low')
    expect(formatCommentBody({ ...base, severity: 'info' })).toContain('ℹ️ Info')
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

describe('statusForIndex', () => {
  it('returns the preview status for an index present in preview.statuses', () => {
    const preview: PostPreview = {
      statuses: [
        { index: 0, status: 'already-posted' },
        { index: 1, status: 'resolved' },
        { index: 2, status: 'new' },
      ],
      dedupeChecked: true,
    }
    expect(statusForIndex(preview, 0)).toBe('already-posted')
    expect(statusForIndex(preview, 1)).toBe('resolved')
    expect(statusForIndex(preview, 2)).toBe('new')
  })

  it('returns new when preview is null', () => {
    expect(statusForIndex(null, 5)).toBe('new')
  })

  it('returns new when the index is not present in preview.statuses (dedupeChecked:false fallback)', () => {
    const preview: PostPreview = { statuses: [], dedupeChecked: false }
    expect(statusForIndex(preview, 0)).toBe('new')
  })
})

describe('postableIndexes', () => {
  it('keeps only checked indexes whose preview status is new', () => {
    const preview: PostPreview = {
      statuses: [
        { index: 0, status: 'already-posted' },
        { index: 1, status: 'resolved' },
        { index: 2, status: 'new' },
      ],
      dedupeChecked: true,
    }
    expect(postableIndexes(new Set([0, 1, 2]), preview)).toEqual([2])
  })

  it('treats every checked index as postable when preview is null', () => {
    expect(postableIndexes(new Set([0, 1, 2]), null)).toEqual([0, 1, 2])
  })

  it('treats every checked index as postable when dedupeChecked is false with empty statuses', () => {
    const preview: PostPreview = { statuses: [], dedupeChecked: false }
    expect(postableIndexes(new Set([0, 1, 2]), preview)).toEqual([0, 1, 2])
  })
})
