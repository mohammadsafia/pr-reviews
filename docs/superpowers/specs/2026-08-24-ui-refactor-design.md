# UI/UX Refactor Design

**Date:** 2026-08-24
**Status:** Approved design, pending implementation plan

## Problem

The web UI has outgrown its skeleton. The stack is already shadcn-style (Radix + CVA +
Tailwind 4 tokens + `cn()`), but the pages don't use it well: a cramped `max-w-3xl`
single-column shell; New Review is a wall of 7+ stacked option blocks with the runs list
squatting at the bottom; Settings is an unbroken wall of cards; three hand-rolled native
`<select>`s; inline success/error paragraphs instead of toasts; a `.dark` variant defined
in CSS but no way to toggle it; no dedicated view for monitoring the now-concurrent runs.

## Goals

1. **Full UX restructure** — layouts, navigation, and flows, not just polish.
2. **Sleek dev-tool aesthetic** — dark-first (Linear/Vercel register): layered near-black
   surfaces, crisp 1px borders, one electric-indigo accent with subtle glow on primary
   actions, monospace where it counts, fast subtle motion.
3. **Proper shadcn usage** — complete the primitive set; retire every hand-rolled control.
4. **Zero behavior change** — every exported pure helper keeps its signature; the existing
   67 web tests stay green unmodified.

Non-goals: framework changes (stay on Tailwind 4 + Radix + CVA + react-router), a
component-render test rig, server/API changes.

## Component 1 — Theme & typography

- `index.css` rebuilt around the standard shadcn token set (`background`, `card`,
  `popover`, `muted`, `accent`, `border`, `ring`, severity + success colors); the
  multi-step scales (`primary-15…900`, `secondary-*`, `surface-*`) are removed and all
  usages migrated.
- **Dark is the default**: `.dark` on the root; a theme toggle persists the choice under
  `pr-reviewer.theme`; initial value from `prefers-color-scheme`. Light theme mirrors the
  same token names — components never branch on theme.
- Dark palette: page ≈ `#0a0a0b`, card ≈ `#111113`, raised ≈ `#18181b`, `border-white/8`
  borders; electric-indigo accent for primary buttons, active nav, focus rings, and a
  subtle outer glow on the main CTA. Severity colors (red/amber/yellow/blue) and success
  stay semantic. Exact values finalized during implementation with the `ui-ux-pro-max`
  skill (contrast-checked).
- Typography: DM Sans stays for UI (headings become DM Sans semibold, tighter tracking —
  the italic Fraunces display font is retired); JetBrains Mono for URLs, paths, code, and
  the console.
- Motion via the already-installed `tw-animate-css`, used deliberately: fade/slide on page
  mount, scale on dialogs, pulse only on live status badges. No animation library added.

## Component 2 — New primitives

Added under `web/src/components/ui/<name>/` (existing folder convention, Radix-based):
`select`, `tabs`, `switch`, `tooltip`, `dropdown-menu`, `skeleton`, `scroll-area`,
`sheet`, and `sonner` toasts. New dependencies: `sonner` plus the required
`@radix-ui/react-*` packages; nothing else.

Retired patterns: all three native `<select>`s (Settings ×2, auto-submit threshold);
checkbox-as-switch for verify/auto-post (→ `Switch`); inline success/error paragraphs for
post results and settings saves (→ toasts).

## Component 3 — App shell, navigation & the Runs page

- **Shell**: fixed 240px sidebar — app name/icon; nav **New review / Runs / Settings**
  with lucide icons and an active accent bar; theme toggle pinned at the bottom. Content
  scrolls independently in a `max-w-5xl` column. Small screens: sidebar collapses to a
  slide-over `Sheet` behind a hamburger.
- **Routes**: `/` New Review, **`/runs` new**, `/runs/:id`, `/settings`.
- **Runs page** (the monitoring view concurrency needs): one row per run — status badge
  (pulsing dot `running`, hollow `queued`), PR title, `workspace/repo#id` in mono,
  profile + depth badges, finding count when completed, relative time. Polls `listRuns()`
  every 3s only while any run is `queued`/`running` (predicate: `shouldPoll(runs)`).
  Empty state links home. Multi-URL batch submissions navigate here (outcomes as toasts);
  the runs list leaves the New Review page entirely.
- `StatusBadge` rebuilt on the new tokens with the pulse treatment. `timeAgo` moves to
  `web/src/lib/time.ts` (shared by two pages), exported and tested.

## Component 4 — New Review redesign

Two columns on desktop (stacked on mobile): left ~60% *what to review*, right ~40% a
sticky **Run configuration** card — submitting never requires scrolling.

- **Left**: PR URLs textarea (mono, auto-growing, live parse count); skills picker —
  search + category pills kept, but per-source card grids become a flat dense list of
  selectable rows (checkbox, name, truncated description, source badge) in a `ScrollArea`
  capped ≈360px, "Select all/none" on the filtered view, an "N selected" chip that clears
  in one click; focus textarea collapsed behind an "Add reviewer focus" toggle (existing
  `collapsible`).
- **Right (config card)**: Model as `Select` (label + kind badge per option); depth as a
  3-way segmented control with hint line; Verify as `Switch`; Auto-post as `Switch`
  revealing threshold `Select` + confirmed-only `Switch` (verify-off hint kept); Run
  button full-width with accent glow, label from URL count, disabled state explains why.
- Outcomes: single-URL oversized keeps the inline "Run anyway" alert; multi-URL batches
  toast per URL and navigate to `/runs`.
- All persistence (localStorage per option), helpers (`parsePrUrlLines`, `submitBatch`),
  and config-default seeding carry over unchanged.

## Component 5 — Run view & Settings

**Run view**, three zones:

- **Header**: title + status badge; metadata badge row (repo#id mono, profile, depth,
  verify on/off); retry buttons as compact header actions; login-expiry / run-failed
  alerts directly beneath.
- **Tabs: Findings / Console.** Findings default on completed runs; Console default while
  running, auto-switching to Findings on completion with a toast ("Review complete — N
  findings"). Console: JetBrains Mono, auto-scroll with pause-on-hover, tool lines dimmed.
  Skill-runs chips and the auto-post result line sit atop the Findings tab.
- **Findings**: FindingCard rebuilt — severity as colored left border + badge, copyable
  mono file:line chip, code blocks with overflow scroll, unverified findings visually
  muted with the reason in a `Tooltip`. Partition/grouping logic untouched.
- **Selection bar**: floating action bar (rounded, elevated, slide-up) with count +
  "Post to PR…"; confirm dialog content/logic unchanged but wrapped in `ScrollArea` with
  status badges; post results toast via the unchanged `applyPostResult` message.

**Settings**: four `Tabs` — **Connections** (Bitbucket, GitHub), **Models** (profile
editor with kind icons; add-form as a small per-kind `Tabs`), **Skills** (sources),
**Storage** (cache dir + clear). A sticky save bar appears only when dirty ("Unsaved
changes — Save / Discard"); save success/failure as toasts.

## Testing & verification

- The existing 67 web tests stay green **unmodified** — every exported helper keeps its
  signature. This is the refactor's safety net.
- New/moved pure logic gets vitest coverage: `timeAgo` (minute/hour/day boundaries),
  `resolveTheme(stored, prefersDark)` (stored wins, else system), `shouldPoll(runs)`.
- Static gates after every page rebuild: `npx tsc --noEmit`, `npm run build`; full
  `npm test` at each commit.
- **Playwright visual smoke** (via the `playwright-cli` skill): load all four routes in
  dark and light, assert sidebar presence and the New Review two-column layout, capture a
  screenshot per page for human review.
- During implementation, the `ui-ux-pro-max` skill supplies palette/typography/
  interaction specifics (exact accent values, contrast checks, focus-visible treatment).

## Expected impact

The app reads like a modern dev tool: dark-first, information-dense where it matters
(runs monitoring, findings) and calm where it doesn't (configuration). New Review goes
from a scrolling wall to a two-column compose view; concurrent runs get a real dashboard;
Settings becomes navigable; every control is a real shadcn primitive with consistent
focus, hover, and motion behavior.
