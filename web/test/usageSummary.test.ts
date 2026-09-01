import { describe, it, expect } from 'vitest'
import { summarizeUsage } from '../src/lib/usageSummary.js'
import type { RunRecord } from '../src/types.js'

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r',
  pr: { provider: 'bitbucket', workspace: 'w', repo: 'r', id: 1 },
  prTitle: 'T',
  skills: [],
  verify: true,
  status: 'completed',
  createdAt: '2026-09-01T00:00:00Z',
  findings: [],
  transcript: [],
  postedCommentIds: [],
  skillResults: [],
  ...overrides,
})

describe('summarizeUsage', () => {
  it('returns zeroed totals and no cost for an empty list', () => {
    const s = summarizeUsage([])
    expect(s).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: undefined,
      measuredRuns: 0,
      unmeasuredRuns: 0,
      byProfile: [],
    })
  })

  it('sums tokens and cost for a single fully-measured run', () => {
    const s = summarizeUsage([
      run({ reviewProfile: 'claude-sonnet', usage: { inputTokens: 500, outputTokens: 80, costUsd: 0.05 } }),
    ])
    expect(s.totalInputTokens).toBe(500)
    expect(s.totalOutputTokens).toBe(80)
    expect(s.totalCostUsd).toBe(0.05)
    expect(s.measuredRuns).toBe(1)
    expect(s.unmeasuredRuns).toBe(0)
  })

  it('counts a run with no usage as unmeasured, contributing nothing to the totals', () => {
    const s = summarizeUsage([
      run({ reviewProfile: 'codex-cli' }),
      run({ reviewProfile: 'claude-sonnet', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 } }),
    ])
    expect(s.totalInputTokens).toBe(100)
    expect(s.measuredRuns).toBe(1)
    expect(s.unmeasuredRuns).toBe(1)
  })

  it('keeps totalCostUsd undefined when no run in the set reported one', () => {
    const s = summarizeUsage([run({ reviewProfile: 'kimi', usage: { inputTokens: 200, outputTokens: 20 } })])
    expect(s.totalInputTokens).toBe(200)
    expect(s.totalCostUsd).toBeUndefined()
  })

  it('groups by reviewProfile, defaulting to "unknown" when absent', () => {
    const s = summarizeUsage([
      run({ reviewProfile: 'claude-sonnet', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 } }),
      run({ usage: { inputTokens: 50, outputTokens: 5 } }),
    ])
    expect(s.byProfile.map((p) => p.profile).sort()).toEqual(['claude-sonnet', 'unknown'])
  })

  it("sorts byProfile by run count descending, and a profile's costUsd stays undefined when it never reported one even though the overall total does", () => {
    const s = summarizeUsage([
      run({ reviewProfile: 'kimi', usage: { inputTokens: 100, outputTokens: 10 } }),
      run({ reviewProfile: 'kimi', usage: { inputTokens: 100, outputTokens: 10 } }),
      run({ reviewProfile: 'claude-sonnet', usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.02 } }),
    ])
    expect(s.byProfile.map((p) => p.profile)).toEqual(['kimi', 'claude-sonnet'])
    const kimi = s.byProfile.find((p) => p.profile === 'kimi')!
    expect(kimi.inputTokens).toBe(200)
    expect(kimi.costUsd).toBeUndefined()
    expect(s.totalCostUsd).toBe(0.02)
  })

  it('includes a profile whose runs never report usage, with a real run count and zero tokens', () => {
    const s = summarizeUsage([
      run({ reviewProfile: 'codex-cli' }),
      run({ reviewProfile: 'codex-cli' }),
      run({ reviewProfile: 'claude-sonnet', usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.02 } }),
    ])
    const codex = s.byProfile.find((p) => p.profile === 'codex-cli')
    expect(codex).toBeDefined()
    expect(codex!.runs).toBe(2)
    expect(codex!.inputTokens).toBe(0)
    expect(codex!.costUsd).toBeUndefined()
    expect(s.unmeasuredRuns).toBe(2)
  })
})
