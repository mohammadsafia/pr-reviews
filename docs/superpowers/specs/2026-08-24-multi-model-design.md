# Multi-Model Review Backend Design

**Date:** 2026-08-24
**Status:** Approved design, pending implementation plan

## Problem

Reviews run only on Claude via `@anthropic-ai/claude-agent-sdk` (`sdkQuery` in
`server/src/review/runner.ts`), with model ids as plain config strings (`model`,
`verifyModel`). There is no way to review with Codex, Kimi, or any other provider, and no
way to route a given run to a chosen model. Separately, posting findings to the PR always
requires the manual confirm dialog — there is no automation for routine runs.

## Goals

1. **Per-run model choice**: each run picks its review model from user-managed profiles;
   one model reviews per run (no ensemble).
2. Three integration mechanisms: the Claude SDK (as today), agentic CLIs the user is
   logged into (Codex CLI first; Gemini/Copilot CLIs are just more config entries), and
   OpenAI-compatible APIs by base URL + key (Kimi/Moonshot, OpenAI, DeepSeek…).
3. **Auto-submit**: an opt-in per-run option that posts filtered findings to the PR
   automatically on completion — severity threshold + confirmed-only toggle.

Non-goals: ensemble/cross-model verification of a single run; per-run verify-model choice
(the verify profile stays a Settings-level global); provider-native comment posting.

## Component 1 — Model-profile registry & config

A **model profile** is a config entry, stored as `modelProfiles: ModelProfile[]`:

```ts
type ModelProfile =
  | { id: string; label: string; kind: 'claude'; model: string }
  | { id: string; label: string; kind: 'cli'; command: string; args: string[]; timeoutMs?: number }
  | { id: string; label: string; kind: 'openai'; baseUrl: string; apiKey: string; model: string }
```

`id` is a unique user-chosen slug referenced everywhere a model is chosen; `label` is the
display name. `cli.args` entries may contain `{prompt}` and `{cwd}` placeholders.

`ConfigSchema` additions:

```ts
modelProfiles: z.array(ModelProfileSchema).default([
  { id: 'claude-sonnet', label: 'Claude Sonnet', kind: 'claude', model: 'claude-sonnet-5' },
  { id: 'claude-haiku',  label: 'Claude Haiku',  kind: 'claude', model: 'claude-haiku-4-5-20251001' },
])
reviewProfile: z.string().default('claude-sonnet')  // default review model for new runs
verifyProfile: z.string().default('claude-haiku')   // takes over verifyModel's role
```

**Migration.** The legacy `model` and `verifyModel` string fields stay in the schema
(deprecated). Post-parse in `loadConfig`: if `modelProfiles` parsed to the default AND the
stored `model`/`verifyModel` differ from their defaults, synthesize claude-kind profiles
from them (and point `reviewProfile`/`verifyProfile` at them) so tuned settings never
silently reset. A dangling `reviewProfile`/`verifyProfile` reference resolves to the first
claude-kind profile, else the first profile; the resolver is a pure
`profileById(config, id): ModelProfile` that never throws.

**Secrets.** `GET /api/config` masks each openai profile's `apiKey` with the existing
`***` MASK convention; `PUT /api/config` restores the stored key (matched by profile `id`)
when the masked value comes back — the same mechanism as `bitbucketToken`/`githubToken`.

**Settings UI.** A "Model profiles" section: profile list with kind badges; add/edit/
delete forms per kind (claude: model id; cli: command + args as one text line, split on
spaces, `{prompt}`/`{cwd}` documented; openai: base URL, key, model); two dropdowns for
the default review and verify profiles. Deleting a referenced profile is blocked with a
message.

## Component 2 — Three adapters behind AgentQuery

All adapters implement the existing `AgentQuery` iterable interface, so `runner.ts`,
`verify.ts`, and every fake keep working. The `opts` argument becomes
`{ cwd: string; profile: ModelProfile }`; `server/src/models/resolve.ts` exposes
`queryFor(profile): AgentQuery`.

**`claude` (`server/src/models/claude.ts`)** — today's `sdkQuery` moved verbatim out of
`runner.ts`, reading `profile.model`. Read-only tool enforcement unchanged.

**`cli` (`server/src/models/cli.ts`)** — spawns `profile.command` with `profile.args`,
substituting `{cwd}` → worktree path and `{prompt}` → prompt text; when no arg contains
`{prompt}`, the prompt is written to stdin (avoids ARG_MAX on huge prompts; the built-in
Codex example uses stdin). Streams stdout as `{type:'assistant', text}` events (rate-
capped so chatty CLIs don't bloat transcripts); exit 0 → result text = full stdout;
non-zero exit → `{type:'result', ok:false, text: stderr tail}`. `timeoutMs` (default
15 min) kills a hung CLI. **Trust model:** tool restrictions cannot be injected into a
foreign CLI — the profile's own flags must carry them (the documented Codex example
includes `--sandbox read-only`).

**`openai` (`server/src/models/openai.ts`)** — a chat-completions function-calling loop
against `profile.baseUrl` using plain `fetch` (no SDK dependency). Three locally-executed
tools: `read_file(path, offset?, limit?)`, `grep(pattern, glob?)` (via `git grep` in the
worktree), `list_files(glob)`. Paths resolve against the worktree and are rejected if
they escape it (the `relative()` guard pattern from `RepoCache.clear`); reads capped at
~2000 lines / 50KB. The loop ends when the model stops calling tools or at 40 iterations;
the last assistant text is the result. Tool calls stream as `{type:'assistant', tool}`
events.

Reformat retries and batch verification work across kinds automatically — they are just
more `AgentQuery` calls with the verify profile.

## Component 3 — Orchestration & per-run choice

- `POST /api/runs` gains `profile?: string` (profile id). Unknown id → 400; absent →
  `config.reviewProfile`. Stored as `RunRecord.reviewProfile` (optional for legacy runs).
- `executeRun` resolves both profiles up front (`profileById` + `queryFor`) and threads
  `AgentQuery` values: review groups on the review query; batch verify and both reformat
  retries on the verify query.
- `runReview` and `verifyFindingsBatch` take resolved `AgentQuery` values
  (`runReview({ …, query, reformatQuery })`) instead of model-name strings — the runner
  no longer knows about model names; profiles are an orchestration concern.
- Test seams: the existing `deps.agentQuery` override applies to both queries (existing
  tests unchanged); a new optional `deps.queryFactory?: (profile: ModelProfile) =>
  AgentQuery` lets tests assert per-profile routing.
- **New Review UI**: a "Review model" dropdown (profile labels, preselecting
  `config.reviewProfile`, persisted per-browser like depth) posted as `profile`. The run
  view shows the profile label as a badge; retry and retry-failed-skills reuse the
  original run's profile. Batch submission applies the one chosen profile to every URL.
- The verify profile stays global (Settings), not per-run.

## Component 4 — Auto-submit

**Options.** New Review gains "Auto-post findings to the PR" (default off). When checked:
a severity threshold dropdown — `high` / `medium` (= medium+, default) / `all` — and a
"Confirmed only" toggle (default on). Stored on the run as
`autoSubmit?: { threshold: 'high' | 'medium' | 'all'; confirmedOnly: boolean }` (absent =
off); persisted per-browser.

**Flow.** The posting loop inside `POST /api/runs/:id/comments` is extracted to a shared
`postFindingComments(client, run, indexes, store)` helper used by the route and by
auto-submit. In `executeRun`, after the run reaches `completed` with findings:

1. Filter: severity within threshold (`high` → {high}, `medium` → {high, medium}, `all` →
   every severity); `verdict === 'confirmed'` when `confirmedOnly`.
2. Post via the shared helper — fingerprint idempotency applies, so re-runs and
   subsequent manual posting never double-comment, and dev-resolved threads stay skipped.
3. Record the outcome as a transcript status event ("Auto-posted 3 comments. Skipped 1
   (already posted).") and append ids to `run.postedCommentIds`.

**Safety rails:** fires only on `completed` runs; a posting failure is a transcript
event, never a run failure; if reading existing comments fails (dedupe unknown),
auto-submit posts NOTHING — fail-closed, unlike the manual dialog where a human sees the
warning. Documented interaction: with "Verify findings" off, every finding is `confirmed`
by definition, so confirmed-only filters nothing; the UI hints this when auto-submit is
on and verify is off. The run view shows the auto-post result line under the findings
summary.

## Error handling

| Failure | Behavior |
|---|---|
| Unknown `profile` id on POST /api/runs | 400 naming the bad id |
| Referenced profile deleted before a queued run starts | `profileById` fallback; transcript status notes the substitution |
| CLI missing / crash / non-zero exit | Run or verify chunk fails with stderr tail; verify still fails open |
| CLI hang | Killed at `timeoutMs` (default 15 min) → failure |
| openai HTTP error / bad key | Failure with status + body snippet; the key is never echoed |
| openai path escapes worktree | Tool call answers with an error message; loop continues |
| openai iteration ceiling (40) | Last assistant text used; a parse failure then follows the normal reformat retry |
| Malformed JSON from any model | Existing reformat retry on the verify profile |
| Deleting a referenced profile | Blocked in Settings with a message |
| Auto-submit post failure / dedupe-read failure | Transcript event; dedupe-read failure posts nothing (fail-closed); run status untouched |

## Testing

- `server/test/cliModel.test.ts`: fake executables (`node -e` fixtures) — stdout
  collection, `{prompt}` arg vs stdin delivery, `{cwd}` substitution, non-zero exit →
  `ok:false` with stderr, timeout kill.
- `server/test/openaiModel.test.ts`: stubbed `fetch` — tool-call round trip against a
  fixture dir, path-escape rejection, iteration ceiling, HTTP error mapping, streamed
  tool events.
- `server/test/config.test.ts`: profile schema defaults; legacy `model`/`verifyModel`
  migration synthesis; dangling-reference fallback. `app.test.ts`: per-profile apiKey
  masking round-trip through the config routes.
- `server/test/runPipeline.test.ts`: `queryFactory` routes review vs verify to the right
  profiles; unknown profile → 400; deleted-profile fallback; auto-submit posts the
  filtered set through a fake client (threshold × confirmedOnly), fail-closed on
  dedupe-read failure, never fires on failed runs.
- `postFindingComments` unit tests (the extracted route loop).
- Web: profile dropdown state/persistence (depth-selector pattern); auto-submit options
  through `submitBatch` opts.

## Build collaboration & phasing

The implementation plan phases the work: **Phase 1** — profiles, claude+cli adapters,
orchestration, UI (unlocks Codex immediately); **Phase 2** — the openai adapter (unlocks
Kimi et al.); **Phase 3** — auto-submit. The plan directs the executor to use the
`codex-delegate` skill at two points: reviewing the openai tool-loop implementation
(OpenAI function-calling contract) and validating the default Codex CLI profile args
against real `codex exec` behavior.

## Expected impact

Routine PRs can run on a cheap or free-quota model (Codex CLI login, Kimi API) with
Claude reserved for critical reviews; provider onboarding is config, not code (CLI kind:
a command line; openai kind: base URL + key). Auto-submit removes the manual posting step
for trusted configurations while fingerprint idempotency and fail-closed dedupe keep it
safe.
