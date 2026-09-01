# Run Lineage & Cost Tracking Design

**Date:** 2026-09-01
**Status:** Approved design, pending implementation plan

## Problem

Two related gaps in how a run relates to cost and to its own history:

1. **Depth/model choice is a guess.** `NewReview.tsx` sells Thorough/Balanced/Economy on
   qualitative hint text only ("highest cost", "roughly a third of the cost") — no run has
   ever shown an actual number for what it spent.
2. **Runs have no memory of each other.** `RunView.tsx`'s `retry()`/`retryFailedSkills()`
   always create a brand-new, unlinked `RunRecord`. Re-review the same PR after pushing
   fixes and you get two islands — nothing shows which of the previous findings are gone,
   which are new, and which are still open.

Both changes add a small field to `RunRecord` and nothing else about run storage — bundled
into one design so they share that one schema touch instead of two.

## Goals

1. Show real token/cost totals on a run, sourced from whatever each model adapter actually
   reports — not a guess, and not a fabricated number for adapters that report nothing.
2. Link a run created via "Retry run" / "Retry failed skills" back to the run it came from,
   and show what changed: new findings, resolved findings, still-open findings.
3. Both degrade to "not shown" cleanly — an old run, a CLI-only run, a run with no parent —
   never a crash, never a misleading number.

Non-goals: a dollar cost for OpenAI-compatible profiles (needs a maintained per-model price
table — out of scope); scraping CLI stdout for usage figures (unreliable, CLI-specific);
auto-linking runs by PR identity outside the explicit retry buttons (see the brainstorm:
explicit retry is the whole signal, kept deliberately unambiguous); a full side-by-side
diff view (a summary line + badges is enough).

## Architecture overview

Both features ride the same two structures already threading through every run:

```
adapter (claude/openai/cli) ──► AgentMessage{result, usage?} ──► runOnce/runVerifyTurn
                                                                        │
                                                          emit({kind:'usage', ...})
                                                                        │
                                                    app.ts's central emit() accumulates
                                                                        │
                                                          RunRecord.usage persisted
```

```
RunView "Retry run" ──► createRun({ ..., parentRunId: run.id })
                                                                        │
                                                    RunRecord.parentRunId persisted verbatim
                                                                        │
                                    RunView (child) fetches parent via existing getRun(),
                                    diffs client-side, renders summary + badges
```

Untouched: providers, repo cache, dedupe, fingerprinting/posting, the run queue. Touched:
`models/{claude,openai,cli}.ts`, `review/runner.ts`, `review/verify.ts`, `app.ts`,
`types.ts` (server + web), `RunView.tsx`, new `web/src/lib/lineage.ts`.

## Component 1 — Usage on the adapter/event contract

`AgentMessage`'s `result` variant (`runner.ts`) gains:

```ts
usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
```

- **`claude.ts`**: reads `msg.usage.input_tokens` / `msg.usage.output_tokens` /
  `msg.total_cost_usd` off the SDK's result message. Both the `success` and error result
  subtypes carry these fields — a failed session still spent real tokens, so usage is
  extracted regardless of `ok`.
- **`openai.ts`**: the adapter already loops internally (up to `MAX_ITERATIONS` chat-
  completions calls per session). It accumulates `prompt_tokens`/`completion_tokens` from
  `data.usage` across every successfully-parsed response and attaches the running total to
  whichever `result` it eventually yields — the normal completion, the iteration-ceiling
  fallback, or a mid-loop failure. No `costUsd` — OpenAI-compatible responses don't carry a
  dollar figure, and computing one would need a maintained per-model price table.
- **`cli.ts`**: never sets `usage`. A spawned CLI's stdout is opaque text; there is nothing
  structured to extract.

`RunEvent.kind` gains `'usage'`; `RunEvent` gains the same three optional fields
(`inputTokens?`, `outputTokens?`, `costUsd?`), plus `text` set to a short human-readable
line (e.g. `"12,400 tokens"` or `"12,400 tokens · $0.08"`) so the existing Console-tab
event rendering displays it with no special-casing.

`runner.ts`'s `runOnce` and `verify.ts`'s `runVerifyTurn` (already near-identical
turn-loops — a pre-existing overlap this design doesn't force a merge of, since their
error-wrapping intentionally differs: `runOnce` prefixes `"Agent run failed: "`,
`runVerifyTurn` doesn't) each gain the same handful of lines: after the loop produces its
final result, if it carries `usage`, call `onEvent({ kind: 'usage', ... })` before
returning. Both the initial review call and a reformat retry go through `runOnce`, so a
retry's usage is naturally included; both verify chunks and a verify reformat retry go
through `runVerifyTurn`, same effect.

## Component 2 — Run-level accumulation

`RunRecord` gains:

```ts
usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
```

`app.ts`'s central `emit()` (the one function every event already flows through —
`transcript.push`, `store.save`, `events.emit`) accumulates on `kind: 'usage'`:

```ts
if (e.kind === 'usage') {
  run!.usage ??= { inputTokens: 0, outputTokens: 0 }
  run!.usage.inputTokens += e.inputTokens ?? 0
  run!.usage.outputTokens += e.outputTokens ?? 0
  if (e.costUsd !== undefined) run!.usage.costUsd = (run!.usage.costUsd ?? 0) + e.costUsd
}
```

`run.usage` stays entirely absent for a run whose every session came from `cli` adapters
(no usage event ever fired) — the UI shows "cost tracking not available" rather than a
fabricated zero. `costUsd` specifically stays absent until at least one claude-sourced
event supplies one; a run mixing a CLI review with a Claude-SDK verify pass ends up with
token counts but a partial/absent cost, which is the honest answer, not a misleading one.

Skill attribution is free: usage events emitted from inside `runOnce`/`runVerifyTurn` pass
through the same `wrappedEmit`/verify `emit` wrappers that already stamp every other event
with `skill`, so a future per-skill cost breakdown has the data without further plumbing.

## Component 3 — Run lineage

`RunRecord` gains:

```ts
parentRunId?: string
```

`POST /api/runs` accepts `parentRunId` in the body and stores it verbatim on the created
run — no existence validation. A stale or missing parent is indistinguishable from no
parent at all: the lineage UI just finds nothing and renders nothing.

`RunView.tsx`'s `retry()` and `retryFailedSkills()` both pass `parentRunId: run.id`
alongside their existing `createRun` fields.

Comparison lives entirely client-side, since `parentRunId` already rides along on the
`RunRecord` the existing `GET /api/runs/:id` returns in full — no new endpoint. When
`RunView` loads a run with a `parentRunId`, it fetches the parent with the same `getRun()`
already in use, and diffs with a new `web/src/lib/lineage.ts`:

```ts
export interface FindingDelta {
  newFindings: Finding[]
  stillOpen: Finding[]
  resolved: Finding[]
}

export function diffFindings(parent: Finding[], child: Finding[]): FindingDelta
```

Matching uses the **same identity rule `review/fingerprint.ts` already uses server-side**
for comment idempotency — `file` + `category` + normalized `summary` — but as a plain
composite string key, not a SHA-256 digest: the client only needs Set membership, not a
value to embed in a posted comment. Reusing the rule (not the server-only crypto-backed
function) keeps "still open" / "new" / "resolved" meaning exactly what it already means
elsewhere in the app.

**Retry-failed-skills correctness rule.** "Retry failed skills" re-runs only a subset of
skills, so the child run's `findings` only ever contains findings from that subset.
Diffing it against the *full* parent would wrongly mark every untouched skill's findings
as "resolved" — they were never re-evaluated, just not part of this retry. Fix: before
diffing, filter the parent's findings down to those whose `skills` array overlaps the
child run's `skills` list. A full retry keeps the same skills as its parent, so this
filter is a no-op there; a partial retry correctly scopes the comparison to only what was
actually re-run. One rule, no need to know which retry button was pressed.

UI: when the parent resolves, a compact summary line above the findings list ("2 new · 3
resolved · 5 still open"). New findings get a small "new" badge on their `FindingCard`
(same visual language as the existing "unverified" badge). Resolved findings only exist in
the *parent's* data — they render in a separate collapsed "Resolved since last run"
section (the existing `Collapsible` primitive) as lightweight read-only rows (file:line +
summary only) rather than stretching `FindingCard` to support a non-actionable mode it
wasn't designed for.

## Error handling summary

| Case | Behavior |
|---|---|
| Run has only CLI-adapter sessions | `RunRecord.usage` absent; UI shows "not available" |
| Run mixes CLI and Claude sessions | Token counts present, `costUsd` reflects only the measured sessions |
| `parentRunId` absent | No lineage UI, no fetch attempted |
| `parentRunId` set but parent fetch fails (deleted/404) | No lineage UI; rest of the page renders normally |
| "Retry failed skills" child compared to parent | Parent findings filtered to overlapping skills before diffing |
| Old run recorded before either field existed | Both fields absent; renders exactly as today |

## Testing

Pure functions, extending the existing fake-`AgentQuery` harness in `runPipeline.test.ts`:

- `claudeQuery`/`openaiQuery`: usage extracted from a success result, an error result
  (claude), and an accumulated multi-iteration loop (openai); `cliQuery` never sets usage.
- `runOnce`/`runVerifyTurn`: a `usage`-carrying result yields a `kind: 'usage'` event with
  the right numbers; a reformat retry's usage is included, not dropped.
- `app.ts` `emit()` accumulation: sequential usage events sum correctly; `costUsd` stays
  absent until a claude-sourced event arrives; a run with zero usage events leaves
  `run.usage` absent.
- `diffFindings`: disjoint sets, overlapping sets, empty parent, empty child, the
  skill-overlap filter isolated as its own case (a parent finding whose skill wasn't in
  the child's retried set is excluded from the diff entirely, not counted as resolved).
- `app.ts` integration: a retry run's `parentRunId` is persisted and returned by
  `GET /api/runs/:id`.
