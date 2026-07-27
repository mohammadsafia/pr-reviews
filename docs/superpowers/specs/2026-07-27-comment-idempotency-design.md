# Idempotent & Resolution-Aware Comment Posting — Design

**Date:** 2026-07-27 · Adds cross-re-review comment memory. Builds on the provider abstraction (GitHub + Bitbucket) and the review-quality slice. Part of the "enhance the review" track.

## Summary

Re-posting findings to a PR — re-clicking "post," or re-reviewing the same PR — currently duplicates comments, and re-raises issues the developer already resolved. This change makes comment posting **idempotent and resolution-aware** by fingerprinting our own comments and reading the PR back before posting:

- When we post a finding, we append a **hidden HTML-comment marker** carrying a fingerprint of the finding. Invisible in rendered Markdown on both GitHub and Bitbucket.
- Before posting, we **read the PR's existing comments**, extract our fingerprints and their resolved state. Any selected finding whose fingerprint already exists is **skipped** — whether the thread is open (idempotency: don't duplicate) or resolved (don't re-raise an addressed issue).
- The **PR is the source of truth** — no separate cross-run store to keep in sync; this works across machines and re-clones.

## Decisions (confirmed with user)

- **Both** capabilities: idempotency + resolution-aware skipping, unified via one fingerprint mechanism.
- **Fingerprint marker in the comment body** (not a local per-PR database).
- **Line-independent key** — fingerprint keys on `provider|workspace|repo|file|category|normalized-summary`, NOT line, so it survives line drift when the PR is updated. Accepted limitation: if the model rewords a finding's summary on a later run, its fingerprint changes and it may re-post.
- **Skip surfaced in the confirm dialog** before posting (New / Already posted / Resolved), so the user sees the dedup before confirming.

## Honest limitations (documented, by design)

1. Matching is best-effort: keyed on summary text; a reworded finding won't match its prior comment.
2. Resolution-awareness applies only to **our own fingerprinted comments** — we cannot reliably match a new finding to an arbitrary human review thread we didn't author.

## Fingerprint scheme (`server/src/review/fingerprint.ts`, pure)

```ts
// normalizedSummary: summary.toLowerCase(), whitespace collapsed to single spaces, trimmed.
export function fingerprint(pr: PrRef, f: { file: string; category: string; summary: string }): string
  // = first 12 hex chars of sha256(`${pr.provider}|${pr.workspace}|${pr.repo}|${f.file}|${f.category}|${normalized(f.summary)}`)
export function commentMarker(fp: string): string        // = `<!-- prr-fp:${fp} -->`
export function parseFingerprint(body: string): string | undefined  // extracts fp from a `<!-- prr-fp:... -->` marker, or undefined
```

Unit-tested: stable for identical inputs; line-independent (same fp when only `line` differs — line isn't an input); different file/category/summary → different fp; marker round-trips through parse; a body with no marker → undefined.

## Provider read method

Extend `PrProviderClient` (`server/src/types.ts`):

```ts
export interface ExistingComment {
  path: string
  line?: number
  body: string
  resolved: boolean
}
// added to PrProviderClient:
listComments(pr: PrRef): Promise<ExistingComment[]>
```

- **BitbucketClient** (`server/src/bitbucket/client.ts`): `GET /2.0/repositories/{ws}/{repo}/pullrequests/{id}/comments`, follow `next` pagination. Per comment: `body = content.raw`, `path = inline?.path`, `line = inline?.to`, `resolved = resolution != null`. Skip `deleted` comments. (Non-inline / general comments still returned — they just won't carry a path; fingerprint matching only cares about the marker in the body.)
- **GitHubClient** (`server/src/github/client.ts`): POST to `${API}/graphql` (same `Authorization: Bearer` token; `Content-Type: application/json`) with:
  ```graphql
  query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
    repository(owner:$owner,name:$repo){ pullRequest(number:$number){
      reviewThreads(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ isResolved path line comments(first:1){ nodes{ body } } }
      } } } }
  ```
  Paginate on `pageInfo`. Flatten: each thread → for each of its comments, `{ path: thread.path, line: thread.line ?? undefined, body, resolved: thread.isResolved }`. (first:1 comment per thread is enough — our marker is in the top comment we posted.) 401/403 → `PrAuthError`; other non-2xx or a GraphQL `errors` array → `Error`.
- Fake clients in tests implement `listComments` too (default `[]`).

## Post flow (`server/src/app.ts`, comments route)

Current route posts each selected finding and returns `{ posted, failed }`. New behavior:

1. `const existing = await client.listComments(run.pr)` (once). On failure of this read, do NOT block posting — log/emit nothing fancy; treat as "no existing comments" so posting still works (fail-open on the read; a read failure must not prevent posting). Record that the dedup check was skipped in the response (`dedupeChecked: false`).
2. Build `existingFps: Map<string, boolean>` = fingerprint → resolved (a fingerprint is resolved if ANY comment carrying it is resolved). From `existing`, `parseFingerprint(body)`.
3. For each requested finding index:
   - `fp = fingerprint(run.pr, f)`.
   - If `existingFps.has(fp)` → push to `skipped: [{ index, reason: existingFps.get(fp) ? 'resolved' : 'already-posted' }]`; do not post.
   - Else post via `postInlineComment` with body = the human-readable comment text **plus** `\n\n${commentMarker(fp)}`; on success record posted id; on error push to `failed` and stop (unchanged partial-failure behavior).
4. Response: `{ posted: number[], skipped: { index, reason }[], failed: { index, error }[], dedupeChecked: boolean }`.

The human-readable comment text stays the shared builder (severity/category/skills/summary/detail/suggestion from the review-quality slice). Only the server appends the marker at post time — the web confirm-dialog preview shows the human text without the marker (the marker is an invisible HTML comment; nothing to preview).

## Web (`web/src/pages/RunView.tsx`, `web/src/api.ts`, `web/src/types.ts`)

Fingerprint logic lives ONLY on the server (single source of truth) — the browser never hashes. The dialog gets its per-finding status from one server route.

- **New server route** `GET /api/runs/:id/post-preview` → `{ statuses: { index, status: 'new' | 'already-posted' | 'resolved' }[], dedupeChecked: boolean }`. It runs `client.listComments(run.pr)`, builds the fingerprint→resolved map, and classifies every finding in the run using the same server `fingerprint`. Fail-open: if the read throws, return every finding as `'new'` with `dedupeChecked: false`.
- `web/src/api.ts`: add `getPostPreview(runId)` for that route; extend `postComments`'s return type with `skipped: { index, reason }[]` and `dedupeChecked: boolean`.
- `web/src/types.ts`: add the `post-preview` and updated `postComments` response shapes. (No `ExistingComment` mirror needed — the browser only sees per-index statuses.)
- **Confirm dialog**: on open, call `getPostPreview`. Render each selected finding with its status badge (New / Already posted / Resolved); only `new` findings are enabled and actually posted — `already-posted`/`resolved` are shown labeled and excluded from the post. If `dedupeChecked: false`, show all as `new` with a small "couldn't check the PR for existing comments" note.
- After posting, show "Posted N · skipped M (already posted / resolved)".

## Testing

- `server/test/fingerprint.test.ts`: stability, line-independence, distinctness, marker round-trip, no-marker→undefined.
- `server/test/bitbucketClient.test.ts` / `githubClient.test.ts`: `listComments` maps fields + resolution correctly (fake fetch; GitHub GraphQL response shape incl. pagination + isResolved; Bitbucket `resolution` presence + `next` pagination); auth error mapping.
- `server/test/app.test.ts` (or runPipeline): the comments route skips a finding whose fingerprint already exists (open → `already-posted`; resolved → `resolved`), posts a new one WITH the marker appended, and fails open (`dedupeChecked:false`, all posted) when `listComments` throws; the post-preview route returns correct per-finding status.
- Web: confirm-dialog test that findings render with new/already-posted/resolved status and only `new` post (fake api).

## Out of scope
- Matching new findings to human (non-fingerprinted) threads.
- A "post anyway / force re-post" override (skipped is skipped for v1).
- Editing/resolving/replying to existing comments from the tool.
- Reliability slice (login-expiry banner + retry-failed-skills) — designed and approved earlier, still PARKED, to be built as its own slice.
