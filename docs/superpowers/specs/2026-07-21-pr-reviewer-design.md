# PR Reviewer — Design

**Date:** 2026-07-21
**Status:** Approved design, pending implementation plan

## Summary

A personal, local GUI tool. Paste a Bitbucket Cloud pull-request URL, select which review skills to apply, and an AI agent (Claude Agent SDK) reviews the PR against a real checkout of the repo. Results render as a structured findings report in the browser; selected findings can optionally be posted back to the PR as inline Bitbucket comments.

**Non-goals (v1):** multi-user/hosted deployment, Jira-ticket input, GitHub/GitLab support, auto-posting comments without confirmation, editing code.

## Users & constraints

- Single user (the author), running on their Mac.
- Uses the author's own Bitbucket credentials (email + API token) and Claude authentication.
- Skills already exist in external repos (e.g. `forge-skills`); the tool must consume them without copying.

## Architecture

One repository, two packages:

```
pr-reviewer/
├── server/          # Node 20+, TypeScript, Fastify
│   ├── bitbucket/   #   PR URL parser + Bitbucket Cloud REST 2.0 client
│   ├── repos/       #   repo cache manager (shallow clone / fetch / checkout)
│   ├── review/      #   agent runner (Claude Agent SDK) + findings parser
│   ├── skills/      #   skill directory scanner (multiple configured roots)
│   └── store/       #   run persistence (one JSON file per run)
└── web/             # Vite + React SPA, served by the server in prod mode
```

### Review run flow

1. User pastes `https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>`, ticks skills, optionally adds a free-text focus note, and clicks **Run Review**.
2. Server validates the URL, then fetches PR metadata and the diff via the Bitbucket API.
3. Repo cache: shallow-clone into `~/.pr-reviewer/repos/<workspace>/<repo>` if absent; fetch source and destination branches; check out the PR head commit (detached HEAD).
4. Agent runner starts a Claude Agent SDK session:
   - `cwd` = the checkout
   - read-only tools only (Read, Grep, Glob) — no Write/Edit/Bash
   - prompt contains: PR title/description, the diff, the focus note, and the **full content of each selected skill's SKILL.md** injected as mandatory review instructions (deterministic — selected skills always apply; no reliance on model-side skill triggering)
   - final output contract: a JSON findings array (see Data shapes)
5. Agent progress (assistant text, tool-use events) streams to the browser over SSE.
6. Server parses/validates the findings JSON, persists the run, and the UI renders the report.
7. User selects findings → **Post to Bitbucket** → confirmation screen showing the exact comments → server creates inline PR comments via the API.

### Skills

- Settings hold an ordered list of skill directories (default seeds: `~/Desktop/projects/forge-skills/skills`, `~/.claude/skills`).
- The scanner lists any subdirectory containing a `SKILL.md`, reading `name`/`description` from frontmatter for display.
- The GUI groups checkboxes by source directory. Selection is per run; the last selection is remembered as the default for the next run.

### Data shapes

**Finding** (agent output contract, validated server-side):

```json
{
  "file": "src/pages/members/MembersPage.tsx",
  "line": 42,
  "severity": "high | medium | low | info",
  "category": "bug | security | performance | a11y | rtl | style | convention",
  "summary": "One-sentence statement of the issue",
  "detail": "Explanation with reasoning",
  "suggestion": "Concrete fix (may include a code snippet)",
  "skill": "review-code"
}
```

**Run record** (`~/.pr-reviewer/runs/<id>.json`): PR reference, selected skills, status (`running | completed | failed`), timestamps, findings, full agent transcript, posted-comment IDs.

### Configuration

`~/.pr-reviewer/config.json`, editable via the Settings screen:

- Bitbucket email + API token (token stored in the file with `0600` permissions; acceptable for a single-user local tool)
- Skill directory list
- Model choice (default: latest Sonnet-class model; Opus/Fable selectable for hard reviews)
- Clone cache location (default `~/.pr-reviewer/repos`)
- Diff-size warning threshold (default 8,000 changed lines)

## UI / UX

Three screens:

1. **New Review (home)** — URL input, skill checkboxes grouped by source, focus note, Run button; recent runs listed below with status badges.
2. **Run view** — live activity feed during the run (current tool activity, agent commentary, elapsed time), transitioning into the report: findings grouped by severity, each with clickable `file:line`, detail, suggestion; per-finding checkboxes and *Post selected to Bitbucket* with a confirmation step.
3. **Settings** — credentials, skill directories, model, cache location, per-repo cache clear.

## Error handling

- **Invalid URL** — inline validation before submission.
- **Bitbucket 401/403** — actionable message distinguishing bad token from missing repo access; link to Settings.
- **Clone/fetch failure** — raw git stderr shown in the run view; retry button; per-repo cache clear in Settings.
- **Agent failure or malformed findings** — one automatic "reformat as JSON" retry; on final failure the run is saved as `failed` with the full transcript retained for diagnosis.
- **Oversized diff** — warning with token-cost note and explicit "proceed anyway", not a hard block.
- **Concurrent runs** — v1 allows one active run at a time; a second submission is queued with visible status.

## Testing

- **Unit tests** (Vitest): PR URL parsing, Bitbucket response mapping, findings validation, skill directory scanning, comment-payload construction.
- **Integration test**: repo cache operations against a local fixture git repository (no network).
- **Smoke script** (manual, on demand): end-to-end review of a tiny fixture PR to verify the agent pipeline after changes.
- The agent itself is not unit-tested; failures are diagnosed from persisted transcripts.

## Future (explicitly out of scope for v1)

- Jira ticket input (resolve linked PRs; use ticket description as review context)
- Team deployment / integration into the ai-native-sdlc platform
- Tauri wrapper for a native window
- Agent-chosen skill selection
