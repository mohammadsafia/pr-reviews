# Save a Tested Skill to Disk Design

**Date:** 2026-09-01
**Status:** Approved design, pending implementation plan

## Problem

The skill test-run feature (A4) lets a skill author try draft `SKILL.md` content against
a real PR before saving it — but closing that loop was an explicit non-goal at the time:
"saving it is a separate, manual step the author still does." Today that means copying the
tested textarea content out of the browser and manually creating or editing the file.

## Goals

1. Save a tested skill's exact content directly to a local skill directory from the run
   page, with no copy-paste.
2. **Never** write into a GitHub-sourced skill directory — those are shallow clones kept in
   sync with `git pull` on refresh; a local edit there would either be silently clobbered
   on the next refresh or break the refresh itself on a dirty working tree.
3. Never silently overwrite an existing skill's file without the user confirming.

Non-goals: editing a skill in place from the New Review flow (only the test-run flow ever
carries ad-hoc draft content); managing/browsing the resulting file after it's saved (the
user's own editor/git tooling handles that from here); renaming an existing skill on save.

## Architecture overview

```
RunView (isTest run) ──► GET /api/skills/local-dirs
                              │ (config.skillDirs minus GitHub-managed clones)
                          "Save skill…" dialog: pick destination
                              │
                        POST /api/skills/save { dir, content, overwrite? }
                              │
                name parsed from content's frontmatter, validated as a safe path segment
                              │
                  <dir>/<name>/SKILL.md exists? ──yes, no overwrite──► 409
                              │ no, or overwrite:true
                        write file, create directory if needed
```

Touched: `server/src/routes/skills.ts` (two new routes), `server/src/skills/scanner.ts`
(no change — `parseFrontmatter` already exported), `server/src/routes/cache.ts`
(`isSafeCacheSegment` reused, not moved), `web/src/api.ts`, `web/src/pages/RunView.tsx`.

## Component 1 — `GET /api/skills/local-dirs`

Returns `config.skillDirs` filtered to exclude anything under the GitHub-clones root:

```ts
app.get('/api/skills/local-dirs', async () => {
  const c = ctx.cfg()
  return c.skillDirs.filter((d) => !skillRepoCloneDir(d, ctx.skillReposDir()))
})
```

`skillRepoCloneDir` (from `skills/sources.js`, already used by the existing
skill-source-removal route) resolves whether a directory sits under
`<skillReposDir>/<owner>__<repo>` — the exact same check that already distinguishes
GitHub-managed sources elsewhere in the app. Only the server can make this determination
(it alone knows the clones root path), so the client only ever sees safe destinations.

## Component 2 — `POST /api/skills/save`

Body: `{ dir: string; content: string; overwrite?: boolean }`.

- `dir` must be one of the values `GET /api/skills/local-dirs` would return — re-validated
  server-side on every call (not trusted from a client-cached list), the same defense the
  existing skill-source routes already apply to config-derived paths.
- The skill name comes from `parseFrontmatter(content).name`. Missing or empty → 400
  ("add a `name:` field to save"). Present but containing anything other than
  `[A-Za-z0-9._-]` (or literally `.`/`..`) → 400, using the exact same
  `isSafeCacheSegment` check the cache-clear route already applies to path segments —
  reused as-is, not duplicated, even though it lives in the cache route module; a `name:`
  value is untrusted user-editable text as much as a cache URL param is.
- Target path: `<dir>/<name>/SKILL.md`. If it already exists and `overwrite` isn't `true`,
  return 409 (`{ error: 'A skill named "<name>" already exists at <path>.' }`) — same
  409-then-resubmit-with-a-flag shape the oversized-diff gate already uses twice in this
  codebase (`POST /api/runs`, `POST /api/skills/test-run`), so this is a third instance of
  an established pattern, not a new one.
- On write: create `<dir>/<name>/` if it doesn't exist, write `SKILL.md`, return
  `{ ok: true, path, created: boolean }` (`created: false` when it overwrote).

## Component 3 — UI

`RunView.tsx`, only when `run.isTest`: a "Save skill…" button opens a `Dialog` (the same
primitive already used for the post-comments confirm flow — no new dialog pattern).

- Fetches `local-dirs` on open. Zero results → a message directing the user to Settings →
  Skills to add a local directory first, no destination picker. One result → the
  destination is implicit, shown as text, no picker. Multiple → a `Select` of directories.
- Save button calls `POST /api/skills/save` with `run.testSkillContent`. A 409 response
  swaps the button for an inline "A skill named `<name>` already exists here — overwrite?"
  confirmation; confirming resubmits with `overwrite: true`.
- Success closes the dialog and toasts "Saved to `<path>`" (`created: true`) or "Updated
  `<path>`" (`created: false`).

## Error handling summary

| Case | Behavior |
|---|---|
| No local skill directories configured | Dialog shows a message, no picker, no way to submit |
| Pasted content has no `name:` frontmatter | 400 before any filesystem write |
| Parsed name contains unsafe characters (e.g. `../x`) | 400, same check cache-path params already get |
| Target file already exists, no `overwrite` | 409; UI shows an inline confirm before resubmitting |
| `dir` isn't in the current local-dirs list (stale client state, or a GitHub dir) | 400 — re-validated server-side every call |

## Testing

- `GET /api/skills/local-dirs`: excludes a GitHub-sourced directory (seeded via the same
  clone-dir layout `addGithubSource`/`skillRepoCloneDir` already use in their own tests),
  includes a local one.
- `POST /api/skills/save`: creates a new skill directory + `SKILL.md` when none exists;
  409s on a second save without `overwrite`; succeeds and overwrites the file's content
  with `overwrite: true`; 400s on missing/empty `name:` frontmatter; 400s on an unsafe
  name (`../x`, embedded separators); 400s when `dir` isn't a known local directory.
- `RunView.tsx`: no new unit tests — presentational, matching this project's convention.
  Verified via typecheck + build + full test suite.
