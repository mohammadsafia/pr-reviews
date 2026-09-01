# Skill Test-Run Design

**Date:** 2026-09-01
**Status:** Approved design, pending implementation plan

## Problem

Tuning a review skill today means editing its `SKILL.md` on disk, then running a full
review to see whether the change worked — `readSkillContent` always reads fresh off disk
by name; there is no way to try a skill's in-progress wording before saving it.

That said, most of what a "faster/cheaper" dry-run would promise doesn't actually exist to
build: `buildReviewPrompt` has the agent explore the real checked-out repo with
Read/Grep/Glob, not just a diff string, so review quality is inseparable from doing that
real exploration — there's no design that makes a meaningful test cheaper or faster than a
real run against a real PR. And `NewReview.tsx` already lets you select exactly one skill
with verify off, which is already "run just this one skill, minimal cost." The one gap
worth closing is testing **draft content that hasn't been saved yet**.

## Goals

1. Let a skill author paste/edit a `SKILL.md`'s content and run it against a real PR
   without saving to disk first.
2. Keep test iterations out of the Runs list — testing wording five times in a row
   shouldn't produce five history entries.
3. Never let a test run's findings be postable to the real PR, even via a direct API call.

Non-goals: a faster/cheaper execution path (not possible — see Problem); comparing
multiple draft versions side by side; editing skills already on disk in-place (this tests
arbitrary pasted content, saving it is a separate, manual step the author still does).

## Architecture overview

A test run is a real `RunRecord`, tagged `isTest: true`, executed through a new,
narrower sibling of `executeRun` — not a parallel in-memory/ephemeral system:

```
POST /api/skills/test-run { url, skillContent, profile? }
        │
  parse name from skillContent's frontmatter (parseFrontmatter, exported from scanner.ts)
        │
  same PR-resolve + oversized-diff gate as POST /api/runs
        │
  executeTestRun: checkout → writeContextPack → ONE runReview() call → sort → save
        │
  RunRecord { isTest: true, skills: [name], testSkillContent, status: 'completed', ... }
```

Reusing the existing `RunRecord` shape means the existing SSE events route
(`GET /api/runs/:id/events`), `getRun`, and — most importantly — the entire `RunView` page
(live console, severity-grouped findings, everything) work for a test run with no new
display code. `GET /api/runs/:id/events` specifically needs a real, fetchable
`RunStore` record to handle a client reconnect correctly (it checks the stored run's
status when a client connects); a truly in-memory-only "ephemeral" design would have
required rebuilding that reconnect safety from scratch for no real benefit. "Ephemeral" is
delivered instead by filtering: `GET /api/runs` excludes `isTest` runs, so they never
appear in the Runs list, while `GET /api/runs/:id` still resolves them directly.

Untouched: `executeRun`, the queue, verify, auto-submit, providers, repo cache, dedupe,
fingerprinting/posting infrastructure. Touched: `server/src/skills/scanner.ts` (export
`parseFrontmatter`), `server/src/app.ts` (new route + `executeTestRun` + list filter +
comment-posting guard), `server/src/types.ts` (`RunRecord` fields), `web/src/types.ts`
(mirror), a new `web/src/pages/TestSkill.tsx`, `web/src/pages/Settings.tsx` (entry point),
`web/src/router.tsx` (new route), `web/src/pages/RunView.tsx` (hide posting/retry for test
runs).

## Component 1 — `parseFrontmatter` export

`server/src/skills/scanner.ts`'s `parseFrontmatter` is currently a private helper used
only to read `name`/`description`/`category` off a scanned skill file. Exporting it (no
behavior change) lets the new route derive a test run's skill name the same way a real
skill's name is derived — no separate name field for the user to keep in sync with the
frontmatter they're editing. Falls back to the literal `"test"` when the pasted content
has no frontmatter `name:` (or no frontmatter at all).

## Component 2 — `executeTestRun`

A new function in `server/src/app.ts`, deliberately not a code path through `executeRun`:
depth-grouping, verify, and auto-submit are all specific to a real multi-skill review and
don't apply to testing one ad-hoc skill.

Sequence: resolve PR meta/diff via the provider client (same as `POST /api/runs`) →
`RepoCache.ensureWorktree` → `writeContextPack` → a single `runReview()` call with
`skills: [{ name, content: skillContent }]` → sort findings by verdict/severity (the exact
sort `executeRun` already does, extracted into a small shared `sortFindings(findings)`
helper so the two call sites can't drift) → persist as a `RunRecord`:

```ts
{
  isTest: true,
  skills: [name],
  testSkillContent: skillContent,   // exact wording tested, for later reference
  status: 'completed',
  verify: false,
  // ...the rest of RunRecord's usual fields (pr, prTitle, findings, transcript, etc.)
}
```

No verify session, no auto-submit step. Same worktree cleanup in a `finally` block as
`executeRun`. On failure (checkout error, agent error), the run is saved `status: 'failed'`
with the error message — same failure shape a real run already has, so `RunView` needs no
new failure-state handling.

## Component 3 — Never postable

Enforced at two layers, since a UI-only guard is not a real guarantee:

- **Server**: `POST /api/runs/:id/comments` looks up the run first and returns `400` with
  a clear message when `run.isTest` is true, before any comment-posting logic runs. A
  direct API call against a test run's id can never post to the real PR.
- **Client**: `RunView.tsx` doesn't render the finding checkboxes, the floating "Post to
  PR…" bar, or the confirm dialog at all when `run.isTest`. "Retry run"/"Retry failed
  skills" are hidden too — retry's parent-run/lineage semantics are about continuity across
  real reviews of a PR, which doesn't apply to a one-off draft test.

A small "Test run" badge (near the existing status/verify badges) makes the distinction
visible at a glance so a test result is never mistaken for a real review.

## Component 4 — `POST /api/skills/test-run` and `GET /api/runs` filtering

The new route accepts `{ url: string, skillContent: string, profile?: string }`, applies
the same URL-parse and oversized-diff (`countDiffLines`/`diffWarnLines`/`force`) checks
`POST /api/runs` already does — consistency and cost-safety, not a lighter gate — then
queues `executeTestRun` the same way `executeRun` is queued today, returning `{ id }` at
202.

`GET /api/runs` changes from `store().list()` to `store().list().filter((r) => !r.isTest)`.
`GET /api/runs/:id` and the SSE events route are untouched — a test run is a real,
individually-fetchable record; only the list view hides it.

## Component 5 — UI: Settings entry point and the test form

A "Test skill" link in Settings → Skills tab (where skill sources are already managed —
no new top-level nav item) opens `web/src/pages/TestSkill.tsx`: a PR URL field, a
`Textarea` for the skill's `SKILL.md` content, and an optional model-profile picker
defaulting to `config.reviewProfile` (the same default `NewReview.tsx`'s picker already
uses). Submitting calls the new endpoint and navigates to `/runs/:id` on success —
`RunView` renders the result with no new display code, guarded as described in Component 3.

## Error handling summary

| Case | Behavior |
|---|---|
| Pasted content has no frontmatter `name:` | Skill name defaults to `"test"` |
| Diff exceeds `diffWarnLines` without `force` | Same 409 + "run anyway" flow as a real run |
| Checkout or agent session fails | Run saved `status: 'failed'` with the error, same as a real run |
| Direct `POST /api/runs/:id/comments` against a test run | 400, no comment logic runs |
| Test run's URL visited directly (`/runs/:id`) | Resolves and renders normally — only the list hides it |

## Testing

- `parseFrontmatter` export: existing scanner tests continue to cover its parsing logic
  unchanged; a new test confirms it's importable from `server/src/app.ts`'s call site
  (i.e. exported, not just internal).
- `executeTestRun` (extending the `runPipeline.test.ts` fake-`AgentQuery` harness): a
  single-skill session's findings land on `run.findings` with `isTest: true`,
  `skills: [name]`, `testSkillContent` set; no verify session runs (assert the fake agent
  is never asked to "adversarially verify"); a checkout/agent failure yields
  `status: 'failed'`.
- `sortFindings` extraction: existing sort-order assertions in `runPipeline.test.ts` keep
  passing unchanged (pure refactor, not a behavior change) — proves both call sites still
  agree.
- `GET /api/runs` filtering: a mix of test and real runs — the list excludes the test run;
  `GET /api/runs/:id` still resolves it directly.
- `POST /api/runs/:id/comments` guard: a request against a known test-run id returns 400
  and does not call the provider client's comment-posting method.
- `TestSkill.tsx`/`RunView.tsx`: no new unit tests (presentational, matching this
  project's established convention of testing only extracted pure logic) — verified via
  typecheck + build + full test suite.
