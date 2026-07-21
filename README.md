# PR Reviewer

A personal local GUI tool for reviewing Bitbucket Cloud pull requests with Claude. Paste a PR URL, select review skills, and a Claude agent analyzes the PR against a real repository checkout. Findings render in the browser with inline commenting capability—selected findings can be posted back as comments on the PR after explicit confirmation.

## Prerequisites

- **Node.js** 20 or higher
- **git** (for repository cloning and operations)
- **Claude Code login** OR `ANTHROPIC_API_KEY` environment variable (for Claude API access)
- **Bitbucket API token** with scopes: `pullrequest:read`, `pullrequest:write`, `repository:read`

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

4. **Configure Settings first**: Enter your Bitbucket email, API token, and Claude API credentials

5. Paste a Bitbucket Cloud PR URL on the Home page, select review skills, and Run Review

## Data Locations

- **Config:** `~/.pr-reviewer/config.json` (0600 permissions—credentials)
- **Repository Cache:** `~/.pr-reviewer/repos/` (cloned PRs for analysis)
- **Run History:** `~/.pr-reviewer/runs/` (review results and findings)

## Development

For local development, run the server and web dev servers in parallel:

```bash
# Terminal 1: Server dev mode
cd server && npm run dev

# Terminal 2: Web dev mode
cd web && npm run dev
```

The web dev server proxies API calls to http://localhost:3000 (the server). For production, `npm start` at the repo root builds the web bundle and serves it from the server on port 5175.

## Documentation

See [docs/superpowers/specs/2026-07-21-pr-reviewer-design.md](docs/superpowers/specs/2026-07-21-pr-reviewer-design.md) for the full design document.

## Testing

Run all tests (server + web):
```bash
npm test
```

## Smoke Testing

For end-to-end testing instructions with a real Bitbucket PR, see [scripts/smoke.md](scripts/smoke.md).
