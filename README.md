# PR Reviewer

A personal local GUI tool for reviewing Bitbucket Cloud pull requests with Claude. Paste a PR URL, select review skills, and a Claude agent analyzes the PR against a real repository checkout. Findings render in the browser with inline commenting capability—selected findings can be posted back as comments on the PR after explicit confirmation.

The UI is a dark-first dashboard: compose reviews on the home page, monitor concurrent runs under Runs, and manage connections/models/skills in Settings (light theme available via the sidebar toggle).

## Prerequisites

- **Node.js** 20 or higher
- **git** (for repository cloning and operations)
- **Claude Code login** OR `ANTHROPIC_API_KEY` environment variable — or any other configured model profile (see Model Profiles below)
- **Bitbucket API token** with scopes: `pullrequest:read`, `pullrequest:write`, `repository:read`
- **SSH key configured for bitbucket.org** (default clone method; HTTPS with API token selectable in Settings)

## Quick Start

1. Install dependencies in both `server/` and `web/`:
   ```bash
   cd server && npm install
   cd ../web && npm install
   ```

2. Start the application at the repo root:
   ```bash
   npm start
   ```

3. Open http://127.0.0.1:5175 in your browser

4. **Configure Settings first**: enter your Bitbucket email and API token (Claude authentication comes from your Claude Code login or ANTHROPIC_API_KEY environment variable).

5. Paste one or more PR URLs (one per line) on the Home page, select review skills, and Run Review

## Review Quality

Each review run deduplicates findings across selected skills — when multiple skills flag the same issue on the same file and line, they merge into a single finding credited to all reporters. By default, the deduped findings are then verified adversarially: all findings are checked together in a single agent session per run (chunked at 20 findings per session), running on a cheaper model configurable via `verifyModel` in the config (default `claude-haiku-4-5-20251001`). Unverified findings are shown in the report with a "unverified" badge and a one-line reason — they are never hidden. A "Verify findings" checkbox on the New Review screen lets you toggle verification per run; disabling it makes runs faster and cheaper.

### Review Depth & Cost

The New Review screen offers three review depths controlling how selected skills are grouped into agent sessions: **Thorough** (one skill per session — highest quality, highest cost), **Balanced** (groups of 3 skills per session — the default, configurable via `defaultDepth`), and **Economy** (all skills in one session — cheapest). Additionally, the PR diff is no longer embedded in agent prompts: it is written to `.pr-review/diff.patch` inside the repo checkout (alongside a `.pr-review/pr.md` manifest of changed files), and agents read only the sections relevant to their skills — a large PR no longer pays for its full diff in every session.

### Model Profiles

Each run picks its review model from profiles managed in Settings. Three kinds:

- **claude** — the Claude Agent SDK, using your Claude Code login or `ANTHROPIC_API_KEY` (the two built-in defaults: Sonnet for review, Haiku for verification/reformatting).
- **cli** — any agentic CLI you are logged into, run once per review session. Example Codex profile command line: `codex exec --sandbox read-only --cd {cwd} -` (`{cwd}` is replaced with the checkout path; with no `{prompt}` placeholder the prompt arrives on stdin). CLI profiles must carry their own sandbox/read-only flags — the tool cannot inject restrictions into a foreign CLI.
- **openai** — any OpenAI-compatible API by base URL + key (e.g. Kimi via `https://api.moonshot.ai/v1`). The tool executes the model's `read_file`/`grep`/`list_files` calls locally, confined to the repo checkout.

The New Review screen has a "Review model" picker (defaulting to the Settings-level review profile); the verify model is a Settings-level global.

### Auto-Posting

An opt-in "Auto-post findings" option posts findings to the PR automatically when a run completes — filtered by a severity threshold (high / medium+ / all) and an optional confirmed-only toggle. Posting is fingerprint-idempotent (re-runs never double-comment) and fail-closed: if existing PR comments cannot be read, nothing is auto-posted and findings stay in the report for manual review. Failed runs never auto-post.

### Concurrent Runs

Runs execute concurrently up to `maxConcurrentRuns` (config, default 2); excess runs queue and start as slots free. Each run checks out into its own disposable git worktree under `~/.pr-reviewer/repos/.worktrees/`, so several PRs of the same repository can be reviewed at once without interfering — the shared base clone only serializes the brief git clone/fetch phase. Worktrees are removed when their run finishes and swept at startup after a crash. The New Review screen accepts multiple PR URLs (one per line) and starts one run per URL with the same skills, depth, and verification settings.

### Idempotent and Resolution-Aware Comment Posting

Posted comments use a compact template: a severity-emoji header, a short "Why" (at most two sentences), a before/after code example when the finding has one, and a "Fix" line. When posting findings back to a PR as comments, the tool is idempotent and resolution-aware. Each posted comment carries an invisible HTML comment fingerprint marker. Before posting, the tool reads the PR's existing comments and automatically skips any finding that has already been posted or whose thread the developer has resolved. In the confirm dialog, each selected finding is labeled **New**, **Already posted**, or **Resolved** and only New findings are posted. The result message reports "Posted N. Skipped M (X already posted, Y resolved)."

If reading the PR's comments fails, the tool falls back gracefully: nothing is de-duplicated and posting proceeds as normal (the dialog shows a "couldn't verify comments" note).

Two honest limitations: finding matching is best-effort and relies on the invisible fingerprint marker, so a reworded finding will have a different fingerprint and may re-post; resolution-awareness only applies to comments posted by the tool itself (marked with the fingerprint), not arbitrary developer discussions in unrelated threads.

### Recovery

If your Claude login expires mid-run (e.g., Claude Code session expires or `ANTHROPIC_API_KEY` becomes invalid), a distinct banner appears alongside the error, telling you to re-authenticate and retry: "Your Claude login appears to have expired — re-authenticate (run `/login` or restart with a valid `ANTHROPIC_API_KEY`), then retry." The usual error display (the "Run failed" alert and per-skill error chips) still shows too — the banner is an addition, not a replacement.

Additionally, any run with one or more failed skills offers a "Retry failed skills (N)" button that starts a new run scoped to only those skills. The originally successful skills' findings remain in the first run; you don't re-analyze what already passed. This is especially useful when transient failures (like a temporary network hiccup in a subagent) cause skill timeouts on an otherwise good PR.

## Data Locations

- **Config:** `~/.pr-reviewer/config.json` (0600 permissions—credentials)
- **Repository Cache:** `~/.pr-reviewer/repos/` (cloned repos for analysis; per-run worktrees under `.worktrees/`)
- **Run History:** `~/.pr-reviewer/runs/` (review results and findings)

## Development

For local development, run the server and web dev servers in parallel:

```bash
# Terminal 1: Server dev mode
cd server && npm run dev

# Terminal 2: Web dev mode
cd web && npm run dev
```

The web dev server proxies API calls to http://127.0.0.1:5175 (the server). For production, `npm start` at the repo root builds the web bundle and serves it from the server on port 5175.

## Documentation

See [docs/superpowers/specs/2026-07-21-pr-reviewer-design.md](docs/superpowers/specs/2026-07-21-pr-reviewer-design.md) for the full design document.

## Testing

Run all tests (server + web):
```bash
npm test
```

## Smoke Testing

For end-to-end testing instructions with a real Bitbucket PR, see [scripts/smoke.md](scripts/smoke.md).
