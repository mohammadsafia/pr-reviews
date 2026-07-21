# PR Reviewer — UI Revamp Design (shadcn + rsk kit + React Router)

**Date:** 2026-07-21 · Follows the v1 spec; UI layer only. Server API unchanged except a SPA fallback.

## Direction

Adopt the user's `rsk` starter kit design language (kit clone available at
`/private/tmp/claude-501/-Users-mohammadsafia-Desktop-projects/62323bb0-02fd-4295-b920-67379d5b4e97/scratchpad/rsk-starter`):
Tailwind v4 (`@tailwindcss/vite`, CSS-based `@theme`), the kit's full token set (`src/index.css` — primary/secondary/muted/surface/success/warning/destructive/code-surface, `.dark` variant), DM Sans (UI) + Fraunces (display, restrained) + mono for code. Components are cherry-picked copies of the kit's `src/components/ui/*` (CVA + Radix), adapted to a `@/` alias.

**Signature element:** the *review console* on the Run view — an always-dark terminal-like panel (code-surface tokens, 13px mono) streaming agent events live with per-kind glyphs (`›` status · `⚙` tool · plain text · `✕` error), auto-scroll, elapsed timer, and a blinking caret while running (`prefers-reduced-motion` respected). When the run completes it collapses to a one-line summary row ("Agent feed · 3m 12s · 47 events", expandable via Collapsible). Everything else stays quiet.

**Explicitly avoided:** cream+terracotta/serif default, black+acid-accent default, broadsheet hairline default. The palette and type are the kit's own; boldness is spent once, on the console.

## Structure

```
web/src/
├── index.css                    # kit theme (copied token block + fonts), replaces styles.css
├── lib/utils.ts                 # cn() (clsx + tailwind-merge)
├── components/ui/               # copied from kit: button, input, card, checkbox, badge,
│                                #   dialog, label, collapsible, alert, separator
│                                #   + textarea (new, following kit conventions)
├── components/StatusBadge.tsx   # run status → badge variant mapping
├── components/ReviewConsole.tsx # the signature live feed panel
├── components/FindingCard.tsx   # one finding: checkbox, file:line chip, detail, suggestion
├── layouts/AppLayout.tsx        # top bar: Fraunces wordmark, nav (New review / Settings), <Outlet/>
├── pages/NewReview.tsx          # moved+redesigned from screens/
├── pages/RunView.tsx
├── pages/Settings.tsx
├── router.tsx                   # createBrowserRouter: / , /runs/:id , /settings under AppLayout
└── main.tsx                     # RouterProvider + index.css import
```

Deps added to web/: `react-router-dom@^6`, `tailwindcss@^4` + `@tailwindcss/vite` + `tw-animate-css`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, and only the Radix packages the copied components import. Vite config gains the tailwind plugin and `@` → `./src` alias (tsconfig `paths` too). `screens/` and `styles.css` are deleted; hash routing and `parseRoute` are removed (their tests too). `groupSkillsBySource` and `groupFindingsBySeverity` survive verbatim (exported from their new page files; tests keep passing with updated import paths).

**Server change (one):** in production static mode, non-`/api` GETs fall back to `index.html` (`setNotFoundHandler` + `reply.sendFile`), so `/runs/:id` deep links work with browser routing.

## Screens

**New Review (`/`)** — H1 in Fraunces "Review a pull request." with one muted sub-line. The URL input is the hero: h-12, mono placeholder `https://bitbucket.org/workspace/repo/pull-requests/123`, primary button "Run review" beside it; inline destructive error text under the field. "Skills to apply" section: one Card per source directory (legend = basename, full path as muted caption), checkboxes in a 2-column grid, skill description truncated to one line. Optional focus Textarea: "Anything specific to watch for? (optional)". Oversized-diff 409 → warning Alert with changed-line count and secondary "Run anyway" (disabled while busy). Recent runs: quiet rows — StatusBadge, PR title, `workspace/repo #id`, relative time — each linking to `/runs/:id`. Empty state: "No reviews yet. Paste a PR link above to run your first."

**Run view (`/runs/:id`)** — Header: PR title in Fraunces 24px, muted `workspace/repo #id`, skill chips, StatusBadge (queued=muted, running=primary+pulse, completed=success, failed=destructive). Below: the review console (signature, above). Failed runs: destructive Alert with the error and a "Retry run" button (existing URL-rebuild logic). Completed runs: "Findings" heading with count; groups ordered high→medium→low→info, each group headed by a severity Badge (destructive/warning/accent/muted); FindingCards with checkbox, mono `file:line` chip, `category · skill` muted caption, bold summary, detail paragraph, suggestion in a code-surface block. Zero findings: success state "Nothing to flag. The agent reviewed this PR clean." When ≥1 finding is checked, a sticky bottom bar shows "N selected" + "Post to Bitbucket…" which opens a Dialog listing exactly the chosen comments (`file:line` — summary); confirm button "Post N comments", cancel. Success clears selections and shows "Posted N comments."

**Settings (`/settings`)** — Cards per concern: **Bitbucket** (email, token as password input, caption "*** means your saved token is kept"), **Skills** (textarea, one directory per line), **Review engine** (model input, diff-warning threshold number), **Storage** (cache location input; "Clear a cached repo" row with workspace + repo inputs and an outline-destructive "Clear cache" button). Primary "Save changes" button; inline "Saved." confirmation; load/save errors surface in a destructive Alert (existing error-state logic preserved).

## Constraints carried over from v1 (unchanged)

- Comments post ONLY via the explicit confirm dialog.
- All existing web behaviors survive: localStorage-remembered skill selection, non-throwing `createRun` handling (status 0 / 409 / error), SSE subscribe → refetch on done, cancelled-guard in effects, load/save error states.
- TypeScript strict; Vitest; `npm run build` green; keyboard focus visible; reduced motion respected.
