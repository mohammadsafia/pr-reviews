# GitHub PR Support — Design

**Date:** 2026-07-22 · Adds GitHub as a second PR provider alongside Bitbucket Cloud. Builds on the v1 spec, UI revamp, and per-skill fan-out.

## Summary

Today the tool reviews Bitbucket Cloud PRs only: `parsePrUrl` accepts only `bitbucket.org/.../pull-requests/<id>`, and one `BitbucketClient` fetches the PR/diff and posts comments. This change introduces a **provider abstraction** so a GitHub PR URL (`github.com/<owner>/<repo>/pull/<n>`) is reviewed the same way. Everything downstream of fetching the PR — the per-skill subagent fan-out, the findings report, the confirm-before-post flow — is provider-agnostic and is reused unchanged.

## Decisions (confirmed with user)

- **GitHub auth = a personal access token in Settings**, mirroring the Bitbucket token (fine-grained PAT with pull-request read/write on the target repos).
- Clone reuses the existing `cloneProtocol` setting (ssh → `git@github.com`, https → token-embedded URL).

## Provider model

Introduce a common interface both clients implement. Put shared cross-provider code under a new `server/src/providers/` module; keep each client in its own dir.

```ts
// server/src/types.ts
export type Provider = 'bitbucket' | 'github'
export interface PrRef {
  provider: Provider
  workspace: string   // Bitbucket workspace OR GitHub owner
  repo: string
  id: number
}
// PrProviderClient: the structural shape the app depends on (was `BitbucketLike`).
export interface PrProviderClient {
  getPullRequest(pr: PrRef): Promise<PrMeta>
  getDiff(pr: PrRef): Promise<string>
  postInlineComment(pr: PrRef, c: { path: string; line: number; text: string }): Promise<number>
  cloneUrl(pr: PrRef, protocol?: 'ssh' | 'https'): string
}
```

`PrMeta` is unchanged (`title`, `description`, `sourceBranch`, `destinationBranch`, `sourceCommit`).

### Auth errors
Add `export class PrAuthError extends Error` in `server/src/providers/`. Make the existing `BitbucketAuthError extends PrAuthError` (keeps its message + existing test passing). The GitHub client throws `PrAuthError` on 401/403 with a GitHub-specific message. `app.ts` maps `err instanceof PrAuthError ? 401 : 502` (replaces the `BitbucketAuthError` check).

## Server changes

### `server/src/providers/parsePrUrl.ts` (moved from `bitbucket/parsePrUrl.ts`)
Provider-aware. Accept both, trim whitespace, tolerate trailing path/query:
- `https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>` → `{ provider: 'bitbucket', workspace, repo, id }`
- `https://github.com/<owner>/<repo>/pull/<id>` → `{ provider: 'github', workspace: owner, repo, id }`
- Anything else throws `Error` whose message starts `Invalid PR URL` and names both accepted formats.
Move its test to `server/test/parsePrUrl.test.ts` (add GitHub cases + a github-non-PR reject). Update `app.ts` import.

### `server/src/github/client.ts` (new) — `GitHubClient implements PrProviderClient`
- Constructor `(token: string, fetchFn: typeof fetch = fetch)`.
- Base `https://api.github.com`. Headers on every request: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`. **Do not send `X-GitHub-Api-Version`** — omitting it uses GitHub's current default version (future-proof; avoids pinning a stale date).
- `getPullRequest`: `GET /repos/<owner>/<repo>/pulls/<id>` (JSON) → map `title`, `body`→description, `head.ref`→sourceBranch, `base.ref`→destinationBranch, `head.sha`→sourceCommit.
- `getDiff`: same URL with `Accept: application/vnd.github.diff` → return `res.text()`.
- `postInlineComment`: GitHub requires the head commit SHA. **Memoize it on the instance**: on first post, `getPullRequest` (or a lightweight GET) to resolve `head.sha`, cache it, reuse for the rest of the batch (one client instance handles a whole posting batch). Then `POST /repos/<owner>/<repo>/pulls/<id>/comments` with body `{ body: text, commit_id: <headSha>, path, line, side: 'RIGHT' }` (single-line, new-side). Returns the created comment's `id` (201).
- 401/403 → throw `PrAuthError` ("GitHub rejected your token (401)…" / "GitHub denied access to this repository (403). Your token may lack `pull-requests` scope on it."). Other non-2xx → `Error('GitHub API error <status> for <url>')`.
- `cloneUrl(pr, protocol='ssh')`: ssh → `git@github.com:<owner>/<repo>.git`; https → `https://x-access-token:<token>@github.com/<owner>/<repo>.git` (the `user:pass@` shape so the existing git-stderr credential redaction catches it).
- Tests (`server/test/githubClient.test.ts`, fake fetch): PR-meta mapping, diff via the diff Accept header, inline comment sends `commit_id`/`side:'RIGHT'`/`line`/`path` and returns the id (assert it resolved the head SHA), 401→PrAuthError, both clone-URL forms.

### `server/src/providers/factory.ts` (new)
`makeClient(pr: PrRef, cfg: Config): PrProviderClient` → `bitbucket` ⇒ `new BitbucketClient(cfg.bitbucketEmail, cfg.bitbucketToken)`, `github` ⇒ `new GitHubClient(cfg.githubToken)`. Small unit test for the branch.

### `server/src/config.ts`
Add `githubToken: z.string().default('')`.

### `server/src/repos/cache.ts` — namespace by provider
Change `repoDir(pr)` to `join(this.root, pr.provider, pr.workspace, pr.repo)` (prevents a bitbucket `acme/api` and a github `acme/api` from colliding on one clone dir). Update the `mkdirSync` parent accordingly. Update `repoCache.test.ts` fixtures to include `provider`.

### `server/src/app.ts`
- Replace the `bitbucketFactory` dep with `clientFactory?: (pr: PrRef, cfg: Config) => PrProviderClient`, defaulting to `makeClient`. Update the three call sites (POST `/api/runs`, `executeRun`, comments route) to pass the parsed `pr` + config and use the returned client. (Tests inject a fake here — update those injections.)
- Auth mapping: `err instanceof PrAuthError ? 401 : 502`.
- **Config token masking (both tokens):** `GET /api/config` masks `githubToken` the same way it masks `bitbucketToken` (`'***'` when set). `PUT /api/config` keeps the existing `githubToken` when the incoming value is the mask sentinel — apply the same keep-on-mask logic already used for `bitbucketToken`.
- **Cache DELETE route** becomes `DELETE /api/cache/:provider/:workspace/:repo`; validate `provider` is exactly `bitbucket` or `github` (400 otherwise) alongside the existing workspace/repo charset + containment checks; construct the `PrRef` with the provider.

### Tests
- `runPipeline.test.ts` / `app.test.ts`: add a **GitHub** run — POST a `github.com/.../pull/1` URL with the fake client + fixture checkout, poll to `completed`, assert findings appear (proves the provider path is wired end-to-end and the fan-out is provider-agnostic). Add a `parsePrUrl` 400 case for a malformed URL of each host.

## Web changes

### `web/src/types.ts`
Add `githubToken` to `Config`; add `provider: 'bitbucket' | 'github'` to `PrRef` (used by RunView's Retry URL rebuild).

### `web/src/pages/Settings.tsx`
Add a **GitHub** card (or a field in a combined "Source hosts" section): a password Input for the GitHub token with the same `*** means your saved token is kept` caption and a one-line note ("Fine-grained PAT with pull-request read/write on the repos you review"). Clone protocol stays shared (already in the Bitbucket card). The **Clear a cached repo** control gains a provider selector (bitbucket/github — a small select or two-button toggle) since the cache DELETE route is now provider-scoped; pass it through `clearRepoCache`.

### `web/src/api.ts`
`clearRepoCache(provider, workspace, repo)` — add the provider path segment.

### `web/src/pages/RunView.tsx`
The **Retry run** button rebuilds the PR URL — make it provider-aware: github → `https://github.com/<owner>/<repo>/pull/<id>`, bitbucket → the existing `.../pull-requests/<id>`. Read `run.pr.provider`.

### `web/src/pages/NewReview.tsx`
Update the URL input placeholder/help text to show both accepted formats (e.g. placeholder stays a Bitbucket example; helper line notes "Bitbucket or GitHub PR URL").

## Out of scope
GitHub Enterprise Server (only public github.com), GitLab, `gh` CLI auth, PR review *summaries* (only inline comments, as with Bitbucket today), and multi-line comment ranges (single-line inline comments only).
