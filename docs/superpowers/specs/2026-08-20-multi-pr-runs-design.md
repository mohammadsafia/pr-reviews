# Multi-PR Concurrent Runs Design

**Date:** 2026-08-20
**Status:** Approved design, pending implementation plan

## Problem

Runs execute one at a time: `app.ts` pushes every run through a global `SerialQueue`
(`server/src/queue.ts`), so reviewing several PRs of the same project means waiting for
each to finish before the next starts. Worse, true concurrency is blocked structurally:
`RepoCache.repoDir(pr)` ignores the PR id — every PR of a repo shares one checkout
directory, and concurrent runs would fight over `git checkout -f` and the per-run
`.pr-review/` context pack written inside it.

## Goals

1. Submit several PR URLs of the same project in one action, with shared
   skills/depth/verify/focus settings.
2. Runs execute concurrently up to a configurable cap; excess runs queue visibly.
3. Concurrent runs on the same repo are fully isolated from each other.

Non-goals: listing open PRs from the provider (batch input is pasted URLs); a dedicated
batch dashboard (the Recent Runs list serves that role); guarding the cache-clear API
against active runs (pre-existing hazard, unchanged in kind).

## Architecture Overview

Three independent changes compose:

1. **Per-run git worktrees** — the base clone per repo stays, but each run checks out into
   its own `git worktree` directory. Git operations serialize on a per-repo mutex
   (seconds); agent phases run in parallel (minutes).
2. **Task pool** — `SerialQueue` becomes `makeTaskPool(getLimit, onError)` with a live
   `maxConcurrentRuns` config (default 2).
3. **Batch submission UI** — the New Review URL input becomes a textarea; the client loops
   the existing `POST /api/runs` per URL. No new server endpoint.

## Component 1 — Worktree lifecycle (`server/src/repos/cache.ts`)

**Layout.** Base clones stay at `<cacheDir>/<provider>/<ws>/<repo>`. Per-run worktrees
live at:

```
<cacheDir>/.worktrees/<provider>/<ws>/<repo>/<runId>
```

`.worktrees` is a hidden top-level sibling — it cannot collide with provider directories.

**API.**

- `ensureWorktree(pr, { cloneUrl, sourceBranch, commit, runId }): Promise<string>` —
  replaces `ensureCheckout` in the run path:
  1. Ensure the base clone exists (as today, minus the final checkout — the base's own
     working tree no longer matters). On ensure, add `.pr-review/` to the base clone's
     `.git/info/exclude` (worktrees share it via the common git dir).
  2. `git fetch --depth 50 origin <sourceBranch>` in the base.
  3. Remove any leftover directory for this runId, then
     `git worktree add --detach <dir> <commit>`.
  Returns the worktree path.
- `removeWorktree(pr, runId): Promise<void>` — `git worktree remove --force <dir>` then
  `git worktree prune` on the base. Force is safe: the worktree is machine-managed,
  findings live in the run store, and the untracked `.pr-review/` pack would otherwise
  block a clean remove.
- `clear(pr)` also deletes `<cacheDir>/.worktrees/<provider>/<ws>/<repo>` (same
  path-escape guard as the base dir).
- `sweepStrandedWorktrees(cacheDir)` — startup companion to `sweepStrandedRuns`: delete
  everything under `<cacheDir>/.worktrees`, then `git worktree prune` in every base repo
  that exists. Crashed runs never leak directories.

**Per-repo mutex.** Steps 1–3 of `ensureWorktree` run under a module-level
`Map<repoPath, Promise>` chain in `cache.ts`. Module-level, not instance-level:
`executeRun` constructs a fresh `RepoCache` per run, so instance state would not be
shared. The mutex covers only git-level work; agent phases overlap freely.

**Context pack fix.** In a worktree, `.git` is a file (pointer to the common git dir), so
`writeContextPack`'s `.git/info/exclude` write would crash. `writeContextPack` changes to
write the exclude entry only when `.git` is a directory; worktree runs are covered by the
base clone's exclude entry added in `ensureWorktree` step 1.

## Component 2 — Task pool & config

**`server/src/queue.ts`** — `makeSerialQueue` is replaced by:

```ts
makeTaskPool(
  getLimit: () => number,
  onError: (err: unknown) => void,
): { push(fn: () => Promise<void>): void }
```

`push` enqueues; tasks start while `running < getLimit()`; each completion (success or
error — errors go to `onError`) dequeues the next waiter. `getLimit` is read at every
dequeue decision, not captured at construction — editing the cap in Settings applies to
the next dequeue without a restart. A pool with limit 1 reproduces the old serial
behavior exactly.

**`server/src/config.ts`** — `maxConcurrentRuns: z.number().int().min(1).default(2)`.
The per-field degradation in `loadConfig` handles invalid stored values.

**`server/src/app.ts`** — three changes:

1. `const runQueue = makeTaskPool(() => cfg().maxConcurrentRuns, (err) => app.log.error(err))`;
   `runQueue.push(...)` call sites unchanged.
2. `executeRun` swaps `ensureCheckout` for `ensureWorktree` (passing the run id) and its
   `finally` calls `removeWorktree` after the run record is saved. Removal failure is
   logged as a transcript event and never changes a run's status.
3. Startup calls `sweepStrandedWorktrees(cfg().cacheDir)` after `sweepStrandedRuns(...)`.

Run internals (depth grouping, verification, SSE events, run records) are untouched.

## Component 3 — Batch submission UI (web)

- **`web/src/lib/urls.ts`** — `parsePrUrlLines(text: string): string[]`: split lines,
  trim, drop empties, dedupe preserving order.
- **`web/src/lib/batch.ts`** — `submitBatch(urls, opts, createRunFn)`: loops URLs
  **sequentially** (each POST fetches PR meta + diff provider-side; sequential keeps the
  burst polite), returning one outcome per URL:
  `{ url, kind: 'started', id }` | `{ url, kind: 'oversized', diffLines }` |
  `{ url, kind: 'error', message }`. One URL's failure never stops the rest.
- **`NewReview.tsx`** — the URL `Input` becomes a 3-row monospace `Textarea` (one URL per
  line). The button reads "Run review" / "Run N reviews" from the parsed count; the hint
  line shows the count. On submit:
  - exactly one URL and it starts → navigate to its run view (today's behavior);
  - otherwise → stay on the page, render a per-URL results list (started rows link to
    their run; oversized rows carry their own "Run anyway" button that resubmits just
    that URL with `force: true`; error rows show the message), and refresh Recent Runs —
    which now shows the batch with live `queued`/`running` badges. That list is the batch
    dashboard; there is no separate one.
- Skills, depth, focus, and verify apply identically to every URL in the batch.

## Error handling

| Failure | Behavior |
|---|---|
| `worktree add` fails (bad commit, disk full) | Run fails early via the existing outer catch, clear error event |
| Worktree removal fails at run end | Transcript event; run status untouched; startup sweep is the backstop |
| Server crash mid-run | `sweepStrandedRuns` marks runs failed (exists); `sweepStrandedWorktrees` deletes leftover dirs and prunes base repos |
| Invalid `maxConcurrentRuns` | Per-field degradation → default 2 |
| One URL in a batch fails | Loop continues; that row shows the error |
| Cache-clear API mid-run | Pre-existing hazard, unchanged in kind; `clear()` now also removes the repo's worktrees |

## Testing

- **`queue.test.ts`** (rewritten): cap 2 holds a third task until a slot frees (deferred
  promises); cap 1 preserves strict order; a raised `getLimit` return applies at the next
  dequeue; `onError` receives failures without stalling the pool.
- **`repoCache.test.ts`** (additions, local git fixture): two worktrees of one repo
  coexist at different commits; overlapping `ensureWorktree` calls serialize on the
  mutex; `removeWorktree` deletes and prunes; `sweepStrandedWorktrees` clears leftovers;
  the base clone's `info/exclude` gains `.pr-review/`.
- **`contextPack.test.ts`** (addition): a cwd whose `.git` is a file (real worktree
  fixture) → pack written, no crash, no exclude write attempted.
- **`runPipeline.test.ts`** (additions): two PRs of the same repo submitted back-to-back
  both complete with their own findings, agent phases overlapping (deferred fake agents);
  with `maxConcurrentRuns: 1`, the second run stays `queued` until the first finishes.
- **Web**: `parsePrUrlLines` unit tests (trim/dedupe/order); `submitBatch` outcome-mapping
  tests with a stubbed `createRunFn` (started / oversized / error / continue-past-failure).

## Expected impact

Reviewing 4 PRs of one project today: 4 × full serial run time. After: git setup
serializes (a few seconds per run on the shared repo mutex), agent phases overlap under
the cap — with the default cap of 2, wall-clock roughly halves; raising the cap trades
API/quota burst for speed.
