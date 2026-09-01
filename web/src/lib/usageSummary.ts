import type { RunRecord } from '../types.js'

export interface ProfileUsage {
  profile: string
  inputTokens: number
  outputTokens: number
  costUsd?: number
  runs: number
}

export interface UsageSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd?: number
  measuredRuns: number
  unmeasuredRuns: number
  byProfile: ProfileUsage[]
}

/** Aggregates token/cost usage across a run history. A run with no `usage` field
 * contributes only to `unmeasuredRuns` — never a fabricated zero in the token/cost totals
 * — but it still counts toward its profile's `runs` tally in `byProfile`, so a profile
 * whose every run reports nothing (an all-CLI profile) still appears in the breakdown with
 * a real run count and zero tokens, instead of being invisible. `totalCostUsd` (and each
 * profile entry's `costUsd`) stays undefined unless at least one contributing run reported
 * one, so a profile whose adapter never reports cost shows its tokens without implying a
 * $0.00 cost. */
export function summarizeUsage(runs: RunRecord[]): UsageSummary {
  const byProfile = new Map<string, ProfileUsage>()
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostUsd: number | undefined
  let measuredRuns = 0
  let unmeasuredRuns = 0

  for (const run of runs) {
    const key = run.reviewProfile ?? 'unknown'
    const entry = byProfile.get(key) ?? { profile: key, inputTokens: 0, outputTokens: 0, runs: 0 }
    entry.runs += 1
    byProfile.set(key, entry)

    if (!run.usage) {
      unmeasuredRuns++
      continue
    }
    measuredRuns++
    const { inputTokens, outputTokens, costUsd } = run.usage
    totalInputTokens += inputTokens
    totalOutputTokens += outputTokens
    entry.inputTokens += inputTokens
    entry.outputTokens += outputTokens
    if (costUsd !== undefined) {
      totalCostUsd = (totalCostUsd ?? 0) + costUsd
      entry.costUsd = (entry.costUsd ?? 0) + costUsd
    }
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    measuredRuns,
    unmeasuredRuns,
    byProfile: [...byProfile.values()].sort((a, b) => b.runs - a.runs),
  }
}
