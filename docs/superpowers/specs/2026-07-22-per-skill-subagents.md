# Per-Skill Subagent Fan-Out — Design

**Date:** 2026-07-22 · Change to the review engine only. Builds on the v1 spec and UI revamp.

## Summary

Today a review run injects every selected skill into one agent prompt and runs a single agent session (`runReview` called once in `executeRun`). This change fans the run out: **each selected skill runs in its own subagent** (a separate Claude Agent SDK session against the same checkout), all launched **in parallel with no concurrency cap**, and the run **merges every subagent's findings**. A subagent that fails is recorded as a failed skill; the other skills' findings still render (**partial-failure tolerant**).

When no skills are selected, the run behaves as today: one general-review subagent (labelled `general`).

## Decisions (confirmed with user)

- **Parallel, unbounded** — every selected skill's subagent starts at once.
- **Partial-failure tolerant** — one subagent's git/agent/parse failure marks that skill failed and continues the others. The whole run is `failed` only if *every* subagent failed; otherwise `completed`.

## Server changes

### Types (`server/src/types.ts`)
- `RunEvent` gains an optional `skill?: string` so streamed events can be attributed to the subagent that produced them. Status events for the shared prep phase (checkout) carry no `skill`.
- New `SkillRunResult` and `RunRecord.skillResults`:
  ```ts
  export interface SkillRunResult {
    skill: string          // skill name, or "general" when no skills were selected
    status: 'completed' | 'failed'
    findingCount: number
    error?: string
  }
  // on RunRecord:
  skillResults: SkillRunResult[]
  ```
  Populated by `executeRun`. `RunStore.create` must initialize it to `[]` (like `findings`/`transcript`/`postedCommentIds`).

### `runReview` (`server/src/review/runner.ts`) — unchanged
It already runs exactly one agent session for the skills array it is given, with the reformat retry. It stays the single-subagent primitive; the fan-out calls it once per skill with a one-element `skills` array.

### `executeRun` (`server/src/app.ts`) — the fan-out
After the shared checkout + skill scan (unchanged), replace the single `runReview` call with:

1. Build the **review units**: for each selected skill present in the scan, `{ name, content }`; if the selection is empty, a single synthetic unit `{ name: 'general', content: '' }` → passed to `runReview` as `skills: []`.
2. Run all units concurrently via `Promise.all` over `units.map(...)` — no bounding. Each unit:
   - wraps `emit` so every event it produces carries `skill: unit.name`;
   - emits a `status` "Reviewing with skill: <name>…" at start;
   - calls `runReview({ meta, diff, skills: unit.name === 'general' ? [] : [{name,content}], focus, cwd, model }, wrappedEmit, agentQuery)`;
   - on success: force `finding.skill = unit.name` on every returned finding (guarantees correct attribution even if the model mislabels), returns `{ result: SkillRunResult(completed, count), findings }`;
   - on throw: emits an `error` event tagged with the skill, returns `{ result: SkillRunResult(failed, 0, err.message), findings: [] }` — it never rejects, so one failure can't reject the whole `Promise.all`.
3. After all settle: `run.findings` = concatenation of every unit's findings; `run.skillResults` = every unit's result. `run.status = 'completed'` unless **all** units failed, in which case `'failed'` with `run.error` = a summary (e.g. "All N skill reviews failed").
4. The existing `finally` (save + emit `done`) is unchanged.

Concurrency note: the run queue still serializes whole runs (one PR review at a time); the fan-out is *within* a single run, so the queue invariant is untouched.

### Tests
- `server/test/app.test.ts` / `server/test/runPipeline.test.ts`: with a mocked `agentQuery` that returns different findings per prompt, submit a run with two skills and assert `run.findings` contains findings from both, each `finding.skill` set correctly, and `run.skillResults` has two `completed` entries. Add a case where the mocked agent throws for one skill → that skill is `failed`, the other is `completed`, `run.status === 'completed'`, and only the surviving skill's findings appear. Add an all-fail case → `run.status === 'failed'`.

## Web changes

### Types (`web/src/types.ts`)
Mirror `RunEvent.skill?` and add `SkillRunResult` + `RunRecord.skillResults`.

### Run view (`web/src/pages/RunView.tsx`)
- **Skills summary**: above the findings, render a compact row of `skillResults` — one chip per skill showing name, a status dot (completed = success, failed = destructive), and finding count; failed skills show their error on hover/inline. Uses existing Badge/StatusBadge idioms.
- Findings report is unchanged (already grouped by severity; each `FindingCard` already shows `category · skill`).

### Review console (`web/src/components/ReviewConsole.tsx`)
- When an event carries `skill`, prefix its line with a dim `[<skill>]` tag so the interleaved parallel streams are readable. Events without `skill` (shared prep) render as today.

## Out of scope
Deduplicating findings across skills (two skills flagging the same line stay as two findings — each is attributed to its skill). No change to comment posting, SSE lifecycle, or the run queue.
