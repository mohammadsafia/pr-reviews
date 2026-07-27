# Reliability & Recovery — Login-Expiry Banner + Retry Failed Skills — Design

**Date:** 2026-07-27 · Web-only slice (no server changes). Part of the "enhance the review" track; the concrete slice motivated by a real run that failed with `Failed to authenticate: OAuth session expired and could not be refreshed` across all skill subagents.

## Summary

Two recovery affordances in the run view, both pure-web, building on data the run already carries (`run.error`, `run.skillResults[].error/status`):

1. **Login-expiry banner** — when a skill's error looks like an expired Claude login (not a generic failure), show a distinct, actionable Alert telling the user to re-authenticate and retry, instead of only the raw error text.
2. **Retry failed skills** — when a run has ≥1 failed *real* skill, a button that starts a **new run scoped to just the failed skills** (same PR / focus / verify), so one flaky or expired skill doesn't cost the work the successful skills already produced.

No server changes: detection is presentation over existing fields, and retry reuses the existing `createRun` path with a skills subset.

## Decisions (confirmed with user)

- **Retry model = new run scoped to the failed skills** (not merge-into-same-run, not re-run-everything). Simplest, reuses the pipeline; the originally-successful skills' findings stay in the first run.

## Pure helpers (`web/src/lib/runErrors.ts`, unit-tested)

```ts
// Matches the known Claude-login-expiry signatures, case-insensitively; must NOT match generic errors.
export function isLoginExpiryError(text: string | undefined): boolean
  // true iff text matches /failed to authenticate/i OR /oauth session expired/i OR /could not be refreshed/i

// The real, selected skills that failed on this run (excludes the synthetic "general" unit,
// which is not a selectable skill name). Deduped, order preserved.
export function failedSkillNames(run: RunRecord): string[]
  // = run.skillResults.filter(r => r.status === 'failed' && run.skills.includes(r.skill)).map(r => r.skill), deduped

// True iff any skillResults error OR the run-level error looks like a login expiry.
export function runHasLoginExpiry(run: RunRecord): boolean
  // = isLoginExpiryError(run.error) || run.skillResults.some(r => isLoginExpiryError(r.error))
```

Tests: `isLoginExpiryError` matches each of the three signatures (any casing) and rejects generic messages (`"Bitbucket API error 502"`, `"git clone failed"`, `undefined`); `failedSkillNames` returns only failed selected skills and drops `general`, dedupes, preserves order; `runHasLoginExpiry` true when either a skillResult error or `run.error` matches, false otherwise.

## RunView changes (`web/src/pages/RunView.tsx`)

### 1. Login-expiry banner
When `runHasLoginExpiry(run)` — regardless of whether the run is `failed` (all skills failed) or `completed` (partial: some skills auth-failed) — render a warning Alert near the top of the run body (above the "Skill runs" chips):

> **Your Claude login appears to have expired.** The review agent authenticates with your Claude login. Re-authenticate (run `/login`, or restart the tool with a valid `ANTHROPIC_API_KEY`), then retry.

Use `variant="destructive"` (the kit has destructive/success; reuse destructive with the `AlertTriangle` icon, matching the existing failed-run Alert) — or a warning styling if a warning variant exists; do not introduce hardcoded colors. This banner is shown IN ADDITION to the existing per-skill error chips. The existing "Run failed" Alert (for `status === 'failed'`) stays; when the failure is login-expiry the banner gives the actionable guidance the generic "Run failed / {run.error}" doesn't.

### 2. Retry failed skills
Compute `const failed = failedSkillNames(run)` once. When `failed.length > 0`, render a **"Retry failed skills (N)"** button (N = `failed.length`). Placement: alongside the existing retry affordance — in the failed-run Alert next to "Retry run", and also surfaced when the run is a partial `completed` (so a partially-auth-failed completed run can retry its failed skills). Its handler mirrors the existing `retry()` but scopes skills to the failed set:

```ts
async function retryFailedSkills() {
  if (!run) return
  const url = run.pr.provider === 'github'
    ? `https://github.com/${run.pr.workspace}/${run.pr.repo}/pull/${run.pr.id}`
    : `https://bitbucket.org/${run.pr.workspace}/${run.pr.repo}/pull-requests/${run.pr.id}`
  const res = await createRun({ url, skills: failedSkillNames(run), focus: run.focus, verify: run.verify, force: true })
  if (res.id) navigate(`/runs/${res.id}`)
}
```

The existing "Retry run" (all skills) button is unchanged and remains for the fully-failed case and the no-named-skills `general` case (where `failedSkillNames` is empty → the "Retry failed skills" button isn't shown).

## Out of scope
- Server-side auth detection or a preflight login check (this slice is presentation + a scoped re-run).
- Merging retried results back into the original run (explicitly rejected in favor of a new run).
- Detecting non-auth transient failures specially (generic errors keep the existing plain display).
- The workflow/output (verdict summary) and speed/cost (relevance-gating) slices — separate, not yet designed.
