# Idempotent & Resolution-Aware Comment Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Never post a duplicate PR comment and never re-raise an already-resolved one, by fingerprinting our own comments (hidden marker) and reading the PR back before posting.

**Architecture:** A pure `fingerprint` module hashes each finding line-independently. Both provider clients gain `listComments(pr)` (Bitbucket REST, GitHub GraphQL) exposing body + resolved state. The comments route reads existing comments, skips findings whose fingerprint already exists (open → `already-posted`, resolved → `resolved`), and appends the marker to newly posted comments. A `post-preview` route classifies every finding server-side so the web confirm dialog shows New/Already-posted/Resolved before posting. Fail-open: a read failure never blocks posting.

**Tech Stack:** Node 20+, TypeScript strict, Fastify, `node:crypto` (sha256), Vitest (server); Vite + React (web).

**Spec:** `docs/superpowers/specs/2026-07-27-comment-idempotency-design.md`

## Global Constraints

- Node 20+, TypeScript `"strict": true`.
- Server tests: `cd server && npx vitest run` + `npx tsc --noEmit`. Web: `cd web && npx vitest run && npm run build`. All green before each commit.
- Fingerprint = first 12 hex chars of `sha256(`${pr.provider}|${pr.workspace}|${pr.repo}|${f.file}|${f.category}|${normalizedSummary}`)`; `normalizedSummary` = `summary.toLowerCase()`, all whitespace runs collapsed to a single space, trimmed. **Line is NOT part of the key.**
- Comment marker = `<!-- prr-fp:${fp} -->`; appended to the posted body as `\n\n${marker}`. Fingerprint hashing lives ONLY on the server — the browser never hashes.
- A fingerprint counts as **resolved** if ANY existing comment carrying it is resolved.
- **Fail-open reads:** if `listComments` throws, treat as "no existing comments," still post, and report `dedupeChecked: false`.
- GitHub: no `X-GitHub-Api-Version` header (matches existing client). 401→`PrAuthError` "GitHub rejected your token (401)…", 403→`PrAuthError` "GitHub denied access…".
- Skipped findings are skipped (no force-repost override in v1).
- Conventional commits; commit after each green cycle.
- Do NOT change the review pipeline, per-skill fan-out, or verification.

---

### Task 1: Fingerprint module

**Files:**
- Create: `server/src/review/fingerprint.ts`
- Test: `server/test/fingerprint.test.ts`

**Interfaces:**
- Consumes: `PrRef` from `../types.js`.
- Produces:
  - `fingerprint(pr: PrRef, f: { file: string; category: string; summary: string }): string`
  - `commentMarker(fp: string): string`
  - `parseFingerprint(body: string): string | undefined`

- [ ] **Step 1: Write the failing test**

`server/test/fingerprint.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fingerprint, commentMarker, parseFingerprint } from '../src/review/fingerprint.js'
import type { PrRef } from '../src/types.js'

const pr: PrRef = { provider: 'github', workspace: 'acme', repo: 'app', id: 7 }
const f = { file: 'src/a.ts', category: 'bug', summary: 'Null deref on user' }

describe('fingerprint', () => {
  it('is stable for identical inputs', () => {
    expect(fingerprint(pr, f)).toBe(fingerprint(pr, f))
  })
  it('is 12 lowercase hex chars', () => {
    expect(fingerprint(pr, f)).toMatch(/^[0-9a-f]{12}$/)
  })
  it('is line-independent (line is not an input) and summary-normalized', () => {
    // whitespace/case differences in summary must not change the fp
    expect(fingerprint(pr, { ...f, summary: '  null   DEREF on   user ' })).toBe(fingerprint(pr, f))
  })
  it('differs on file, category, summary, and PR identity', () => {
    const base = fingerprint(pr, f)
    expect(fingerprint(pr, { ...f, file: 'src/b.ts' })).not.toBe(base)
    expect(fingerprint(pr, { ...f, category: 'security' })).not.toBe(base)
    expect(fingerprint(pr, { ...f, summary: 'different' })).not.toBe(base)
    expect(fingerprint({ ...pr, repo: 'other' }, f)).not.toBe(base)
  })
})

describe('commentMarker / parseFingerprint', () => {
  it('round-trips a fingerprint through a marker', () => {
    const fp = fingerprint(pr, f)
    const body = `some comment text\n\n${commentMarker(fp)}`
    expect(parseFingerprint(body)).toBe(fp)
  })
  it('returns undefined when there is no marker', () => {
    expect(parseFingerprint('plain comment, no marker')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/fingerprint.test.ts`
Expected: FAIL — cannot find module `../src/review/fingerprint.js`.

- [ ] **Step 3: Implement**

`server/src/review/fingerprint.ts`:

```ts
import { createHash } from 'node:crypto'
import type { PrRef } from '../types.js'

function normalizeSummary(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function fingerprint(
  pr: PrRef,
  f: { file: string; category: string; summary: string },
): string {
  const key = `${pr.provider}|${pr.workspace}|${pr.repo}|${f.file}|${f.category}|${normalizeSummary(f.summary)}`
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

export function commentMarker(fp: string): string {
  return `<!-- prr-fp:${fp} -->`
}

export function parseFingerprint(body: string): string | undefined {
  const m = /<!-- prr-fp:([0-9a-f]{12}) -->/.exec(body)
  return m ? m[1] : undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/fingerprint.test.ts && npx tsc --noEmit`
Expected: PASS (6 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/review/fingerprint.ts server/test/fingerprint.test.ts
git commit -m "feat: line-independent finding fingerprint + comment marker"
```

---

### Task 2: `listComments` on the provider interface + both clients

**Files:**
- Modify: `server/src/types.ts` (add `ExistingComment`, add `listComments` to `PrProviderClient`)
- Modify: `server/src/bitbucket/client.ts` (implement `listComments`)
- Modify: `server/src/github/client.ts` (implement `listComments` via GraphQL)
- Test: `server/test/bitbucketClient.test.ts`, `server/test/githubClient.test.ts`

**Interfaces:**
- Consumes: `PrRef`, `PrAuthError`.
- Produces:
  - `ExistingComment = { path?: string; line?: number; body: string; resolved: boolean }`
  - `PrProviderClient.listComments(pr: PrRef): Promise<ExistingComment[]>`

Note: `path` is optional — general (non-inline) Bitbucket comments have no path; fingerprint matching only reads `body`, so path/line are informational.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/bitbucketClient.test.ts` (mirror its existing fake-fetch style):

```ts
it('listComments maps body, inline path/line, and resolution across pages', async () => {
  const page1 = {
    values: [
      { content: { raw: 'open one <!-- prr-fp:aaaaaaaaaaaa -->' }, inline: { path: 'a.ts', to: 5 }, resolution: null },
      { content: { raw: 'resolved one <!-- prr-fp:bbbbbbbbbbbb -->' }, inline: { path: 'b.ts', to: 9 }, resolution: { type: 'resolved' } },
    ],
    next: 'https://api.bitbucket.org/2.0/next-page',
  }
  const page2 = { values: [{ content: { raw: 'general no-inline' }, resolution: null }] }
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }))
  const client = new BitbucketClient('e@x.io', 'tok', fetchFn as any)
  const out = await client.listComments({ provider: 'bitbucket', workspace: 'w', repo: 'r', id: 3 })
  expect(out).toEqual([
    { path: 'a.ts', line: 5, body: 'open one <!-- prr-fp:aaaaaaaaaaaa -->', resolved: false },
    { path: 'b.ts', line: 9, body: 'resolved one <!-- prr-fp:bbbbbbbbbbbb -->', resolved: true },
    { path: undefined, line: undefined, body: 'general no-inline', resolved: false },
  ])
  expect(fetchFn).toHaveBeenCalledTimes(2)
})
```

Add to `server/test/githubClient.test.ts`:

```ts
it('listComments flattens review threads with isResolved across pages', async () => {
  const page1 = {
    data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: true, endCursor: 'C1' },
      nodes: [
        { isResolved: false, path: 'a.ts', line: 5, comments: { nodes: [{ body: 'open <!-- prr-fp:aaaaaaaaaaaa -->' }] } },
        { isResolved: true, path: 'b.ts', line: 9, comments: { nodes: [{ body: 'done <!-- prr-fp:bbbbbbbbbbbb -->' }] } },
      ],
    } } } } },
  }
  const page2 = {
    data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ isResolved: false, path: 'c.ts', line: 1, comments: { nodes: [{ body: 'p2 <!-- prr-fp:cccccccccccc -->' }] } }],
    } } } } },
  }
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }))
  const client = new GitHubClient('tok', fetchFn as any)
  const out = await client.listComments({ provider: 'github', workspace: 'o', repo: 'r', id: 7 })
  expect(out).toEqual([
    { path: 'a.ts', line: 5, body: 'open <!-- prr-fp:aaaaaaaaaaaa -->', resolved: false },
    { path: 'b.ts', line: 9, body: 'done <!-- prr-fp:bbbbbbbbbbbb -->', resolved: true },
    { path: 'c.ts', line: 1, body: 'p2 <!-- prr-fp:cccccccccccc -->', resolved: false },
  ])
  const firstCall = (fetchFn.mock.calls[0][0] as string)
  expect(firstCall).toBe('https://api.github.com/graphql')
})

it('listComments maps GitHub 401 to PrAuthError', async () => {
  const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
  const client = new GitHubClient('bad', fetchFn as any)
  await expect(
    client.listComments({ provider: 'github', workspace: 'o', repo: 'r', id: 7 }),
  ).rejects.toBeInstanceOf(PrAuthError)
})
```

(If `PrAuthError` isn't already imported in githubClient.test.ts, add `import { PrAuthError } from '../src/providers/errors.js'`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/bitbucketClient.test.ts test/githubClient.test.ts`
Expected: FAIL — `listComments` is not a function.

- [ ] **Step 3: Add the type**

`server/src/types.ts` — add above `PrProviderClient`:

```ts
export interface ExistingComment {
  path?: string
  line?: number
  body: string
  resolved: boolean
}
```

And add to the `PrProviderClient` interface (after `postInlineComment`):

```ts
  listComments(pr: PrRef): Promise<ExistingComment[]>
```

- [ ] **Step 4: Implement Bitbucket `listComments`**

`server/src/bitbucket/client.ts` — add the import for the type and the method. `ExistingComment` comes from `../types.js` (extend the existing type import). Add:

```ts
  async listComments(pr: PrRef): Promise<ExistingComment[]> {
    const out: ExistingComment[] = []
    let url: string | undefined = `${this.prBase(pr)}/comments?pagelen=100`
    while (url) {
      const page = (await (await this.request(url)).json()) as any
      for (const c of page.values ?? []) {
        if (c.deleted) continue
        out.push({
          path: c.inline?.path,
          line: c.inline?.to,
          body: c.content?.raw ?? '',
          resolved: c.resolution != null,
        })
      }
      url = page.next
    }
    return out
  }
```

(Confirm `prBase` returns `.../pullrequests/{id}`; the comments collection is `${prBase}/comments`. The existing `request` method already throws `BitbucketAuthError` on 401/403 and Error otherwise.)

- [ ] **Step 5: Implement GitHub `listComments`**

`server/src/github/client.ts` — extend the type import to include `ExistingComment`, then add:

```ts
  async listComments(pr: PrRef): Promise<ExistingComment[]> {
    const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
      repository(owner:$owner,name:$repo){ pullRequest(number:$number){
        reviewThreads(first:100, after:$cursor){
          pageInfo{ hasNextPage endCursor }
          nodes{ isResolved path line comments(first:1){ nodes{ body } } }
        } } } }`
    const out: ExistingComment[] = []
    let cursor: string | null = null
    for (;;) {
      const res = await this.request(`${API}/graphql`, {
        method: 'POST',
        body: JSON.stringify({
          query,
          variables: { owner: pr.workspace, repo: pr.repo, number: pr.id, cursor },
        }),
      })
      const json = (await res.json()) as any
      if (json.errors) throw new Error(`GitHub GraphQL error: ${JSON.stringify(json.errors)}`)
      const threads = json.data?.repository?.pullRequest?.reviewThreads
      for (const t of threads?.nodes ?? []) {
        for (const c of t.comments?.nodes ?? []) {
          out.push({ path: t.path ?? undefined, line: t.line ?? undefined, body: c.body ?? '', resolved: !!t.isResolved })
        }
      }
      if (!threads?.pageInfo?.hasNextPage) break
      cursor = threads.pageInfo.endCursor
    }
    return out
  }
```

(`this.request` already sets `Authorization`/`Content-Type` and maps 401/403 to `PrAuthError`; passing the default `accept` is fine for GraphQL.)

- [ ] **Step 6: Run tests + typecheck**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: PASS (all suites, incl. the 3 new listComments tests), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/types.ts server/src/bitbucket/client.ts server/src/github/client.ts server/test/bitbucketClient.test.ts server/test/githubClient.test.ts
git commit -m "feat: listComments (Bitbucket REST + GitHub GraphQL) with resolution state"
```

---

### Task 3: Idempotent + resolution-aware comments route; post-preview route

**Files:**
- Modify: `server/src/app.ts` (comments route rewrite; new post-preview route)
- Test: `server/test/app.test.ts`

**Interfaces:**
- Consumes: `fingerprint`, `commentMarker`, `parseFingerprint` (Task 1); `PrProviderClient.listComments` (Task 2).
- Produces:
  - `POST /api/runs/:id/comments` returns `{ posted: number[], skipped: { index: number; reason: 'already-posted' | 'resolved' }[], failed: { index: number; error: string }[], dedupeChecked: boolean }`.
  - `GET /api/runs/:id/post-preview` returns `{ statuses: { index: number; status: 'new' | 'already-posted' | 'resolved' }[], dedupeChecked: boolean }`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/app.test.ts` (it builds the app with an injected `clientFactory`; give the fake client a `listComments` returning canned existing comments, and a `postInlineComment` that records bodies). Concretely assert:

```ts
it('skips findings whose fingerprint already exists (open → already-posted, resolved → resolved) and appends the marker when posting new ones', async () => {
  // Arrange: a run with 3 findings. Pre-seed a fake client.listComments to return, for the SAME
  // pr, two comments carrying the fingerprints of findings[0] (resolved:false) and findings[1]
  // (resolved:true). findings[2] has no existing comment.
  // Compute expected fingerprints with the real `fingerprint(run.pr, f)` so the test tracks the impl.
  // Act: POST /api/runs/:id/comments with findingIndexes [0,1,2].
  // Assert: skipped contains {index:0,reason:'already-posted'} and {index:1,reason:'resolved'};
  //         posted has exactly one id (for index 2); the body passed to postInlineComment for
  //         index 2 ENDS WITH `\n\n<!-- prr-fp:<fp2> -->`; dedupeChecked === true.
})

it('fails open when listComments throws: posts all, dedupeChecked false', async () => {
  // fake client.listComments rejects; POST comments [0]; assert it still posts, dedupeChecked:false.
})

it('post-preview classifies each finding as new/already-posted/resolved', async () => {
  // same seeding as test 1; GET /api/runs/:id/post-preview;
  // assert statuses: index0 already-posted, index1 resolved, index2 new; dedupeChecked true.
})
```

Fill these in concretely against app.test.ts's existing harness (its `tempConfig...` helpers, `app.inject`, and the `clientFactory` injection). Import `fingerprint` from `../src/review/fingerprint.js` to compute the seed fingerprints so assertions track the implementation rather than hard-coding hashes. Create the run via the store (as other app.test.ts run-fixture tests do) with 3 findings whose `file`/`category`/`summary` you control.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/app.test.ts`
Expected: FAIL — no skipping/marker/dedupeChecked; no post-preview route.

- [ ] **Step 3: Add a shared classify helper + rewrite the comments route**

`server/src/app.ts` — add imports:

```ts
import { fingerprint, commentMarker, parseFingerprint } from './review/fingerprint.js'
```

Add a module-level helper (near the top, after imports) that both routes use:

```ts
/** Reads existing PR comments and returns fp→resolved plus whether the read succeeded. */
async function readExistingFingerprints(
  client: PrProviderClient,
  pr: PrRef,
): Promise<{ fps: Map<string, boolean>; dedupeChecked: boolean }> {
  const fps = new Map<string, boolean>()
  try {
    for (const c of await client.listComments(pr)) {
      const fp = parseFingerprint(c.body)
      if (fp === undefined) continue
      fps.set(fp, (fps.get(fp) ?? false) || c.resolved)
    }
    return { fps, dedupeChecked: true }
  } catch {
    return { fps, dedupeChecked: false }
  }
}
```

Rewrite the comments route body (replace the current `posted`/`failed` loop). The human-readable text builder is unchanged; the marker is appended only on the actual post:

```ts
  app.post('/api/runs/:id/comments', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const { findingIndexes } = req.body as { findingIndexes: number[] }
    const s = store()
    const run = s.get(id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    const c = cfg()
    const client = clientFactory(run.pr, c)
    const { fps, dedupeChecked } = await readExistingFingerprints(client, run.pr)
    const posted: number[] = []
    const skipped: { index: number; reason: 'already-posted' | 'resolved' }[] = []
    const failed: { index: number; error: string }[] = []
    for (const i of findingIndexes) {
      const f = run.findings[i]
      if (!f) continue
      const fp = fingerprint(run.pr, f)
      if (fps.has(fp)) {
        skipped.push({ index: i, reason: fps.get(fp) ? 'resolved' : 'already-posted' })
        continue
      }
      const text =
        `**[${f.severity}/${f.category} · ${f.skills.join(', ')}]** ${f.summary}\n\n${f.detail}\n\n**Suggestion:** ${f.suggestion}` +
        `\n\n${commentMarker(fp)}`
      try {
        const commentId = await client.postInlineComment(run.pr, { path: f.file, line: f.line, text })
        posted.push(commentId)
        run.postedCommentIds.push(commentId)
        s.save(run)
      } catch (err: any) {
        failed.push({ index: i, error: err.message })
        break
      }
    }
    return { posted, skipped, failed, dedupeChecked }
  })
```

- [ ] **Step 4: Add the post-preview route**

Add near the comments route in `server/src/app.ts`:

```ts
  app.get('/api/runs/:id/post-preview', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const run = store().get(id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    const client = clientFactory(run.pr, cfg())
    const { fps, dedupeChecked } = await readExistingFingerprints(client, run.pr)
    const statuses = run.findings.map((f, index) => {
      const fp = fingerprint(run.pr, f)
      const status = !fps.has(fp) ? 'new' : fps.get(fp) ? 'resolved' : 'already-posted'
      return { index, status: status as 'new' | 'already-posted' | 'resolved' }
    })
    return { statuses, dedupeChecked }
  })
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: PASS (all suites incl. the 3 new), tsc clean. If any pre-existing comments-route test asserted the old `{ posted, failed }` shape, update it to include `skipped`/`dedupeChecked`.

- [ ] **Step 6: Commit**

```bash
git add server/src/app.ts server/test/app.test.ts
git commit -m "feat: idempotent + resolution-aware comment posting and post-preview"
```

---

### Task 4: Web — post-preview in the confirm dialog + skipped in results

**Files:**
- Modify: `web/src/api.ts` (`getPostPreview`, extend `PostCommentsResult`)
- Modify: `web/src/pages/RunView.tsx` (confirm dialog statuses; result message)
- Test: `web/test/report.test.ts` (extend `applyPostResult` if its shape changes)

**Interfaces:**
- Consumes: `GET /api/runs/:id/post-preview`, extended `POST .../comments` result (Task 3).
- Produces: confirm dialog labeling New/Already posted/Resolved and posting only `new`.

- [ ] **Step 1: api.ts — new call + extended result type**

`web/src/api.ts` — extend `PostCommentsResult` and add the preview call:

```ts
export interface PostCommentsResult {
  posted: number[]
  skipped: { index: number; reason: 'already-posted' | 'resolved' }[]
  failed: { index: number; error: string }[]
  dedupeChecked: boolean
}

export interface PostPreview {
  statuses: { index: number; status: 'new' | 'already-posted' | 'resolved' }[]
  dedupeChecked: boolean
}

export const getPostPreview = (id: string) =>
  fetch(`/api/runs/${id}/post-preview`).then((r) => json<PostPreview>(r))
```

(`postComments` already parses `json<PostCommentsResult>` — no call change, just the wider type.)

- [ ] **Step 2: Write the failing web test**

`applyPostResult` (in RunView.tsx) now receives a result that includes `skipped`; its message should mention skips. Extend the existing `web/test/report.test.ts` `applyPostResult` cases:

```ts
it('reports skipped counts alongside posted', () => {
  const { message } = applyPostResult(
    [0, 1, 2],
    { posted: [11], skipped: [{ index: 1, reason: 'already-posted' }, { index: 2, reason: 'resolved' }], failed: [], dedupeChecked: true },
    new Set([0, 1, 2]),
  )
  expect(message).toMatch(/Posted 1/)
  expect(message).toMatch(/skipped 2/i)
})
```

- [ ] **Step 3: Run web test to verify it fails**

Run: `cd web && npx vitest run test/report.test.ts`
Expected: FAIL — message has no "skipped" text (and/or the fixture's new fields aren't handled).

- [ ] **Step 4: Update `applyPostResult`**

In `web/src/pages/RunView.tsx`, update `applyPostResult` to append a skipped summary. The `succeededIndexes` logic is unchanged (posting still stops at first failure among the *posted* set); add:

```ts
  const n = result.posted.length
  let message = `Posted ${n} comment${n === 1 ? '' : 's'}.`
  if (result.skipped.length > 0) {
    const already = result.skipped.filter((s) => s.reason === 'already-posted').length
    const resolved = result.skipped.filter((s) => s.reason === 'resolved').length
    const parts = [already ? `${already} already posted` : '', resolved ? `${resolved} resolved` : '']
      .filter(Boolean)
      .join(', ')
    message += ` Skipped ${result.skipped.length} (${parts}).`
  }
  if (result.failed.length > 0) {
    message += ` Failed: ${result.failed.map((f) => `#${f.index} — ${f.error}`).join('; ')}.`
  }
```

- [ ] **Step 5: Confirm dialog uses the preview**

In `web/src/pages/RunView.tsx`'s confirm-dialog flow: when the dialog opens, call `getPostPreview(run.id)` and store `statuses`/`dedupeChecked`. For each selected finding index, look up its status. Render a small badge next to each: `new` → nothing (or a subtle "new"), `already-posted` → muted "already posted", `resolved` → muted "resolved". Only `new` findings are sent to `postComments` (filter the checked set to statuses === 'new' before posting); already-posted/resolved show labeled and excluded. If `dedupeChecked === false`, render all as `new` with a one-line note "Couldn't check the PR for existing comments — nothing will be de-duplicated." Use theme tokens only (e.g. `bg-muted-200 text-muted-foreground`), no hex. Keep unverified-finding selectability and the existing partition/index mapping intact.

- [ ] **Step 6: Run web tests + build**

Run: `cd web && npx vitest run && npm run build`
Expected: PASS, build clean. Update any web test whose `PostCommentsResult` fixture lacks the new fields.

- [ ] **Step 7: Commit**

```bash
git add web
git commit -m "feat: show new/already-posted/resolved in confirm dialog, post only new"
```

---

### Task 5: Docs

**Files:**
- Modify: `README.md`
- Modify: `scripts/smoke.md`

- [ ] **Step 1: README**

Add to the "Review Quality" area (or a new short subsection): posting is idempotent and resolution-aware — each posted comment carries a hidden fingerprint marker; before posting, the tool reads the PR's existing comments and skips any finding already posted (or whose thread the developer resolved), shown as New/Already posted/Resolved in the confirm dialog. Note the two honest limitations (best-effort matching on reworded findings; only our own comments are matched, not arbitrary human threads) and the fail-open behavior.

- [ ] **Step 2: smoke.md**

Add steps: post a finding to a real PR; confirm the comment lands with no visible marker in the rendered comment; re-open the confirm dialog and confirm that finding now shows "already posted" and is excluded; resolve that comment on the PR, re-open the dialog, confirm it shows "resolved"; verify the post result message reads "Posted N · skipped M".

- [ ] **Step 3: Commit**

```bash
git add README.md scripts/smoke.md
git commit -m "docs: document idempotent + resolution-aware comment posting"
```
