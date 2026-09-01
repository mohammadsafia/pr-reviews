# Skill Test-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a skill author paste a `SKILL.md`'s draft content and run it against a real PR, without saving to disk first — results render on the existing `RunView` page, never post to the real PR, and never appear in the main Runs list.

**Architecture:** A test run is a real `RunRecord` tagged `isTest: true`, executed by a new `executeTestRun` (a narrower sibling of `executeRun` — no depth grouping, no verify, no auto-submit) and filtered out of `GET /api/runs`. Reusing the existing `RunRecord`/SSE/`RunView` machinery means no new streaming or results-display code; two guards (server-side comment-posting rejection, client-side hidden posting UI) make a test run's findings unpostable.

**Tech Stack:** TypeScript, Vitest, Fastify (server); React, React Router (web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-skill-test-run-design.md`

## Global Constraints

- A test run's skill name comes from the pasted content's frontmatter (`parseFrontmatter`), falling back to `"test"` — never a separate manual name field.
- Test runs never run verify and never auto-submit.
- Test runs are rejected by `POST /api/runs/:id/comments` server-side, regardless of what the UI shows — the client hiding the posting UI is not the only guard.
- `GET /api/runs` excludes `isTest` runs; `GET /api/runs/:id` and the SSE events route resolve them normally (only the list view hides them).
- Every new field is optional; a run recorded before this feature renders exactly as it does today.

---

### Task 1: `RunRecord` fields, `sortFindings` extraction, `parseFrontmatter` export

**Files:**
- Modify: `server/src/types.ts` (`RunRecord`)
- Modify: `web/src/types.ts` (`RunRecord`)
- Modify: `server/src/review/findings.ts` (new `sortFindings`)
- Modify: `server/src/app.ts` (`executeRun` uses the extracted helper)
- Modify: `server/src/skills/scanner.ts` (export `parseFrontmatter`)
- Test: `server/test/findings.test.ts`, `server/test/scanner.test.ts`

**Interfaces:**
- Produces: `RunRecord.isTest?: boolean`, `RunRecord.testSkillContent?: string`; `sortFindings(findings: Finding[]): Finding[]` (exported from `review/findings.js`); `parseFrontmatter(md: string): Record<string, string>` (exported from `skills/scanner.js`). Task 2 consumes all three.

- [ ] **Step 1: Add the fields to the server `RunRecord` type**

In `server/src/types.ts`, add to `RunRecord` (after `usage?: ...`):

```ts
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
  /** True for a run created via the skill test-run flow (an ad-hoc, unsaved skill tested
   * against a real PR) rather than a normal review. Excluded from GET /api/runs so test
   * iterations don't clutter run history; still individually fetchable by id. */
  isTest?: boolean
  /** The exact skill content that was tested, present only when isTest is true — lets a
   * later look at a test run show precisely what wording produced its findings. */
  testSkillContent?: string
}
```

- [ ] **Step 2: Mirror the fields on the web `RunRecord` type**

In `web/src/types.ts`, same addition to `RunRecord` (after `usage?: ...`):

```ts
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
  /** True for a run created via the skill test-run flow. Excluded from the Runs list. */
  isTest?: boolean
  /** The exact skill content that was tested, present only when isTest is true. */
  testSkillContent?: string
}
```

- [ ] **Step 3: Write the failing test for `sortFindings`**

Add to `server/test/findings.test.ts` (check the existing imports at the top of the file
and add `sortFindings` to the import from `'../src/review/findings.js'`):

```ts
describe('sortFindings', () => {
  const f = (overrides: Partial<import('../src/types.js').Finding> = {}) => ({
    file: 'a.ts',
    line: 1,
    severity: 'low' as const,
    category: 'style',
    summary: 's',
    detail: 'd',
    suggestion: 'x',
    skills: ['s'],
    verdict: 'confirmed' as const,
    ...overrides,
  })

  it('sorts confirmed findings before unverified ones, regardless of severity', () => {
    const input = [f({ severity: 'low', verdict: 'confirmed' }), f({ severity: 'high', verdict: 'unverified' })]
    const out = sortFindings(input)
    expect(out[0].verdict).toBe('confirmed')
    expect(out[1].verdict).toBe('unverified')
  })

  it('within the same verdict, sorts high severity before low', () => {
    const input = [f({ severity: 'low' }), f({ severity: 'high' }), f({ severity: 'medium' })]
    const out = sortFindings(input)
    expect(out.map((x) => x.severity)).toEqual(['high', 'medium', 'low'])
  })
})
```

- [ ] **Step 4: Run the tests and verify they fail**

Run: `cd server && npx vitest run test/findings.test.ts -t "sortFindings"`
Expected: FAIL — `Cannot find module` or `sortFindings is not a function` (not yet exported).

- [ ] **Step 5: Extract `sortFindings` in `findings.ts`**

Add to `server/src/review/findings.ts` (after `extractFindings`, before `countDiffLines`):

```ts
const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 }

/** Confirmed findings sort before unverified ones regardless of severity; within each
 * verdict, higher severity sorts first. Mutates and returns the input array (matches the
 * in-place .sort() this replaces at its one call site). */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((a, b) => {
    if (a.verdict !== b.verdict) return a.verdict === 'confirmed' ? -1 : 1
    return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
  })
}
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `cd server && npx vitest run test/findings.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 7: Use the extracted helper in `executeRun`**

In `server/src/app.ts`, find:

```ts
      const RANK: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 }
      findings.sort((a, b) => {
        if (a.verdict !== b.verdict) return a.verdict === 'confirmed' ? -1 : 1
        return RANK[b.severity] - RANK[a.severity]
      })
```

and replace it with:

```ts
      sortFindings(findings)
```

Add `sortFindings` to the existing import of `countDiffLines` from `./review/findings.js`:

```ts
import { countDiffLines, sortFindings } from './review/findings.js'
```

- [ ] **Step 8: Export `parseFrontmatter` in `scanner.ts`**

In `server/src/skills/scanner.ts`, change:

```ts
function parseFrontmatter(md: string): Record<string, string> {
```

to:

```ts
export function parseFrontmatter(md: string): Record<string, string> {
```

- [ ] **Step 9: Write a direct test for `parseFrontmatter`**

Add to `server/test/scanner.test.ts` (add `parseFrontmatter` to the existing import from
`'../src/skills/scanner.js'`):

```ts
describe('parseFrontmatter', () => {
  it('parses name/description/category out of YAML frontmatter', () => {
    const md = '---\nname: my-skill\ndescription: does things\ncategory: review\n---\nbody'
    expect(parseFrontmatter(md)).toEqual({ name: 'my-skill', description: 'does things', category: 'review' })
  })

  it('returns an empty object when there is no frontmatter block', () => {
    expect(parseFrontmatter('just a body, no frontmatter')).toEqual({})
  })
})
```

- [ ] **Step 10: Run the full server test suite and typecheck**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS, no errors. `executeRun`'s existing sort-order assertions in
`runPipeline.test.ts` keep passing unchanged — `sortFindings` is a pure extraction, not a
behavior change.

- [ ] **Step 11: Typecheck the web package**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add server/src/types.ts web/src/types.ts server/src/review/findings.ts server/src/app.ts server/src/skills/scanner.ts server/test/findings.test.ts server/test/scanner.test.ts
git commit -m "feat: isTest run fields, extract sortFindings, export parseFrontmatter"
```

---

### Task 2: `executeTestRun`, `POST /api/skills/test-run`, `GET /api/runs` filtering

**Files:**
- Modify: `server/src/app.ts`
- Test: `server/test/runPipeline.test.ts`

**Interfaces:**
- Consumes: `sortFindings`, `parseFrontmatter` from Task 1.
- Produces: `POST /api/skills/test-run` (body `{ url, skillContent, profile?, force? }`, returns `{ id }` at 202, same shape as `POST /api/runs`). `GET /api/runs` excludes `isTest` runs.

- [ ] **Step 1: Import `parseFrontmatter`**

In `server/src/app.ts`, add to the existing import from `./skills/scanner.js`:

```ts
import { parseFrontmatter, readSkillContent, scanSkillDirs } from './skills/scanner.js'
```

- [ ] **Step 2: Write the failing integration test — happy path**

Add to `server/test/runPipeline.test.ts`, inside `describe('run pipeline integration', ...)`,
after the "persists parentRunId..." test:

```ts
  it('runs a test-run session with a single ad-hoc skill, skips verify, and tags isTest', async () => {
    const path = tempConfig()
    const diff = '+line1\n'
    const finding = {
      file: 'a.txt',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 's',
      detail: 'd',
      suggestion: 'x',
      skill: 'draft-skill',
    }
    let verifyWasAsked = false
    const agent: AgentQuery = async function* (prompt) {
      if (/adversarially verifying/.test(prompt)) {
        verifyWasAsked = true
        yield { type: 'result' as const, ok: true, text: '```json\n[]\n```' }
        return
      }
      yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const skillContent = '---\nname: draft-skill\ndescription: d\n---\nDraft body under test'
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/skills/test-run',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skillContent },
    })
    expect(createRes.statusCode).toBe(202)
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    expect(run.isTest).toBe(true)
    expect(run.testSkillContent).toBe(skillContent)
    expect(run.skills).toEqual(['draft-skill'])
    const { skill: _skill, ...findingRest } = finding
    expect(run.findings).toEqual([{ ...findingRest, example: '', skills: ['draft-skill'], verdict: 'confirmed' }])
    expect(verifyWasAsked).toBe(false)
  })

  it('defaults the skill name to "test" when the pasted content has no frontmatter', async () => {
    const path = tempConfig()
    const diff = '+line1\n'
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgent([]),
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/skills/test-run',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skillContent: 'no frontmatter here' },
    })
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.skills).toEqual(['test'])
  })

  it('excludes test runs from GET /api/runs but still resolves them by id', async () => {
    const path = tempConfig()
    const diff = '+line1\n'
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgent([]),
    })
    const testRes = await app.inject({
      method: 'POST',
      url: '/api/skills/test-run',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skillContent: '---\nname: t\n---\nbody' },
    })
    const testId = testRes.json().id
    await pollRun(app, testId)

    const realRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/2', skills: [] },
    })
    const realId = realRes.json().id
    await pollRun(app, realId)

    const list = (await app.inject({ method: 'GET', url: '/api/runs' })).json()
    expect(list.map((r: any) => r.id)).toContain(realId)
    expect(list.map((r: any) => r.id)).not.toContain(testId)

    const fetched = await app.inject({ method: 'GET', url: `/api/runs/${testId}` })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.json().isTest).toBe(true)
  })
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `cd server && npx vitest run test/runPipeline.test.ts -t "test-run"`
Expected: FAIL — `POST /api/skills/test-run` doesn't exist yet (404).

- [ ] **Step 4: Add `executeTestRun`**

In `server/src/app.ts`, add this function right after `executeRun`'s closing brace (before
the `app.get('/api/runs/:id/events', ...)` route):

```ts
  async function executeTestRun(
    runId: string,
    ctx: { pr: PrRef; meta: PrMeta; diff: string; skillContent: string; profile?: string },
  ): Promise<void> {
    let s: RunStore | undefined
    let run: RunRecord | undefined
    let cache: RepoCache | undefined
    try {
      const c = cfg()
      s = store()
      run = s.get(runId)
      if (!run) return
      const emit = (e: RunEvent) => {
        run!.transcript.push(e)
        s!.save(run!)
        events.emit(runId, e)
      }
      run.status = 'running'
      s.save(run)
      emit({ kind: 'status', text: 'Preparing repository checkout…', at: new Date().toISOString() })
      const client = clientFactory(ctx.pr, c)
      cache = new RepoCache(c.cacheDir)
      const cwd = await cache.ensureWorktree(ctx.pr, {
        cloneUrl: client.cloneUrl(ctx.pr, c.cloneProtocol),
        sourceBranch: ctx.meta.sourceBranch,
        commit: ctx.meta.sourceCommit,
        runId,
      })
      emit({ kind: 'status', text: 'Writing review context…', at: new Date().toISOString() })
      writeContextPack(cwd, ctx.meta, ctx.diff)
      const skillName = parseFrontmatter(ctx.skillContent).name ?? 'test'
      emit({ kind: 'status', text: `Testing skill "${skillName}"…`, at: new Date().toISOString() })
      const profile = profileById(c, ctx.profile)
      const query = agentQuery ?? queryFactory(profile)
      const findings = await runReview(
        {
          meta: ctx.meta,
          skills: [{ name: skillName, content: ctx.skillContent }],
          cwd,
          query,
          reformatQuery: query,
        },
        emit,
      )
      run.skills = [skillName]
      run.findings = sortFindings(findings)
      run.status = 'completed'
    } catch (err: any) {
      if (s && run) {
        run.status = 'failed'
        run.error = err.message
        const errorEvent: RunEvent = { kind: 'error', text: err.message, at: new Date().toISOString() }
        run.transcript.push(errorEvent)
        events.emit(runId, errorEvent)
      }
    } finally {
      if (cache) {
        try {
          await cache.removeWorktree(ctx.pr, runId)
        } catch (err: any) {
          if (run)
            run.transcript.push({
              kind: 'status',
              text: `Worktree cleanup failed: ${err.message}`,
              at: new Date().toISOString(),
            })
        }
      }
      if (s && run) {
        run.finishedAt = new Date().toISOString()
        s.save(run)
      }
      events.emit(runId, { kind: 'done' })
    }
  }
```

- [ ] **Step 5: Add the route**

Add this route right after the existing `app.post('/api/runs', ...)` route (before
`async function executeRun`):

```ts
  app.post('/api/skills/test-run', async (req, reply) => {
    const body = req.body as { url: string; skillContent: string; profile?: string; force?: boolean }
    const c = cfg()
    let pr: PrRef
    try {
      pr = parsePrUrl(body.url)
    } catch (err: any) {
      return reply.code(400).send({ error: err.message })
    }
    const client = clientFactory(pr, c)
    let meta: PrMeta
    let diff: string
    try {
      meta = await client.getPullRequest(pr)
      diff = await client.getDiff(pr)
    } catch (err: any) {
      const code = err instanceof PrAuthError ? 401 : 502
      return reply.code(code).send({ error: err.message })
    }
    const diffLines = countDiffLines(diff)
    if (diffLines > c.diffWarnLines && !body.force) {
      return reply.code(409).send({
        error: `Diff has ${diffLines} changed lines (threshold ${c.diffWarnLines}). Re-submit with force to proceed.`,
        diffLines,
      })
    }
    if (body.profile !== undefined && !c.modelProfiles.some((p) => p.id === body.profile)) {
      return reply.code(400).send({ error: `Unknown model profile: ${body.profile}` })
    }
    const run = store().create({
      pr,
      prTitle: meta.title,
      skills: [],
      verify: false,
      isTest: true,
      testSkillContent: body.skillContent,
      status: 'queued',
    })
    runQueue.push(() => executeTestRun(run.id, { pr, meta, diff, skillContent: body.skillContent, profile: body.profile }))
    return reply.code(202).send({ id: run.id })
  })
```

- [ ] **Step 6: Filter test runs out of the list route**

Change:

```ts
  app.get('/api/runs', async () => store().list())
```

to:

```ts
  app.get('/api/runs', async () => store().list().filter((r) => !r.isTest))
```

- [ ] **Step 7: Run the tests and verify they pass**

Run: `cd server && npx vitest run test/runPipeline.test.ts`
Expected: PASS, all tests including the three new ones.

- [ ] **Step 8: Run the full server test suite and typecheck**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 9: Commit**

```bash
git add server/src/app.ts server/test/runPipeline.test.ts
git commit -m "feat: skill test-run endpoint and execution path"
```

---

### Task 3: Reject posting on a test run

**Files:**
- Modify: `server/src/app.ts`
- Test: `server/test/app.test.ts`

**Interfaces:**
- Consumes: `RunRecord.isTest` from Task 1.

`server/test/app.test.ts` already exercises `POST /api/runs/:id/comments` at the route
level by creating a `RunRecord` directly via `RunStore.create()` (bypassing the review
pipeline entirely — see `'POST /api/runs/:id/comments saves posted ids incrementally...'`,
the first test in that file to hit this route) rather than running a fake agent through
it. This new test follows that exact pattern — no pipeline, no polling.

- [ ] **Step 1: Write the failing test**

Add to `server/test/app.test.ts`, in the `describe('app', ...)` block, directly after the
existing `'POST /api/runs/:id/comments saves posted ids incrementally...'` test:

```ts
  it('rejects posting comments on a test run', async () => {
    const path = tempConfig()
    const c = loadConfig(path)
    const runStore = new RunStore(c.runsDir)
    const run = runStore.create({
      pr: { provider: 'bitbucket', workspace: 'ws', repo: 'repo', id: 1 },
      prTitle: 'T',
      skills: ['draft-skill'],
      verify: false,
      isTest: true,
      testSkillContent: '---\nname: draft-skill\n---\nbody',
      status: 'completed',
    })
    run.findings = [
      {
        file: 'a.ts',
        line: 1,
        severity: 'low',
        category: 'style',
        summary: 's',
        detail: 'd',
        suggestion: 'x',
        skills: ['draft-skill'],
        verdict: 'confirmed',
      },
    ]
    runStore.save(run)

    const app = buildApp({ configPath: path })
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/comments`,
      payload: { findingIndexes: [0] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/test run/i)
  })
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd server && npx vitest run test/app.test.ts -t "rejects posting comments on a test run"`
Expected: FAIL — no `clientFactory` is passed to `buildApp` here (unlike the neighboring
test), so without the guard this currently throws inside `postFindingComments` when it
tries to build a real provider client, rather than returning a clean 400. Either failure
mode confirms the guard doesn't exist yet; if the test errors instead of asserting cleanly,
that's still the expected "fails for the right reason" — the guard must return *before*
`clientFactory` is ever called.

- [ ] **Step 3: Add the guard**

In `server/src/app.ts`'s `POST /api/runs/:id/comments` handler, change:

```ts
  app.post('/api/runs/:id/comments', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const { findingIndexes } = req.body as { findingIndexes: number[] }
    const s = store()
    const run = s.get(id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    const c = cfg()
    const client = clientFactory(run.pr, c)
    return postFindingComments(client, run, findingIndexes, (r) => s.save(r))
  })
```

to:

```ts
  app.post('/api/runs/:id/comments', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const { findingIndexes } = req.body as { findingIndexes: number[] }
    const s = store()
    const run = s.get(id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    if (run.isTest) return reply.code(400).send({ error: 'Cannot post comments from a test run.' })
    const c = cfg()
    const client = clientFactory(run.pr, c)
    return postFindingComments(client, run, findingIndexes, (r) => s.save(r))
  })
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd server && npx vitest run test/app.test.ts -t "rejects posting comments on a test run"`
Expected: PASS.

- [ ] **Step 5: Run the full server test suite and typecheck**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/app.ts server/test/app.test.ts
git commit -m "feat: reject comment posting on a test run"
```

---

### Task 4: `TestSkill.tsx` page, API call, route, Settings entry point

**Files:**
- Modify: `web/src/api.ts` (`createTestRun`)
- Create: `web/src/pages/TestSkill.tsx`
- Modify: `web/src/router.tsx`
- Modify: `web/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: `getConfig()`/`Config.modelProfiles`/`Config.reviewProfile` (existing).
- Produces: `createTestRun(input): Promise<{ id?: string; error?: string; diffLines?: number; status: number }>` — same result shape `createRun` already returns, so `TestSkill.tsx` can reuse the same success/oversized-diff handling pattern `NewReview.tsx` already has.

No new unit tests — presentational, matching this project's established convention.
Verification is typecheck + build + full test suite.

- [ ] **Step 1: Add `createTestRun` to `api.ts`**

In `web/src/api.ts`, add after `createRun`:

```ts
export async function createTestRun(input: {
  url: string
  skillContent: string
  profile?: string
  force?: boolean
}): Promise<{ id?: string; error?: string; diffLines?: number; status: number }> {
  try {
    const res = await fetch('/api/skills/test-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    let body: any = {}
    try {
      body = await res.json()
    } catch {
      body = { error: `Server returned a non-JSON response (HTTP ${res.status})` }
    }
    return { ...body, status: res.status }
  } catch (err: any) {
    return { error: err?.message ?? 'Network error', status: 0 }
  }
}
```

- [ ] **Step 2: Create `TestSkill.tsx`**

Create `web/src/pages/TestSkill.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import { createTestRun, getConfig } from '../api.js'
import type { ModelProfile } from '../types.js'

export function TestSkill() {
  const navigate = useNavigate()
  const [url, setUrl] = useState('')
  const [skillContent, setSkillContent] = useState('')
  const [profile, setProfile] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [error, setError] = useState('')
  const [oversized, setOversized] = useState<{ diffLines: number } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getConfig()
      .then((c) => {
        setProfiles(c.modelProfiles)
        setProfile((cur) => cur ?? c.reviewProfile)
      })
      .catch(() => {})
  }, [])

  async function submit(force = false) {
    setBusy(true)
    setError('')
    setOversized(null)
    try {
      const res = await createTestRun({ url, skillContent, profile: profile ?? undefined, force })
      if (res.id) {
        navigate(`/runs/${res.id}`)
        return
      }
      if (res.status === 409 && res.diffLines !== undefined) {
        setOversized({ diffLines: res.diffLines })
        return
      }
      setError(res.error ?? 'Failed to start test run')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Test a skill</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Try a skill's draft wording against a real PR before saving it to disk. Results never post to the PR
          and won't appear in Runs history.
        </p>
      </div>

      <Card shadow="sm">
        <Card.Content className="flex flex-col gap-5 pt-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="test-pr-url">Pull request URL</Label>
            <Textarea
              id="test-pr-url"
              className="min-h-10 text-sm"
              placeholder="https://bitbucket.org/workspace/repo/pull-requests/123"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="test-skill-content">Skill content (SKILL.md)</Label>
            <Textarea
              id="test-skill-content"
              className="font-family-mono min-h-64 text-sm"
              placeholder={'---\nname: my-skill\ndescription: what it checks\n---\n\nReview instructions…'}
              value={skillContent}
              onChange={(e) => setSkillContent(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Review model</Label>
            <Select value={profile ?? undefined} onValueChange={setProfile}>
              <Select.Trigger>
                <Select.Value placeholder="Loading…" />
              </Select.Trigger>
              <Select.Content>
                {profiles.map((p) => (
                  <Select.Item key={p.id} value={p.id}>
                    {p.label} · {p.kind}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>

          <Button disabled={busy || !url || !skillContent} onClick={() => submit()}>
            {busy ? 'Running…' : 'Run test'}
          </Button>

          {error && <p className="text-destructive text-sm">{error}</p>}
          {oversized && (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <Alert.Description className="flex flex-col gap-2">
                <span>{oversized.diffLines} changed lines — this may be slow and costly.</span>
                <Button variant="secondary" size="sm" className="w-fit" disabled={busy} onClick={() => submit(true)}>
                  Run anyway
                </Button>
              </Alert.Description>
            </Alert>
          )}
        </Card.Content>
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: Add the route**

In `web/src/router.tsx`, add the import:

```ts
import { TestSkill } from './pages/TestSkill.js'
```

and the route entry (after `{ path: 'settings', element: <Settings /> },`):

```ts
      { path: 'settings', element: <Settings /> },
      { path: 'skills/test', element: <TestSkill /> },
```

- [ ] **Step 4: Add the entry point in Settings**

In `web/src/pages/Settings.tsx`, find the Skills tab's Card header:

```tsx
        <Tabs.Content value="skills">
      <Card shadow="sm">
        <Card.Header>
          <Card.Title>Skill sources</Card.Title>
        </Card.Header>
```

Change the `Card.Header` to a flex row with a link to the new page:

```tsx
        <Tabs.Content value="skills">
      <Card shadow="sm">
        <Card.Header className="flex flex-row items-center justify-between">
          <Card.Title>Skill sources</Card.Title>
          <Button asChild variant="secondary" size="sm">
            <Link to="/skills/test">Test skill</Link>
          </Button>
        </Card.Header>
```

Add the needed imports at the top of `Settings.tsx` if not already present — check the
existing import block first; `Button` and `Link` are very likely already imported
elsewhere in this file (it already uses buttons throughout), in which case only add
what's missing:

```ts
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
```

- [ ] **Step 5: Run the full web test suite, typecheck, and build**

Run: `cd web && npm test && npm run build`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/pages/TestSkill.tsx web/src/router.tsx web/src/pages/Settings.tsx
git commit -m "feat(ui): add the Test skill page, route, and Settings entry point"
```

---

### Task 5: Hide posting/retry on `RunView` for test runs

**Files:**
- Modify: `web/src/pages/RunView.tsx`
- Modify: `web/src/components/FindingCard.tsx`

**Interfaces:**
- Consumes: `RunRecord.isTest` from Task 1, `POST /api/skills/test-run` results from Task 2.

No new unit tests — presentational, matching this project's established convention.

- [ ] **Step 1: Add a `selectable` prop to `FindingCard`**

In `web/src/components/FindingCard.tsx`, add `selectable` to the props (default `true` so
every existing call site is unaffected):

```tsx
export function FindingCard({
  finding,
  index,
  checked,
  onToggle,
  isNew,
  selectable = true,
}: {
  finding: Finding
  index: number
  checked: boolean
  onToggle: (index: number) => void
  isNew?: boolean
  selectable?: boolean
}) {
```

Wrap the `Checkbox` render in the `selectable` check:

```tsx
        {selectable && (
          <Checkbox
            checked={checked}
            onCheckedChange={() => onToggle(index)}
            className="mt-1 shrink-0"
            aria-label={`Select finding at ${location}`}
          />
        )}
```

- [ ] **Step 2: Add a "Test run" badge and hide Retry buttons**

In `web/src/pages/RunView.tsx`, change the header:

```tsx
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{run.prTitle}</h1>
            <StatusBadge status={run.status} />
          </div>
          <div className="flex shrink-0 gap-2">
            {run.status === 'failed' && (
              <Button variant="secondary" size="sm" onClick={retry}>
                Retry run
              </Button>
            )}
            {failed.length > 0 && (run.status === 'completed' || run.status === 'failed') && (
              <Button variant="secondary" size="sm" onClick={retryFailedSkills}>
                Retry failed skills ({failed.length})
              </Button>
            )}
          </div>
```

to:

```tsx
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{run.prTitle}</h1>
            <StatusBadge status={run.status} />
            {run.isTest && (
              <Badge variant="warning" size="xs">
                Test run
              </Badge>
            )}
          </div>
          {!run.isTest && (
            <div className="flex shrink-0 gap-2">
              {run.status === 'failed' && (
                <Button variant="secondary" size="sm" onClick={retry}>
                  Retry run
                </Button>
              )}
              {failed.length > 0 && (run.status === 'completed' || run.status === 'failed') && (
                <Button variant="secondary" size="sm" onClick={retryFailedSkills}>
                  Retry failed skills ({failed.length})
                </Button>
              )}
            </div>
          )}
```

- [ ] **Step 3: Hide the checkbox column and the floating post bar**

Change the `FindingCard` usage:

```tsx
                          <FindingCard
                            key={index}
                            finding={finding}
                            index={index}
                            checked={checked.has(index)}
                            onToggle={toggleFinding}
                            isNew={newFindingKeys.has(`${finding.file}|${finding.category}|${finding.summary}`)}
                          />
```

to:

```tsx
                          <FindingCard
                            key={index}
                            finding={finding}
                            index={index}
                            checked={checked.has(index)}
                            onToggle={toggleFinding}
                            isNew={newFindingKeys.has(`${finding.file}|${finding.category}|${finding.summary}`)}
                            selectable={!run.isTest}
                          />
```

Change the floating "Post to PR…" bar's guard:

```tsx
      {checked.size > 0 && (
```

to:

```tsx
      {!run.isTest && checked.size > 0 && (
```

- [ ] **Step 4: Run the full web test suite, typecheck, and build**

Run: `cd web && npm test && npm run build`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/RunView.tsx web/src/components/FindingCard.tsx
git commit -m "feat(ui): hide posting and retry affordances on test runs"
```
