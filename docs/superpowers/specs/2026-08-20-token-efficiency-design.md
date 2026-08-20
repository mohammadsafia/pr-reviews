# Token Efficiency Design

**Date:** 2026-08-20
**Status:** Approved design, pending implementation plan

## Problem

A review run's token cost is dominated by structural duplication, not model choice:

- Every selected skill runs in its own agent session, and every session receives the
  **entire PR diff inline** in its prompt (`review/prompt.ts`). Five skills = five copies
  of the diff plus five independent repo explorations.
- Verification spawns **one additional session per deduped finding**, each again carrying
  the full inline diff (`review/verify.ts`). A 20-finding PR adds 20 sessions.
- Every session — review, verify, reformat retries — runs on the single configured main
  model.

Cost is roughly `(skills + findings) × (full diff + exploration)`.

A related quality issue rides along: posted PR comments are long prose without code
examples, so teammates often can't act on them without follow-up questions.

## Goals

1. Stop embedding the diff in prompts; let agents read only the parts they need.
2. Let the user trade thoroughness for cost per run (skill grouping).
3. Verify all findings in one cheap-model session instead of one main-model session each.
4. Make posted comments short, clear, and example-driven.

Non-goals (queued as separate future designs): multi-PR concurrent runs, multi-model
review backends (Codex, Kimi, etc.).

## Architecture Overview

The run lifecycle is unchanged (queue → checkout → review → dedupe → verify → sort →
save). What changes:

```
fetch diff ──► write .pr-review/{diff.patch, pr.md} ──► chunk skills by depth
                                                              │
                                              ┌───────────────┼───────────────┐
                                        session(grp 1)  session(grp 2)  session(grp N)   ← main model
                                              └───────────────┼───────────────┘
                                                        dedupeFindings
                                                              │
                                                    ONE batch-verify session               ← verifyModel
                                                              │
                                                     sort ► save ► render/post
```

Untouched: providers, repo cache, run store, fingerprinting, idempotent/resolution-aware
posting. Touched: `review/` (runner, prompt, verify, findings, plus new modules),
`app.ts` orchestration, `config.ts`, `NewReview.tsx`, `RunView.tsx`.

## Component 1 — Context pack

After `ensureCheckout`, the server deletes and recreates `.pr-review/` inside the
checkout, then writes:

- **`.pr-review/diff.patch`** — the fetched diff, byte-for-byte.
- **`.pr-review/pr.md`** — manifest: PR title, description, branches, and the changed-file
  list with per-file `(+added/-removed)` counts.

Rules:

- Built by pure helpers in `review/contextPack.ts`: `parseDiffStats(diff)` and
  `buildPrManifest(meta, diff)`. No extra API calls.
- `.pr-review/` is added to the cached checkout's `.git/info/exclude` (never the repo's
  tracked `.gitignore`).
- Write or cleanup failure is **fatal to the run** with a clear status event — a run must
  never proceed against a missing or stale pack.

The manifest's per-file line counts let a skill session decide which hunks to even read —
agent-side selectivity is where the savings come from.

## Component 2 — Review prompt & output contract

`buildReviewPrompt` is rewritten to take a **group** of skills and **no diff**. The prompt
points at `.pr-review/pr.md` and `.pr-review/diff.patch`, instructs the agent to read only
the sections relevant to its skills, and restricts findings to files listed in the
manifest on lines changed in the diff.

Output contract changes:

- **`skill` attribution is validated, not overwritten.** `extractFindings` gains a
  `validSkills` parameter; the force-overwrite in `app.ts` is removed. A finding naming a
  skill outside the session's list is reattributed to the group's first skill — a real
  finding is never discarded over a labeling error.
- **New field `example`**: a short fenced before/after snippet (`// before` / `// after`).
  Required by the prompt; optional in `FindingSchema` (`.default('')`) so old stored runs
  and non-compliant outputs still parse.
- **`detail` is capped at two sentences** by prompt instruction.

The findings reformat retry (`REFORMAT_PROMPT`) and the verify reformat retry both move to
`verifyModel` — formatting fixes need no reasoning.

## Component 3 — Depth modes & skill grouping

`POST /api/runs` gains `depth?: 'thorough' | 'balanced' | 'economy'`, stored on
`RunRecord`. When absent, the server falls back to `config.defaultDepth` (see Component
6) — the config value is the single source of the default.

- `groupSkills(skills, depth)` in `review/grouping.ts`: thorough → chunks of 1 (today's
  behavior), balanced → chunks of 3, economy → one chunk.
- Empty skill selection still produces the single synthetic `general` unit, any depth.
- `RunEvent.skill` for a group session is the group label (comma-joined skill names).
- `SkillRunResult` stays **per skill**: a completed group yields one result per member
  skill (count from finding attribution; zero findings = `completed, findingCount: 0`);
  a failed session marks all member skills `failed` with the session's error.
- "Retry failed skills" collects failed skill names exactly as today; the retry run
  re-groups them under the same depth.

## Component 4 — Batched verification

`verify.ts` replaces per-finding `verifyFinding` with `verifyFindingsBatch(findings, ctx)`
— the old per-finding path is deleted, not kept as a fallback.

- One session per run on **`verifyModel`** (new config field, default
  `claude-haiku-4-5-20251001`).
- Prompt: context-pack pointers (no inline diff) + the deduped findings as a numbered JSON
  array + instruction to adversarially re-check each against the real code.
- Output contract: `[{ "index": n, "verdict": "confirmed" | "unverified", "reason": "…" }]`.

Robustness (fail-open — verification must never lose findings):

- Unparseable output → one reformat retry on `verifyModel` → on failure, every finding in
  the batch becomes `confirmed` with reason `verifier failed: …`.
- Missing index → that finding fails open (`confirmed`, "verifier gave no verdict").
- Duplicate indexes: first verdict wins. Unknown indexes: ignored.
- More than 20 findings → sequential chunks of 20; each chunk fails open independently.

## Component 5 — Compact comment formatter

The inline template in `app.ts` moves to a pure `formatComment(finding)` in
`review/comment.ts`:

```markdown
**🔴 High · bug** — <summary>

**Why:** <detail>

<example fenced block, if present>

**Fix:** <suggestion>
<invisible fingerprint marker — unchanged>
```

- Severity emoji: 🔴 high · 🟠 medium · 🟡 low · ℹ️ info.
- Empty `example` → block omitted; comment degrades to summary/why/fix.
- Fingerprint inputs unchanged (file + category + summary), so findings posted by old
  runs still dedupe.

## Component 6 — UI & config

- **`NewReview.tsx`**: "Review depth" radio group (Thorough / Balanced / Economy) with
  one-line cost hints, preselecting `config.defaultDepth`, next to the existing "Verify
  findings" checkbox.
- **`RunView.tsx`**: depth badge near the verify indicator; findings render the `example`
  block in the report and in the post-preview dialog.
- **`config.ts`**: adds `verifyModel` (default `claude-haiku-4-5-20251001`) and
  `defaultDepth` (default `balanced`). Zod defaults mean existing `config.json` files load
  unmigrated. Old stored runs lack `depth`/`example`; both are optional on read.

## Error handling summary

| Failure | Behavior |
|---|---|
| Context pack write/cleanup fails | Run fails early with clear status event |
| Group session fails | All member skills marked `failed`; other groups unaffected |
| Batch verify unparseable | Reformat retry → fail open (`confirmed`, reason recorded) |
| Verdict missing for a finding | That finding fails open |
| Finding names unknown skill | Reattributed to group's first skill |
| Old run without `example`/`depth` | Renders fine; example block omitted |

## Testing

Pure functions + the existing fake-`AgentQuery` harness:

- `parseDiffStats` / `buildPrManifest`: counts, renames, binary files.
- `groupSkills`: each depth × 0/1/3/7 skills; retry re-grouping.
- `extractFindings` with `validSkills`: reattribution; missing `example` default.
- `verifyFindingsBatch`: happy path; missing index; unparseable → retry → fail open;
  chunking at >20.
- `formatComment`: each severity; with/without example; marker preserved.
- `executeRun` integration: balanced grouping → per-skill results; failed group marks all
  members; **assert the review prompt contains pack pointers and not diff content**.

## Expected impact

Typical run (5 skills, 15 findings, Balanced): today ≈ 20 diff-carrying main-model
sessions → after ≈ 2 review sessions + 1 cheap verify session, none with an inline diff.
