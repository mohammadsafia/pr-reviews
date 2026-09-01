# Cost Trends Design

**Date:** 2026-09-01
**Status:** Approved design, pending implementation plan

## Problem

A2 put a real token/cost number on each individual run, but nothing adds those numbers up.
There's no way to see total spend, or which model profile is actually driving cost, without
opening every run one at a time.

## Goals

1. Show total tokens and total cost across run history, and a breakdown by model profile
   (the one split that actually predicts cost — Claude-SDK profiles report `$`,
   OpenAI-compatible profiles report tokens only, CLI profiles report nothing).
2. Stay honest about coverage: never fabricate a total from runs that reported nothing;
   surface how many runs have no usage data instead of silently ignoring them.

Non-goals: a chart (nothing else in this app uses one — a text/badge summary stays
consistent with the established visual language); date-range filtering (all-time totals
for v1 — little else in this app has time-window controls); a new server endpoint (the
data needed is already in the `RunRecord[]` the Runs page fetches).

## Architecture overview

Pure client-side aggregation over data already fetched:

```
Runs.tsx (already has RunRecord[] via listRuns())
        │
  summarizeUsage(runs) ──► { totalInputTokens, totalOutputTokens, totalCostUsd?,
                              measuredRuns, unmeasuredRuns,
                              byProfile: [{ profile, inputTokens, outputTokens, costUsd?, runs }] }
        │
  summary bar + Collapsible per-profile breakdown
```

No server changes. Touched: new `web/src/lib/usageSummary.ts`, `web/src/pages/Runs.tsx`.

## Component 1 — `summarizeUsage`

```ts
export interface ProfileUsage {
  profile: string // run.reviewProfile, or 'unknown' when absent
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

export function summarizeUsage(runs: RunRecord[]): UsageSummary
```

Rules, matching A2's precedent exactly:

- A run with no `usage` field contributes to `unmeasuredRuns` only — never a fabricated
  zero folded into the totals.
- `totalCostUsd` stays `undefined` unless at least one run in the set reported a
  `costUsd`; when set, it's the sum of only the runs that reported one (a run with tokens
  but no cost — an OpenAI-compatible profile — contributes its tokens but not to the cost
  sum, same "partial is honest" rule `RunView`'s own per-run badge already follows).
- Grouping key is `run.reviewProfile ?? 'unknown'`. `byProfile` entries are sorted by
  `runs` descending (busiest profile first) — a stable, obvious-to-read order needing no
  further UI control.

## Component 2 — UI on `Runs.tsx`

Rendered once `runs !== null && runs.length > 0`, directly below the existing header row:

- A single summary line: `"<N> runs · <tokens> tokens · $<cost> · <M> without cost data"`
  (the cost segment and the "without cost data" segment are each omitted when their count
  is zero, so an all-CLI-profile history doesn't show a misleading "$0.00" or a redundant
  "0 without cost data").
- A `Collapsible` (the same primitive already used elsewhere in this app) trigger to expand
  the `byProfile` breakdown as a small table: profile name, run count, tokens, cost (or "—"
  when that profile never reported one).

## Error handling summary

| Case | Behavior |
|---|---|
| No runs yet | Summary bar doesn't render at all (matches the existing empty-state branch) |
| Every run lacks `usage` | `totalCostUsd` and token totals stay at their zero/undefined defaults; `unmeasuredRuns` equals the run count; summary line shows "0 tokens" and skips the cost segment entirely |
| Mixed measured/unmeasured runs | Totals reflect only measured runs; unmeasured count shown alongside, never hidden |
| A profile has tokens but never reports cost (OpenAI-compatible) | Its `byProfile` entry shows tokens with cost as "—", not $0.00 |

## Testing

`summarizeUsage`: empty list; a single fully-measured run; a mix of measured/unmeasured
runs; multiple profiles with different totals: `byProfile` sorted by run count; a profile
that reports tokens but never cost keeps `costUsd` undefined on its entry while other
profiles' costs still sum correctly into the overall total; a run with `reviewProfile`
absent groups under `'unknown'`.

`Runs.tsx`: no new unit tests — presentational, matching this project's convention.
Verified via typecheck + build + full test suite.
