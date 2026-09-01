# Inline Diff Context Design

**Date:** 2026-09-01
**Status:** Approved design, pending implementation plan

## Problem

A finding shows `file:line`, prose, and (when present) a short before/after `example`
snippet the model wrote — but never the real surrounding code. Seeing what's actually at
that line means leaving the tool and opening the PR in another tab.

The obvious fix — read `.pr-review/diff.patch` when the finding renders — doesn't work:
that file lives inside a disposable git worktree (`RepoCache`) that's removed in
`executeRun`'s `finally` block the moment the run finishes. By the time `RunView` is open
in a browser, the diff that produced the run's findings no longer exists on disk anywhere.
The diff was fetched into memory (`ctx.diff`) for that one run and discarded.

## Goals

1. Show real surrounding code on a finding, sourced from the exact diff the agent
   reviewed — not a live re-fetch, which could disagree with old findings if the PR has
   moved since.
2. Keep the storage cost small: a few lines per finding, not a full diff per run.
3. Degrade gracefully for findings where context can't be resolved, and for runs recorded
   before this feature existed.

Non-goals: showing context for lines outside the diff, syntax highlighting, editable
inline code.

## Architecture overview

`ctx.diff` is still in scope in `app.ts`'s `executeRun` after findings are finalized —
storage timing isn't the constraint, extraction timing is. A new pure module parses that
diff once per finding and attaches a small snippet directly to the `Finding` record before
it's persisted:

```
runReview() → findings ──► sort ──► for each finding:
                                       finding.context = extractDiffContext(ctx.diff, finding.file, finding.line)
                                    ──► run.findings = findings ──► store.save(run)
```

No change to the run lifecycle, the worktree, or the context pack. Touched:
`review/diffContext.ts` (new), `app.ts` (one insertion point), `types.ts` (server + web),
`FindingCard.tsx`.

## Component 1 — Diff context extraction

`server/src/review/diffContext.ts`:

```ts
export interface DiffContextLine {
  type: 'context' | 'add' | 'remove'
  text: string
  newLine?: number // set for context/add lines
  oldLine?: number // set for context/remove lines
}

export function extractDiffContext(
  diff: string,
  file: string,
  line: number,
  radius = 3,
): DiffContextLine[] | undefined
```

Reuses the same `diff --git a/X b/Y` file-splitting `parseDiffStats` already relies on
(the `b/` path wins on renames, matching existing behavior). Within the target file's
section, walks each `@@ -oldStart,oldLines +newStart,newLines @@` hunk, tracking old/new
line counters per the unified diff format: context lines (` `) and additions (`+`)
increment `newLine`; context lines and removals (`-`) increment `oldLine`.

Findings are reported against the PR's resulting code (the same numbering used for posted
inline comments), so the lookup matches on **`newLine`**. Once the target line is found:

- Returned lines are **clamped to the hunk the match falls in — never extended into a
  different hunk**, even if `radius` would otherwise reach past its edge. Two hunks in the
  same file diff aren't necessarily adjacent in the real file; the diff omits the
  unchanged gap between them. Flattening hunks together before slicing would silently
  splice in code that isn't actually near the finding.
- A line with no `newLine` (a pure removal) can't be a match target — findings never land
  on removed-only lines per the review prompt's "lines changed in the diff" instruction,
  but if one somehow does, lookup returns `undefined` rather than guessing.
- File not found in the diff, or line not found in the file's hunks → `undefined`.

Never throws. An unparseable or unexpected diff shape degrades to `undefined` for that
finding — it must never fail the run.

## Component 2 — Wiring into the run

In `app.ts`, immediately before `run.findings = findings`:

```ts
findings.forEach((f) => {
  f.context = extractDiffContext(ctx.diff, f.file, f.line)
})
```

`Finding` gains one field, identically in `server/src/types.ts` and `web/src/types.ts`:

```ts
/** A few lines of surrounding diff context, extracted from the diff at review time.
 * Absent when the line couldn't be located in the diff, and on runs recorded before this
 * field existed — renderers must degrade gracefully. */
context?: DiffContextLine[]
```

This follows the same optional/degrade-gracefully precedent `example?` already
established. `RunStore` persists runs as plain JSON with no schema validation, and
`normalizeRun` already tolerates fields that are absent on older runs — no migration is
needed.

## Component 3 — Display

`FindingCard.tsx` gains a "Show context" toggle built on the existing `Collapsible`
primitive (already used in `NewReview.tsx` for "+ Add reviewer focus" — reused, not a new
pattern), rendered only when `finding.context` is present and non-empty. Collapsed by
default, so cards stay scannable — consistent with keeping `example`/`suggestion` compact
rather than stacking more always-visible content on every card.

Expanded, it renders a compact gutter-style diff: line numbers (new-file number for
context/add lines, old-file number for remove lines) and a `+`/`-`/blank marker per line,
using the same `bg-code-surface`/`font-family-mono` treatment the `example` block already
uses — no new visual language introduced.

## Error handling summary

| Case | Behavior |
|---|---|
| File not present in the diff | `context` is `undefined`; no toggle shown |
| Line not found in any hunk | `context` is `undefined`; no toggle shown |
| Match falls near a hunk edge | Snippet clamped to that hunk, never crosses into another |
| Diff is empty or malformed | `extractDiffContext` returns `undefined`, never throws |
| Run recorded before this feature | `context` absent on every finding; renders exactly as today |

## Testing

`server/test/diffContext.test.ts`, TDD'd, reusing the multi-file/binary/rename diff
fixture shape already established in `contextPack.test.ts`:

- Single-hunk match, full radius available on both sides.
- Match near the start/end of a hunk — radius clamped, not padded with out-of-range lines.
- Two hunks in one file — a match near the edge of hunk 1 never pulls lines from hunk 2.
- Multiple files in one diff — the correct file's hunks are used.
- Add / remove / context line typing and line-number assignment.
- No match (line not in the diff) → `undefined`.
- Empty diff → `undefined`, no throw.

`app.ts` integration (extending the existing `runPipeline.test.ts` fake-`AgentQuery`
harness): a finding whose line is in the fixture diff ends up with `context` set on the
saved run record.
