# Reliability & Recovery (Login-Expiry Banner + Retry Failed Skills) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the run view, detect an expired-Claude-login failure and show an actionable "re-authenticate and retry" banner, and add a "Retry failed skills" button that starts a new run scoped to just the skills that failed.

**Architecture:** Pure, unit-tested web helpers (`web/src/lib/runErrors.ts`) classify errors and compute the failed-skill set from data the run already carries. `RunView.tsx` renders a `warning` Alert when a login-expiry is detected and a "Retry failed skills (N)" button that calls the existing `createRun` with the failed-skill subset. No server changes.

**Tech Stack:** Vite + React 18, TypeScript strict, Vitest (web). Kit `Alert` (has a `warning` variant), `Button`.

**Spec:** `docs/superpowers/specs/2026-07-27-reliability-recovery-design.md`

## Global Constraints

- TypeScript `"strict": true`. Web tests: `cd web && npx vitest run`; build: `npm run build`. Both green before each commit.
- No server changes; no new dependencies. Reuse existing `createRun` and `Alert`/`Button` components; theme tokens only (no hardcoded hex).
- Login-expiry signatures (case-insensitive): `failed to authenticate` OR `oauth session expired` OR `could not be refreshed`. Generic errors must NOT match.
- `failedSkillNames` excludes the synthetic `general` unit (it isn't a selectable skill name); dedupes; preserves order.
- Retry re-uses the existing URL rebuild + `createRun({ url, skills, focus, verify, force: true })` pattern, scoping `skills` to the failed set.
- Conventional commits; commit after each green cycle.

---

### Task 1: Pure helpers `web/src/lib/runErrors.ts`

**Files:**
- Create: `web/src/lib/runErrors.ts`
- Test: `web/test/runErrors.test.ts`

**Interfaces:**
- Consumes: `RunRecord` from `../src/types.js` (has `error?: string`, `skills: string[]`, `skillResults: { skill: string; status: 'completed' | 'failed'; findingCount: number; error?: string }[]`, `pr`, `focus?`, `verify`).
- Produces:
  - `isLoginExpiryError(text: string | undefined): boolean`
  - `failedSkillNames(run: RunRecord): string[]`
  - `runHasLoginExpiry(run: RunRecord): boolean`

- [ ] **Step 1: Write the failing test**

`web/test/runErrors.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isLoginExpiryError, failedSkillNames, runHasLoginExpiry } from '../src/lib/runErrors.js'
import type { RunRecord } from '../src/types.js'

const baseRun = (over: Partial<RunRecord>): RunRecord => ({
  id: 'r1',
  pr: { provider: 'bitbucket', workspace: 'w', repo: 'r', id: 1 },
  prTitle: 'T',
  skills: ['review-code', 'audit-a11y'],
  status: 'failed',
  createdAt: '2026-07-27T00:00:00.000Z',
  findings: [],
  transcript: [],
  postedCommentIds: [],
  skillResults: [],
  verify: true,
  ...over,
})

describe('isLoginExpiryError', () => {
  it('matches the three login-expiry signatures, any casing', () => {
    expect(isLoginExpiryError('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true)
    expect(isLoginExpiryError('oauth session EXPIRED')).toBe(true)
    expect(isLoginExpiryError('token Could Not Be Refreshed')).toBe(true)
  })
  it('rejects generic errors and undefined', () => {
    expect(isLoginExpiryError('Bitbucket API error 502')).toBe(false)
    expect(isLoginExpiryError('git clone failed: repository not found')).toBe(false)
    expect(isLoginExpiryError(undefined)).toBe(false)
  })
})

describe('failedSkillNames', () => {
  it('returns only failed selected skills, drops general, dedupes, preserves order', () => {
    const run = baseRun({
      skills: ['review-code', 'audit-a11y'],
      skillResults: [
        { skill: 'review-code', status: 'failed', findingCount: 0, error: 'x' },
        { skill: 'audit-a11y', status: 'completed', findingCount: 2 },
        { skill: 'general', status: 'failed', findingCount: 0, error: 'x' }, // not a selected skill → dropped
        { skill: 'review-code', status: 'failed', findingCount: 0, error: 'x' }, // dupe → collapsed
      ],
    })
    expect(failedSkillNames(run)).toEqual(['review-code'])
  })
  it('returns [] when nothing failed', () => {
    expect(failedSkillNames(baseRun({ skillResults: [{ skill: 'review-code', status: 'completed', findingCount: 1 }] }))).toEqual([])
  })
})

describe('runHasLoginExpiry', () => {
  it('true when a skillResult error looks like login expiry', () => {
    expect(runHasLoginExpiry(baseRun({ skillResults: [{ skill: 'review-code', status: 'failed', findingCount: 0, error: 'OAuth session expired' }] }))).toBe(true)
  })
  it('true when the run-level error looks like login expiry', () => {
    expect(runHasLoginExpiry(baseRun({ error: 'Failed to authenticate' }))).toBe(true)
  })
  it('false for generic failures', () => {
    expect(runHasLoginExpiry(baseRun({ error: 'All 2 skill reviews failed', skillResults: [{ skill: 'review-code', status: 'failed', findingCount: 0, error: 'git clone failed' }] }))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run test/runErrors.test.ts`
Expected: FAIL — cannot find module `../src/lib/runErrors.js`.

- [ ] **Step 3: Implement**

`web/src/lib/runErrors.ts`:

```ts
import type { RunRecord } from '../types.js'

const LOGIN_EXPIRY = /failed to authenticate|oauth session expired|could not be refreshed/i

export function isLoginExpiryError(text: string | undefined): boolean {
  return text !== undefined && LOGIN_EXPIRY.test(text)
}

export function failedSkillNames(run: RunRecord): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of run.skillResults) {
    if (r.status !== 'failed') continue
    if (!run.skills.includes(r.skill)) continue // drops the synthetic "general" unit
    if (seen.has(r.skill)) continue
    seen.add(r.skill)
    out.push(r.skill)
  }
  return out
}

export function runHasLoginExpiry(run: RunRecord): boolean {
  return isLoginExpiryError(run.error) || run.skillResults.some((r) => isLoginExpiryError(r.error))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run test/runErrors.test.ts && npm run build`
Expected: PASS (7 tests), build clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/runErrors.ts web/test/runErrors.test.ts
git commit -m "feat: pure helpers for login-expiry detection and failed-skill names"
```

---

### Task 2: RunView — login-expiry banner + retry-failed-skills button

**Files:**
- Modify: `web/src/pages/RunView.tsx`
- Test: manual (verified via build + a brief render check; the logic is covered by Task 1's unit tests)

**Interfaces:**
- Consumes: `isLoginExpiryError`, `failedSkillNames`, `runHasLoginExpiry` (Task 1); existing `createRun`, `navigate`, the run's `retry()` pattern.
- Produces: UI only.

Current relevant code in `RunView.tsx`:
- Imports (lines 1–11) include `Alert`, `Button`, `AlertTriangle` from lucide, `createRun`, `useNavigate`.
- An existing `retry()` async function rebuilds the PR URL (`github.com/.../pull/{id}` vs `bitbucket.org/.../pull-requests/{id}`) and calls `createRun({ url, skills: run.skills, focus: run.focus, verify: run.verify, force: true })` then `navigate(...)`.
- The "Skill runs" chips render in a block gated by `run.skillResults.length > 0` (around line 278).
- The failed-run Alert (`run.status === 'failed'`) at ~line 313 contains `<span>{run.error}</span>` and a "Retry run" `<Button ... onClick={retry}>`.

- [ ] **Step 1: Add a `retryFailedSkills` handler**

In `RunView.tsx`, next to the existing `retry()` function, add (reusing the same URL rebuild):

```tsx
  async function retryFailedSkills() {
    if (!run) return
    const url =
      run.pr.provider === 'github'
        ? `https://github.com/${run.pr.workspace}/${run.pr.repo}/pull/${run.pr.id}`
        : `https://bitbucket.org/${run.pr.workspace}/${run.pr.repo}/pull-requests/${run.pr.id}`
    const res = await createRun({
      url,
      skills: failedSkillNames(run),
      focus: run.focus,
      verify: run.verify,
      force: true,
    })
    if (res.id) navigate(`/runs/${res.id}`)
  }
```

- [ ] **Step 2: Add the import**

At the top of `RunView.tsx`, add:

```tsx
import { failedSkillNames, runHasLoginExpiry } from '@/lib/runErrors'
```

(`isLoginExpiryError` isn't needed directly in the component — `runHasLoginExpiry` wraps it.)

- [ ] **Step 3: Render the login-expiry banner**

Immediately before the `run.skillResults.length > 0` "Skill runs" block (~line 278), add — so it appears for both failed and partial-completed runs:

```tsx
      {runHasLoginExpiry(run) && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <Alert.Title>Your Claude login appears to have expired</Alert.Title>
          <Alert.Description>
            The review agent authenticates with your Claude login. Re-authenticate (run{' '}
            <code>/login</code>, or restart the tool with a valid <code>ANTHROPIC_API_KEY</code>), then retry.
          </Alert.Description>
        </Alert>
      )}
```

- [ ] **Step 4: Add "Retry failed skills" to the failed-run Alert**

In the `run.status === 'failed'` Alert's `Alert.Description` (currently just the error span + "Retry run" button), wrap the buttons in a row and add the scoped-retry button, shown only when there are failed named skills:

```tsx
          <Alert.Description className="flex flex-col gap-2">
            <span>{run.error}</span>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" className="w-fit" onClick={retry}>
                Retry run
              </Button>
              {failedSkillNames(run).length > 0 && (
                <Button variant="secondary" size="sm" className="w-fit" onClick={retryFailedSkills}>
                  Retry failed skills ({failedSkillNames(run).length})
                </Button>
              )}
            </div>
          </Alert.Description>
```

- [ ] **Step 5: Surface "Retry failed skills" on a partial (completed) run too**

A partial run (`status === 'completed'` but some skills failed — e.g. login expired for 2 of 3) has no failed-run Alert. Add, right after the login-expiry banner block from Step 3 (so it shows whenever there are failed skills, independent of the login-expiry banner):

```tsx
      {run.status === 'completed' && failedSkillNames(run).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-sm">
            {failedSkillNames(run).length} skill{failedSkillNames(run).length === 1 ? '' : 's'} failed on this run.
          </span>
          <Button variant="secondary" size="sm" className="w-fit" onClick={retryFailedSkills}>
            Retry failed skills ({failedSkillNames(run).length})
          </Button>
        </div>
      )}
```

- [ ] **Step 6: Run web build + suite**

Run: `cd web && npx vitest run && npm run build`
Expected: all existing tests still pass (52), build clean.

- [ ] **Step 7: Manual render check (best-effort)**

If dev servers / playwright-cli are reachable, seed two mock runs and verify light + dark: (a) a `failed` run whose skillResults errors contain `OAuth session expired` → warning banner + "Run failed" Alert with both "Retry run" and "Retry failed skills (N)" buttons; (b) a `completed` run with one failed skill (generic error) → no login banner, but the "N skills failed … Retry failed skills (1)" row appears. Only kill dev-server PIDs you spawned; never `pkill -f vite`. If not reachable, note it and rely on the build + Task 1 unit tests.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/RunView.tsx
git commit -m "feat: login-expiry banner and retry-failed-skills in run view"
```

---

### Task 3: Docs

**Files:**
- Modify: `README.md`
- Modify: `scripts/smoke.md`

- [ ] **Step 1: README**

Add a short "Recovery" note (near the review-run description): if the Claude login expires mid-run the run view shows a "your login appears to have expired — re-authenticate and retry" banner; and any run with failed skills offers "Retry failed skills," which starts a new run scoped to just those skills (the successful skills' findings stay in the original run).

- [ ] **Step 2: smoke.md**

Add a step: with an expired/exited Claude login, run a review; confirm the run view shows the login-expiry banner (not just a raw error) and a "Retry failed skills (N)" button; re-authenticate, click it, and confirm a new run starts scoped to only the previously-failed skills.

- [ ] **Step 3: Commit**

```bash
git add README.md scripts/smoke.md
git commit -m "docs: document login-expiry recovery and retry-failed-skills"
```
