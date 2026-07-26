# Review Quality — Dedup + Adversarial Verification — Design

**Date:** 2026-07-26 · Review-engine change. Builds on the per-skill fan-out (2026-07-22) and provider abstraction. First slice of the "enhance the review" track; later slices (reliability/recovery, verdict summary, relevance gating) get their own specs.

## Summary

Raw findings from the per-skill subagents are noisy in two ways: two skills can flag the same issue (duplicates), and individual findings can be plausible-but-wrong (false positives). This change inserts a **dedup → verify → assemble** stage into `executeRun` after the skill fan-out:

1. **Deduplicate** deterministically (same `file:line:category` merges into one finding credited to all flagging skills).
2. **Verify** each deduped finding with its own fresh adversarial subagent, all in parallel (unbounded, matching the skill fan-out).
3. **Assemble**: confirmed findings first, unverified ones kept visible but downgraded with a label and the verifier's reason. Nothing is silently dropped.

## Decisions (confirmed with user)

- **Unverified findings are downgraded and labeled, never hidden** — sorted below confirmed, marked "unverified" with the verifier's one-line reason.
- **One verifier subagent per deduped finding, parallel unbounded** — rigor over cost; dedup-first keeps the verifier count down.
- **Dedup is deterministic** — key `file + line + category`; no LLM dedup pass.
- **Verification is toggleable per run** (New Review checkbox, default ON) so quick/cheap runs can skip it.
- **Fail-open** — a verifier subagent error leaves the finding `confirmed` with a note; verification failures must never demote or lose a real finding.

## Data-shape changes (`server/src/types.ts`, mirrored in `web/src/types.ts`)

```ts
export interface Finding {
  file: string
  line: number
  severity: Severity
  category: string
  summary: string
  detail: string
  suggestion: string
  skills: string[]                     // WAS skill: string — all skills that flagged it
  verdict: 'confirmed' | 'unverified'  // NEW; 'confirmed' when verification is skipped
  verifierReason?: string              // NEW; set when unverified, or noting a verifier error
}
```

Migration notes:
- `FindingSchema` (agent output contract in `findings.ts`) **keeps `skill: string`** — each skill subagent still reports its own name; the fan-out converts to `skills: [unit.name]` during force-attribution. `verdict`/`verifierReason` are NOT part of the agent output contract; they're added by the pipeline (`verdict: 'confirmed'` default at creation).
- `RunRecord` gains `verify: boolean` (what was requested) so the report can say whether findings were verified.
- Old persisted runs (with `skill: string`, no `verdict`) must still load: normalize at read time in `RunStore` (`skill` → `skills: [skill]`, missing `verdict` → `'confirmed'`) or tolerate via optional access in the web — pick the RunStore normalization (single place).
- The posted Bitbucket/GitHub comment text renders `skills.join(', ')`.

## Server changes

### `server/src/review/dedup.ts` (new, pure)
`dedupeFindings(findings: Finding[]): Finding[]` — group by `${file}:${line}:${category}`. Per group: highest severity wins (`high > medium > low > info`); `skills` = union (insertion order, no dupes); `detail` and `suggestion` = the longest of each across the group; `summary` = from the highest-severity member (first wins on tie). Order: first-seen group order preserved.

### `server/src/review/verify.ts` (new)
```ts
verifyFinding(
  finding: Finding,
  ctx: { meta: PrMeta; diff: string; cwd: string; model: string },
  onEvent: (e: RunEvent) => void,
  agentQuery?: AgentQuery,
): Promise<{ verdict: 'confirmed' | 'unverified'; reason?: string }>
```
- Builds an adversarial prompt: the finding (file/line/severity/summary/detail/suggestion), PR title, and the relevant diff; instructs the agent to re-read the actual code (Read/Grep/Glob on the checkout), **try to refute** the finding, answer `confirmed` only if the issue is real and applies to the changed code, else `unverified` with a one-line reason; when uncertain, `unverified`.
- Output contract: a single fenced ```json object `{ "verdict": "confirmed" | "unverified", "reason": "..." }`; parse with a small zod schema + the same last-fenced-block extraction approach as findings; one reformat retry (reuse the pattern from `runReview`, or export a small shared helper — implementer's choice, no behavior change to `runReview`).
- Events it emits are tagged `skill: 'verify'` so the console can show verification activity distinctly.
- **Fail-open**: any error (agent failure, parse failure after retry) → `{ verdict: 'confirmed', reason: 'verifier failed: <msg>' }` — plus an `error`-kind event so the failure is visible in the console.

### `executeRun` (`server/src/app.ts`)
After the fan-out merges findings and skillResults (unchanged):
1. `let findings = dedupeFindings(merged)` — always (cheap, pure).
2. If `body.verify !== false`: emit a status "Verifying N findings…", then `await Promise.all(findings.map(f => verifyFinding(f, ctx, emit, agentQuery).then(v => Object.assign(f, { verdict: v.verdict, verifierReason: v.reason }))))`. Each verifier is already fail-open, so no task rejects.
3. Sort: confirmed before unverified; within each, severity `high → info` (stable, preserves dedup order within the same severity).
4. `run.findings = findings`; `run.verify = body.verify !== false`. Everything else (status computation from skillResults, finally/done) unchanged.

`POST /api/runs` accepts optional `verify?: boolean` in the body and stores it on the run record (default true).

### Tests
- `server/test/dedup.test.ts`: same file+line+category merges (severity max, skills union, longest detail/suggestion); different category same line does NOT merge; different line does NOT merge; order preservation.
- `server/test/verify.test.ts` (fake agentQuery): confirmed verdict parsed; unverified with reason; reformat retry works; agent error → fail-open confirmed with 'verifier failed' reason; events tagged `skill: 'verify'`.
- `server/test/runPipeline.test.ts`: two skills flag the same file/line/category → one merged finding credited to both, verifier called once for it; `verify: false` skips verifiers (agent call count stays at skill count) and all findings are `confirmed`; unverified findings sort after confirmed.
- RunStore normalization test: a legacy run JSON with `skill: string` and no `verdict` loads with `skills: [..]` and `verdict: 'confirmed'`.

## Web changes

- **Types**: mirror `Finding` changes + `RunRecord.verify`.
- **NewReview**: a "Verify findings" checkbox (default checked) near the focus textarea, sent as `verify` on createRun. Persist last choice in localStorage alongside the skill selection.
- **FindingCard**: caption shows `category · skills.join(', ')`; unverified findings get a muted "unverified" Badge and a one-line `verifierReason` under the summary.
- **RunView**: findings arrive pre-sorted (confirmed first); add a compact verification summary line near the skill chips: "N findings · X confirmed · Y unverified" (omit when `verify` was off — show just "N findings · verification skipped"). Selecting unverified findings for posting is allowed (user is the judge).
- **ReviewConsole**: no change needed — verify events arrive tagged `skill: 'verify'` and render with the existing `[verify]` prefix mechanics.

## Cost & failure notes

- With verification on, a run adds one subagent per **deduped** finding (a 20-finding PR ≈ 20 verifier sessions). The default-on checkbox is the opt-out.
- A verifier crash (e.g. expired login) fails open and is visible in the console; it never hides or demotes a finding.

## Out of scope (later slices)
Reliability/recovery (login-expiry guidance, retry-failed-skills), verdict/summary synthesis, relevance gating and cost readouts, LLM semantic dedup.
