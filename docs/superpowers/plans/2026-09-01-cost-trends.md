# Cost Trends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show total tokens/cost and a per-model-profile breakdown across run history on the Runs page, computed client-side from data already fetched — no server changes.

**Architecture:** A pure `summarizeUsage(runs)` function in a new `web/src/lib/usageSummary.ts`, rendered as a compact summary line + expandable per-profile table on `Runs.tsx`.

**Tech Stack:** TypeScript, Vitest, React. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-cost-trends-design.md`

## Global Constraints

- A run with no `usage` field contributes only to `unmeasuredRuns` — never a fabricated zero in the totals.
- `totalCostUsd` (and a `byProfile` entry's `costUsd`) stays `undefined` unless at least one contributing run reported one.
- No server changes, no new dependency.

---

### Task 1: `summarizeUsage` and the Runs page summary bar

**Files:**
- Create: `web/src/lib/usageSummary.ts`
- Test: `web/test/usageSummary.test.ts`
- Modify: `web/src/pages/Runs.tsx`

**Interfaces:**
- Produces:
  ```ts
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
  export function summarizeUsage(runs: RunRecord[]): UsageSummary
  ```

- [ ] **Step 1: Write the failing tests**

Create `web/test/usageSummary.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd web && npx vitest run test/usageSummary.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/usageSummary.js'`.

- [ ] **Step 3: Implement `usageSummary.ts`**

Create `web/src/lib/usageSummary.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run test/usageSummary.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Run the full web test suite and typecheck**

Run: `cd web && npm test && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 6: Render the summary bar on `Runs.tsx`**

In `web/src/pages/Runs.tsx`, add the import:

```ts
import { Collapsible } from '@/components/ui/collapsible'
import { summarizeUsage } from '@/lib/usageSummary'
```

Compute the summary and render it. Change:

```tsx
      {runs === null ? (
```

to (inserting the summary bar right before the existing conditional, after computing it
from `runs` when loaded):

```tsx
      {runs !== null && runs.length > 0 && <UsageSummaryBar runs={runs} />}

      {runs === null ? (
```

Add the `UsageSummaryBar` component above the `Runs` function:

```tsx
function UsageSummaryBar({ runs }: { runs: RunRecord[] }) {
  const s = summarizeUsage(runs)
  const parts = [
    `${runs.length} run${runs.length === 1 ? '' : 's'}`,
    `${(s.totalInputTokens + s.totalOutputTokens).toLocaleString()} tokens`,
  ]
  if (s.totalCostUsd !== undefined) parts.push(`$${s.totalCostUsd.toFixed(2)}`)
  if (s.unmeasuredRuns > 0) parts.push(`${s.unmeasuredRuns} without cost data`)

  return (
    <Collapsible>
      <Collapsible.Trigger className="text-muted-foreground hover:text-foreground text-sm">
        {parts.join(' · ')}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="border-border mt-2 flex flex-col gap-1 rounded-lg border p-3">
          {s.byProfile.map((p) => (
            <div key={p.profile} className="flex items-center justify-between text-sm">
              <span className="font-family-mono">{p.profile}</span>
              <span className="text-muted-foreground">
                {p.runs} run{p.runs === 1 ? '' : 's'} · {(p.inputTokens + p.outputTokens).toLocaleString()} tokens ·{' '}
                {p.costUsd !== undefined ? `$${p.costUsd.toFixed(2)}` : '—'}
              </span>
            </div>
          ))}
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}
```

- [ ] **Step 7: Run the full web test suite, typecheck, and build**

Run: `cd web && npm test && npm run build`
Expected: PASS, no errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/usageSummary.ts web/test/usageSummary.test.ts web/src/pages/Runs.tsx
git commit -m "feat(ui): cost/token summary and per-profile breakdown on the Runs page"
```
