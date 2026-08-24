# UI/UX Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the web UI as a dark-first, sidebar-shell dev tool: complete shadcn primitive set, a Runs monitoring page, a two-column New Review, tabbed Run view and Settings — with every exported pure helper unchanged and the existing 67 web tests green unmodified.

**Architecture:** Four bottom-up layers: (1) theme values + theme toggle + fonts, (2) new Radix/CVA primitives + Sonner toasts, (3) sidebar shell + `/runs` route, (4) page rebuilds one at a time. All work is presentation-only; API/helpers/localStorage keys are untouched except where a helper *moves* files (`timeAgo`).

**Tech Stack:** React 18 + Vite + Tailwind 4 (`@theme inline` tokens) + Radix + CVA + lucide-react + react-router 6; new deps: `sonner`, `@radix-ui/react-select`, `@radix-ui/react-switch`, `@radix-ui/react-tabs`, `@radix-ui/react-tooltip`, `@radix-ui/react-scroll-area`, `@radix-ui/react-dropdown-menu`.

**Spec:** `docs/superpowers/specs/2026-08-24-ui-refactor-design.md`

## Global Constraints

- **Zero behavior change**: the 67 existing web tests stay green UNMODIFIED. Exported helpers keep signatures; localStorage keys keep their names; API calls unchanged.
- **Token deviation (recorded)**: the spec's "collapse multi-step scales" is implemented as *keep the existing token structure and variable names, replace the values* — a literal purge would break the 11 existing primitives (Button/Badge/Alert/etc. consume `primary-400`, `muted-200`, …). Rebuilt pages and new primitives use only the core set (`background`, `foreground`, `primary`, `muted`, `muted-foreground`, `border`, `popover`, `card`, severity colors); legacy scale variables remain as internal aliases with re-tuned values.
- Dark is the default theme: `.dark` on `<html>` unless the stored choice or system preference says light. Storage key: exactly `pr-reviewer.theme` (values `'dark' | 'light'`; absent = follow system).
- Fonts: DM Sans (UI) + JetBrains Mono (mono); Fraunces is removed from the Google Fonts import, and `--font-family-display` is remapped to the DM Sans stack (existing `font-family-display` usages then render as DM Sans — retune weight/tracking per page as they're rebuilt).
- New ui components follow the existing folder convention: `web/src/components/ui/<name>/<Name>.tsx` + `index.ts`, CVA variants, `cn()` from `@/lib/utils`, compound sub-components via property assignment (like `Card.Header`, `Dialog.Panel`).
- Motion: `tw-animate-css` classes only (already imported). Pulse only on live status; fade/slide on mount; scale on dialogs.
- Web commands: `cd web && npx vitest run`, `npx tsc --noEmit`, `npm run build`. Full suite `npm test` at repo root. Commit after every task; add only files the task touched.
- The `ui-ux-pro-max` skill is consulted in Task 1 for final palette values/contrast — the oklch values below are the starting point and may be adjusted there (adjustments stay inside Task 1).

---

### Task 1: Theme foundation — palette, dark default, theme helper, fonts, timeAgo move

**Files:**
- Modify: `web/src/index.css` (font import line; `:root` and `.dark` value blocks)
- Create: `web/src/lib/theme.ts`, `web/src/lib/time.ts`
- Modify: `web/src/main.tsx` (call `initTheme()` before render)
- Modify: `web/src/pages/NewReview.tsx` (delete local `timeAgo`, import from `../lib/time.js`)
- Test: `web/test/theme.test.ts`, `web/test/time.test.ts`

**Interfaces:**
- Produces:
  - `resolveTheme(stored: string | null, prefersDark: boolean): 'dark' | 'light'` — stored `'dark'`/`'light'` wins; anything else follows `prefersDark`.
  - `applyTheme(theme: 'dark' | 'light'): void` — toggles the `dark` class on `document.documentElement`.
  - `setTheme(theme: 'dark' | 'light'): void` — persists to `pr-reviewer.theme` + applies.
  - `getCurrentTheme(): 'dark' | 'light'` — reads the class off the root element.
  - `initTheme(): void` — resolve from storage + `matchMedia('(prefers-color-scheme: dark)')`, apply.
  - `timeAgo(iso: string): string` in `web/src/lib/time.ts` (moved verbatim from `NewReview.tsx`).

- [ ] **Step 1: Consult the design skill.** Invoke the `ui-ux-pro-max` skill for the dark-first dev-tool palette: confirm/adjust the accent (starting point: electric indigo `oklch(0.585 0.222 277)` ≈ #6366f1), surface layering, and AA contrast for text-on-surface and white-on-accent. Record any changed values directly in Step 4's CSS.

- [ ] **Step 2: Write the failing tests** — create `web/test/theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveTheme } from '../src/lib/theme.js'

describe('resolveTheme', () => {
  it('honors a stored explicit choice over the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
  it('follows the system preference when nothing valid is stored', () => {
    expect(resolveTheme(null, true)).toBe('dark')
    expect(resolveTheme(null, false)).toBe('light')
    expect(resolveTheme('bogus', true)).toBe('dark')
  })
})
```

and `web/test/time.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { timeAgo } from '../src/lib/time.js'

afterEach(() => vi.useRealTimers())

describe('timeAgo', () => {
  it('formats minutes, hours, and days with a just-now floor', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T12:00:00Z'))
    expect(timeAgo('2026-08-24T11:59:40Z')).toBe('just now')
    expect(timeAgo('2026-08-24T11:15:00Z')).toBe('45m ago')
    expect(timeAgo('2026-08-24T09:00:00Z')).toBe('3h ago')
    expect(timeAgo('2026-08-22T12:00:00Z')).toBe('2d ago')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run test/theme.test.ts test/time.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement.**

Create `web/src/lib/time.ts` (MOVE the function verbatim from `NewReview.tsx`, add `export`):

```ts
export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
```

In `NewReview.tsx`: delete the local `timeAgo` and add `import { timeAgo } from '../lib/time.js'`.

Create `web/src/lib/theme.ts`:

```ts
const THEME_KEY = 'pr-reviewer.theme'

export type Theme = 'dark' | 'light'

/** Stored explicit choice wins; anything else follows the system preference. */
export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === 'dark' || stored === 'light') return stored
  return prefersDark ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme)
  applyTheme(theme)
}

export function getCurrentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function initTheme(): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  applyTheme(resolveTheme(localStorage.getItem(THEME_KEY), prefersDark))
}
```

In `web/src/main.tsx`, before `createRoot`: `import { initTheme } from './lib/theme.js'` and call `initTheme()` as the first statement.

In `web/src/index.css`:

**(a)** Replace the Google Fonts import line with:

```css
@import url("https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400..700;1,9..40,400..700&family=JetBrains+Mono:wght@400;500;600&display=swap");
```

**(b)** In the `@theme inline` block, remap the font variables:

```css
  --font-family-sans: "DM Sans", sans-serif;
  --font-family-display: "DM Sans", sans-serif;
  --font-family-mono: "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
```

and add card tokens alongside the popover ones:

```css
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
```

**(c)** Re-tune the `.dark` block's core values for the layered near-black look (leave the scale variables in place, adjusting only values that visibly clash; the block already defines every scale). Core values:

```css
    --background: oklch(0.155 0.005 285);       /* page ≈ #0a0a0b */
    --foreground: oklch(0.96 0.004 286);
    --card: oklch(0.185 0.005 285);             /* card ≈ #111113 */
    --card-foreground: oklch(0.96 0.004 286);
    --secondary: oklch(0.185 0.005 285);        /* elevated panels follow card */
    --canvas: oklch(0.14 0.005 285);
    --primary: oklch(0.585 0.222 277);          /* electric indigo #6366f1 */
    --primary-foreground: oklch(0.99 0 0);
    --border: oklch(1 0 0 / 8%);                /* border-white/8 */
    --sidebar: oklch(0.17 0.005 285);
    --sidebar-border: oklch(1 0 0 / 6%);
    --popover: oklch(0.21 0.006 285);           /* raised ≈ #18181b */
    --popover-foreground: oklch(0.96 0.004 286);
    --code-surface: oklch(0.13 0.004 285);
```

and shift the `--primary-*` scale hue from 264 to 277 (same lightness/chroma steps, indigo hue) in both `:root` and `.dark`.

**(d)** In `:root` (light theme), add matching card tokens and the indigo primary:

```css
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.21 0.03 264);
    --primary: oklch(0.55 0.21 277);
```

**(e)** Add a CTA glow utility at the end of the file:

```css
@utility glow-primary {
  box-shadow: 0 0 24px -6px color-mix(in oklch, var(--primary) 55%, transparent);
}
```

- [ ] **Step 5: Verify**

Run: `cd web && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass (69 tests: 67 existing + 2 new files' cases; `report.test.ts` etc. unmodified).

- [ ] **Step 6: Commit**

```bash
git add web/src/index.css web/src/lib/theme.ts web/src/lib/time.ts web/src/main.tsx web/src/pages/NewReview.tsx web/test/theme.test.ts web/test/time.test.ts
git commit -m "feat(ui): dark-first indigo theme, theme helper, JetBrains Mono, timeAgo extraction"
```

---

### Task 2: New primitives — select, switch, tabs, tooltip, scroll-area, skeleton, sheet, sonner

**Files:**
- Create: `web/src/components/ui/{select,switch,tabs,tooltip,scroll-area,skeleton,sheet}/` (each `<Name>.tsx` + `index.ts`)
- Modify: `web/package.json` (deps), `web/src/main.tsx` (mount `<Toaster />`)
- Test: compile-only (`tsc` + build) — primitives carry no logic; behavior is Radix's.

**Interfaces:**
- Produces (imported by Tasks 3–7): `Select` (compound: `Select.Trigger/Value/Content/Item`), `Switch`, `Tabs` (compound: `Tabs.List/Trigger/Content`), `Tooltip` (compound: `Tooltip.Trigger/Content`, wrapped in its own provider), `ScrollArea`, `Skeleton`, `Sheet` (compound: `Sheet.Trigger/Content/Title`), and `toast` re-exported from `sonner`.

- [ ] **Step 1: Install dependencies**

```bash
cd web && npm install sonner @radix-ui/react-select @radix-ui/react-switch @radix-ui/react-tabs @radix-ui/react-tooltip @radix-ui/react-scroll-area
```

(The spec also lists `dropdown-menu`; no rebuilt page uses one, so it is deliberately omitted — YAGNI. Add it the day a menu exists.)

- [ ] **Step 2: Implement the primitives.** Each is the standard shadcn implementation adapted to this repo's conventions (folder + compound properties + core tokens only). Representative code — `web/src/components/ui/select/Select.tsx`:

```tsx
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { type ComponentPropsWithoutRef } from 'react'

import { cn } from '@/lib/utils'

const Root = SelectPrimitive.Root

const Trigger = ({ className, children, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>) => (
  <SelectPrimitive.Trigger
    className={cn(
      'border-border bg-card hover:border-primary focus-visible:ring-primary flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 text-sm outline-none focus-visible:ring-1 disabled:opacity-50',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon>
      <ChevronDown className="text-muted-foreground h-4 w-4" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
)

const Content = ({ className, children, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Content>) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      position="popper"
      sideOffset={4}
      className={cn(
        'bg-popover text-popover-foreground border-border animate-in fade-in-0 zoom-in-95 z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border shadow-deep',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
)

const Item = ({ className, children, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Item>) => (
  <SelectPrimitive.Item
    className={cn(
      'focus:bg-primary/10 flex cursor-default items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none',
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator>
      <Check className="text-primary h-4 w-4" />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
)

export const Select = Object.assign(Root, { Trigger, Value: SelectPrimitive.Value, Content, Item })
```

The remaining primitives follow the same pattern (standard shadcn classes, core tokens):

- **Switch** (`@radix-ui/react-switch`): root `h-5 w-9 rounded-full bg-muted-200 data-[state=checked]:bg-primary transition-colors`, thumb `h-4 w-4 translate-x-0.5 data-[state=checked]:translate-x-4 rounded-full bg-background transition-transform`.
- **Tabs** (`@radix-ui/react-tabs`): `Tabs.List` as `inline-flex gap-1 rounded-lg bg-card p-1 border border-border`; `Tabs.Trigger` as `rounded-md px-3 py-1.5 text-sm text-muted-foreground data-[state=active]:bg-primary/10 data-[state=active]:text-foreground transition-colors`; `Tabs.Content` with `mt-4 outline-none`.
- **Tooltip** (`@radix-ui/react-tooltip`): export wraps `Provider delayDuration={200}` around `Root`; `Content` as `bg-popover border-border z-50 max-w-72 rounded-md border px-3 py-1.5 text-xs shadow-deep animate-in fade-in-0`.
- **ScrollArea** (`@radix-ui/react-scroll-area`): standard Root/Viewport/Scrollbar/Thumb with `bg-border` thumb; accepts `className` for the height cap.
- **Skeleton**: plain div `animate-pulse rounded-md bg-muted-100 dark:bg-popover`.
- **Sheet**: built on the ALREADY-INSTALLED `@radix-ui/react-dialog` — overlay `bg-black/50 animate-in fade-in-0`, content `fixed inset-y-0 left-0 z-50 w-64 bg-sidebar border-r border-sidebar-border p-4 animate-in slide-in-from-left`.

Each folder's `index.ts` re-exports its component (`export { Select } from './Select.js'` — match the casing the existing folders use).

- [ ] **Step 3: Mount toasts** — in `web/src/main.tsx`:

```tsx
import { Toaster } from 'sonner'
```

and render alongside the router:

```tsx
  <React.StrictMode>
    <RouterProvider router={router} />
    <Toaster position="bottom-right" theme="system" richColors closeButton />
  </React.StrictMode>,
```

- [ ] **Step 4: Verify**

Run: `cd web && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all pass; bundle builds with the new deps.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/src/components/ui web/src/main.tsx
git commit -m "feat(ui): shadcn primitive set — select, switch, tabs, tooltip, scroll-area, skeleton, sheet, sonner"
```

---

### Task 3: App shell — sidebar, theme toggle, mobile sheet, /runs route stub

**Files:**
- Modify: `web/src/layouts/AppLayout.tsx` (full rewrite), `web/src/router.tsx`
- Create: `web/src/components/ThemeToggle.tsx`, `web/src/pages/Runs.tsx` (stub this task; real content Task 4)

**Interfaces:**
- Consumes: `Sheet`, `Tooltip` (Task 2), `setTheme`/`getCurrentTheme` (Task 1).
- Produces: sidebar shell all pages render inside; nav routes `/`, `/runs`, `/settings`.

- [ ] **Step 1: Implement.** `web/src/components/ThemeToggle.tsx`:

```tsx
import { useState } from 'react'
import { Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { getCurrentTheme, setTheme, type Theme } from '../lib/theme.js'

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => getCurrentTheme())
  const next: Theme = theme === 'dark' ? 'light' : 'dark'
  return (
    <Button
      type="button"
      variant="ghost-muted"
      size="sm"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        setTheme(next)
        setThemeState(next)
      }}
      className="w-full justify-start gap-2"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      <span className="text-xs">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
    </Button>
  )
}
```

Rewrite `web/src/layouts/AppLayout.tsx`:

```tsx
import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { GitPullRequest, ListChecks, Menu, Plus, Settings as SettingsIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { ThemeToggle } from '@/components/ThemeToggle'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/', end: true, label: 'New review', icon: Plus },
  { to: '/runs', end: false, label: 'Runs', icon: ListChecks },
  { to: '/settings', end: false, label: 'Settings', icon: SettingsIcon },
]

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ to, end, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-primary/10 text-foreground before:bg-primary before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full'
                : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
            )
          }
        >
          <Icon className="h-4 w-4 shrink-0" />
          {label}
        </NavLink>
      ))}
    </nav>
  )
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-6">
      <NavLink to="/" onClick={onNavigate} className="flex items-center gap-2 px-3 pt-1">
        <GitPullRequest className="text-primary h-5 w-5" />
        <span className="text-sm font-semibold tracking-tight">PR Reviewer</span>
      </NavLink>
      <NavItems onNavigate={onNavigate} />
      <div className="mt-auto">
        <ThemeToggle />
      </div>
    </div>
  )
}

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()
  return (
    <div className="bg-background text-foreground flex min-h-screen">
      <aside className="border-sidebar-border bg-sidebar fixed inset-y-0 left-0 hidden w-60 border-r p-3 md:block">
        <SidebarContent />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col md:pl-60">
        <header className="border-border flex items-center gap-3 border-b px-4 py-3 md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <Sheet.Trigger asChild>
              <Button type="button" variant="ghost-muted" size="icon-sm" aria-label="Open navigation">
                <Menu className="h-5 w-5" />
              </Button>
            </Sheet.Trigger>
            <Sheet.Content>
              <Sheet.Title className="sr-only">Navigation</Sheet.Title>
              <SidebarContent onNavigate={() => setMobileOpen(false)} />
            </Sheet.Content>
          </Sheet>
          <span className="text-sm font-semibold">PR Reviewer</span>
        </header>

        <main key={location.pathname} className="animate-in fade-in-0 slide-in-from-bottom-1 mx-auto w-full max-w-5xl flex-1 px-6 py-8 duration-200">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
```

(Adapt `Button` variant/size names to the exact ones exported by `web/src/components/ui/button/Button.tsx` — check its CVA variants before use; the pages already use `ghost-muted`/`icon-sm`.)

Create `web/src/pages/Runs.tsx` stub:

```tsx
export function Runs() {
  return <div />
}
```

Add the route in `web/src/router.tsx`: `import { Runs } from './pages/Runs.js'` and `{ path: 'runs', element: <Runs /> }` between the index and `runs/:id` children.

Note: each page currently renders `<main>` as its root — with the shell now owning `<main>`, change each page's root element to a `<div>` **as that page is rebuilt** (Tasks 5–7); until then nested mains are harmless.

- [ ] **Step 2: Verify** — `cd web && npx tsc --noEmit && npx vitest run && npm run build`; then a quick dev-server look: sidebar renders with active accent bar, theme toggle flips and persists across reload, mobile hamburger opens the sheet.

- [ ] **Step 3: Commit**

```bash
git add web/src/layouts/AppLayout.tsx web/src/router.tsx web/src/components/ThemeToggle.tsx web/src/pages/Runs.tsx
git commit -m "feat(ui): sidebar app shell with theme toggle, mobile sheet, /runs route"
```

---

### Task 4: Runs page — shouldPoll, live dashboard, StatusBadge pulse

**Files:**
- Create: `web/src/lib/runsPolling.ts`
- Modify: `web/src/pages/Runs.tsx` (real implementation), `web/src/components/StatusBadge.tsx`
- Test: `web/test/runsPolling.test.ts`

**Interfaces:**
- Consumes: `listRuns` (existing api), `StatusBadge`, `timeAgo` (Task 1), `Skeleton` (Task 2).
- Produces: `shouldPoll(runs: { status: RunStatus }[]): boolean` — true iff any run is `queued` or `running`. Task 5 navigates here after batch submissions.

- [ ] **Step 1: Write the failing test** — `web/test/runsPolling.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shouldPoll } from '../src/lib/runsPolling.js'

describe('shouldPoll', () => {
  it('is true while any run is queued or running', () => {
    expect(shouldPoll([{ status: 'completed' }, { status: 'running' }])).toBe(true)
    expect(shouldPoll([{ status: 'queued' }])).toBe(true)
  })
  it('is false when every run is terminal or the list is empty', () => {
    expect(shouldPoll([{ status: 'completed' }, { status: 'failed' }])).toBe(false)
    expect(shouldPoll([])).toBe(false)
  })
})
```

Run: `cd web && npx vitest run test/runsPolling.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement.** `web/src/lib/runsPolling.ts`:

```ts
import type { RunStatus } from '../types.js'

/** Poll the runs list only while something can still change. */
export function shouldPoll(runs: { status: RunStatus }[]): boolean {
  return runs.some((r) => r.status === 'queued' || r.status === 'running')
}
```

`web/src/pages/Runs.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/StatusBadge'

import { listRuns } from '../api.js'
import { shouldPoll } from '../lib/runsPolling.js'
import { timeAgo } from '../lib/time.js'
import type { RunRecord } from '../types.js'

const POLL_MS = 3000

export function Runs() {
  const [runs, setRuns] = useState<RunRecord[] | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () =>
      listRuns()
        .then((r) => {
          if (cancelled) return
          setRuns(r)
          if (shouldPoll(r)) timer = setTimeout(tick, POLL_MS)
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(tick, POLL_MS)
        })
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <Button asChild size="sm">
          <Link to="/">
            <Plus className="h-4 w-4" /> New review
          </Link>
        </Button>
      </div>

      {runs === null ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="border-border flex flex-col items-center gap-3 rounded-lg border border-dashed py-16">
          <p className="text-muted-foreground text-sm">No reviews yet.</p>
          <Button asChild size="sm" variant="secondary">
            <Link to="/">Start your first review</Link>
          </Button>
        </div>
      ) : (
        <div className="border-border divide-border divide-y overflow-hidden rounded-lg border">
          {runs.map((r) => (
            <Link
              key={r.id}
              to={`/runs/${r.id}`}
              className="bg-card hover:bg-primary/5 flex items-center gap-4 px-4 py-3 transition-colors"
            >
              <StatusBadge status={r.status} className="w-28 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.prTitle}</p>
                <p className="text-muted-foreground font-family-mono truncate text-xs">
                  {r.pr.workspace}/{r.pr.repo}#{r.pr.id}
                </p>
              </div>
              <div className="hidden items-center gap-1.5 sm:flex">
                {r.reviewProfile && (
                  <Badge variant="muted" size="xs">
                    {r.reviewProfile}
                  </Badge>
                )}
                {r.depth && (
                  <Badge variant="muted" size="xs" className="capitalize">
                    {r.depth}
                  </Badge>
                )}
                {r.status === 'completed' && (
                  <Badge variant="accent" size="xs">
                    {r.findings.length} finding{r.findings.length === 1 ? '' : 's'}
                  </Badge>
                )}
              </div>
              <span className="text-muted-foreground shrink-0 text-xs">{timeAgo(r.createdAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
```

(If the existing `Button` lacks `asChild`, wrap the `Link` around a plain `Button` instead — match the component's actual API.)

`StatusBadge.tsx`: keep the API; strengthen the running treatment by also pulsing a ring:

```tsx
      className={cn(
        status === 'running' &&
          '**:data-[slot=badge-dot]:motion-safe:animate-pulse **:data-[slot=badge-dot]:shadow-[0_0_8px_var(--primary)]',
        status === 'queued' && '**:data-[slot=badge-dot]:bg-transparent **:data-[slot=badge-dot]:border **:data-[slot=badge-dot]:border-current',
        className,
      )}
```

- [ ] **Step 3: Verify** — `cd web && npx vitest run && npx tsc --noEmit && npm run build`; dev-server: `/runs` lists history, a freshly started run shows the pulsing badge and the list live-updates until it completes, then polling stops (check the network tab).

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/runsPolling.ts web/src/pages/Runs.tsx web/src/components/StatusBadge.tsx web/test/runsPolling.test.ts
git commit -m "feat(ui): runs dashboard with conditional live polling"
```

---

### Task 5: New Review rebuild — two-column compose view

**Files:**
- Modify: `web/src/pages/NewReview.tsx` (full rewrite of the JSX; all state/handlers/helpers keep working)
- Create: `web/src/components/SkillPicker.tsx` (extracted — the picker is a third of the old file)

**Interfaces:**
- Consumes: primitives (Task 2), `toast` from `sonner`, navigation to `/runs` (Task 4).
- Produces: `SkillPicker` props: `{ skills: SkillInfo[]; selected: Set<string>; onToggle(name: string): void; onSelectAll(visible: SkillInfo[]): void; onDeselectAll(visible: SkillInfo[]): void }` — filter state (query/category) lives inside the component; `groupSkillsBySource` stays exported from `NewReview.tsx` (a test imports it).

- [ ] **Step 1: Extract `SkillPicker`.** New `web/src/components/SkillPicker.tsx` renders: search `Input` with icon; category pills (existing logic via `inferCategory`/`filterSkills` imported from `../lib/skills.js`); "N selected" chip with a clear button + Select all/none for the filtered view; then a `ScrollArea` capped `max-h-[360px]` containing flat rows:

```tsx
              <label
                key={s.dir}
                title={s.description}
                className="hover:bg-primary/5 flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors"
              >
                <Checkbox checked={selected.has(s.name)} onCheckedChange={() => onToggle(s.name)} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{s.name}</span>
                  <span className="text-muted-foreground block truncate text-xs">{s.description}</span>
                </span>
                <Badge variant="muted" size="xs" className="hidden shrink-0 sm:inline-flex">
                  {s.source.split('/').filter(Boolean).pop()}
                </Badge>
              </label>
```

rows divided by `divide-border divide-y`, all inside a `border-border rounded-lg border bg-card`.

- [ ] **Step 2: Rebuild the page layout.** `NewReview.tsx` root becomes:

```tsx
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New review</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Paste PR links, pick skills, configure the run.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        {/* LEFT: what to review */}
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="pr-urls">Pull request URLs</Label>
            <Textarea
              id="pr-urls"
              className="font-family-mono min-h-24 text-sm"
              placeholder={'https://bitbucket.org/workspace/repo/pull-requests/123\nhttps://github.com/owner/repo/pull/456'}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {urls.length} PR{urls.length === 1 ? '' : 's'} · one per line
            </p>
          </div>

          <SkillPicker
            skills={skills}
            selected={selected}
            onToggle={toggle}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
          />

          <Collapsible>
            <Collapsible.Trigger className="text-muted-foreground hover:text-foreground text-sm">
              + Add reviewer focus
            </Collapsible.Trigger>
            <Collapsible.Content>
              <Textarea
                className="mt-2"
                placeholder='e.g. "pay attention to date handling"'
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
              />
            </Collapsible.Content>
          </Collapsible>
        </div>

        {/* RIGHT: sticky run configuration */}
        <div className="lg:sticky lg:top-8 lg:self-start">
          <Card shadow="sm">
            <Card.Header>
              <Card.Title className="text-base">Run configuration</Card.Title>
            </Card.Header>
            <Card.Content className="flex flex-col gap-5 pt-0">
              {/* model */}
              <div className="flex flex-col gap-1.5">
                <Label>Review model</Label>
                <Select value={profile ?? undefined} onValueChange={pickProfile}>
                  <Select.Trigger>
                    <Select.Value placeholder="Loading…" />
                  </Select.Trigger>
                  <Select.Content>
                    {profiles.map((p) => (
                      <Select.Item key={p.id} value={p.id}>
                        {p.label} <span className="text-muted-foreground text-xs">· {p.kind}</span>
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
              </div>

              {/* depth: segmented control */}
              <div className="flex flex-col gap-1.5">
                <Label>Depth</Label>
                <div className="border-border bg-background grid grid-cols-3 gap-1 rounded-lg border p-1">
                  {DEPTH_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => pickDepth(o.value)}
                      className={cn(
                        'rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                        depth === o.value
                          ? 'bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  {DEPTH_OPTIONS.find((o) => o.value === depth)?.hint ?? 'Loading default…'}
                </p>
              </div>

              {/* verify */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>Verify findings</Label>
                  <p className="text-muted-foreground text-xs">Second agent re-checks each finding</p>
                </div>
                <Switch checked={verify} onCheckedChange={(v) => { setVerify(v); localStorage.setItem(VERIFY_KEY, JSON.stringify(v)) }} />
              </div>

              {/* auto-post */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>Auto-post findings</Label>
                    <p className="text-muted-foreground text-xs">Comment on the PR when the run completes</p>
                  </div>
                  <Switch checked={autoSubmitOn} onCheckedChange={(v) => { setAutoSubmitOn(v); localStorage.setItem(AUTO_SUBMIT_KEY, JSON.stringify(v)) }} />
                </div>
                {autoSubmitOn && (
                  <div className="border-border flex flex-col gap-3 rounded-md border border-dashed p-3">
                    <Select value={threshold} onValueChange={(v) => { setThreshold(v as 'high' | 'medium' | 'all'); localStorage.setItem(AUTO_THRESHOLD_KEY, v) }}>
                      <Select.Trigger aria-label="Auto-post severity threshold">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="high">High only</Select.Item>
                        <Select.Item value="medium">Medium and up</Select.Item>
                        <Select.Item value="all">All severities</Select.Item>
                      </Select.Content>
                    </Select>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs">Confirmed findings only</span>
                      <Switch checked={confirmedOnly} onCheckedChange={(v) => { setConfirmedOnly(v); localStorage.setItem(AUTO_CONFIRMED_KEY, JSON.stringify(v)) }} />
                    </div>
                    {!verify && confirmedOnly && (
                      <p className="text-muted-foreground text-xs">
                        Verification is off, so every finding counts as confirmed — this filter has no effect.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <Button size="lg" className="glow-primary w-full" disabled={busy || urls.length === 0} onClick={() => submit()}>
                {busy ? 'Starting…' : urls.length > 1 ? `Run ${urls.length} reviews` : urls.length === 1 ? 'Run review' : 'Add a PR URL'}
              </Button>
              {error && <p className="text-destructive text-sm">{error}</p>}
              {results.length === 1 && results[0].kind === 'oversized' && (
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <Alert.Description className="flex flex-col gap-2">
                    <span>{results[0].diffLines} changed lines — this may be slow and costly.</span>
                    <Button variant="secondary" size="sm" className="w-fit" disabled={busy} onClick={() => submit(results[0].url)}>
                      Run anyway
                    </Button>
                  </Alert.Description>
                </Alert>
              )}
            </Card.Content>
          </Card>
        </div>
      </div>
    </div>
```

- [ ] **Step 3: Rewire submit outcomes.** In `submit()`: single URL started → navigate to its run (unchanged). Multi-URL: toast each outcome (`toast.success('ws/repo#12 started')` / `toast.warning(...oversized with a "Run anyway" action calling submit(url))` / `toast.error(message)`) and `navigate('/runs')` when at least one started; keep `results` state only for the single-URL oversized alert (clear it otherwise). Delete the per-URL results list JSX and the whole "Recent runs" section (the `runs` state, `listRuns` import if now unused, and `sourceLabel` if only the old grid used it). `groupSkillsBySource` STAYS exported (grouping.test.ts imports it) — it is simply no longer called by the page. Re-import checks: `AlertTriangle` still used by the oversized alert.

- [ ] **Step 4: Verify** — `cd web && npx vitest run && npx tsc --noEmit && npm run build` (all existing tests green — `groupSkillsBySource` still exported). Dev-server: two-column layout, sticky config card, skills scroll inside their panel, collapsed focus, switches/selects work, single-URL run navigates to the run view, multi-URL navigates to `/runs` with toasts.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/NewReview.tsx web/src/components/SkillPicker.tsx
git commit -m "feat(ui): two-column New Review compose view with sticky run configuration"
```

---

### Task 6: Run view rebuild — header, tabs, findings, floating action bar

**Files:**
- Modify: `web/src/pages/RunView.tsx` (JSX restructure; ALL exported helpers untouched), `web/src/components/FindingCard.tsx`, `web/src/components/ReviewConsole.tsx` (token/font touch-ups only)

**Interfaces:**
- Consumes: `Tabs`, `Tooltip`, `ScrollArea`, `toast` (Task 2).
- Produces: nothing new — `formatCommentBody`, `applyPostResult`, `partitionFindingsByVerdict`, `statusForIndex`, `postableIndexes`, `groupFindingsBySeverity` keep exact signatures (report.test.ts depends on them).

- [ ] **Step 1: Restructure the page.**

**Header zone**: title + `StatusBadge`; beneath it one badge row — mono `ws/repo#id`, `reviewProfile`, `depth`, `verify ? 'verified' : 'unverified run'`, each skill as a muted badge; retry buttons (`Retry run` on failed, `Retry failed skills (N)` whenever `failed.length > 0`) right-aligned in the header row as compact `secondary` buttons. Login-expiry and run-failed `Alert`s directly below (existing conditions/content).

**Tabs**: controlled `Tabs` with state `tab: 'findings' | 'console'`, initialized `active ? 'console' : 'findings'`. On the SSE done-refetch (the existing `getRun` in `subscribeRun`'s onDone), if status is `completed`: `setTab('findings')` and `toast.success(\`Review complete — ${r2.findings.length} finding${...}\`)`.

- Findings tab: skill-runs chip row + auto-post result line (existing JSX) on top, then the findings list (partition → severity groups, unchanged logic), empty-state alert as today.
- Console tab: `<ReviewConsole …/>` as today.

**FindingCard**: severity left border + muted unverified + copyable location + tooltip reason:

```tsx
const SEVERITY_BORDER: Record<Severity, string> = {
  high: 'border-l-destructive',
  medium: 'border-l-warning',
  low: 'border-l-warning-400',
  info: 'border-l-primary-400',
}
```

Card root gains `cn('border-l-2', SEVERITY_BORDER[finding.severity], finding.verdict === 'unverified' && 'opacity-70')`. The file:line chip becomes a button that `navigator.clipboard.writeText(\`${finding.file}:${finding.line}\`)` and toasts "Copied"; unverified badge wraps in `Tooltip` with `finding.verifierReason ?? 'Not confirmed by the verifier'` as content (replacing the italic reason paragraph). Example/suggestion `pre` blocks keep `overflow-x-auto` + mono.

**ReviewConsole**: no structural change — dim tool lines further (`text-code-muted/70` for `tool` kind), add pause-on-hover to auto-scroll (skip `scrollTo` when `feedRef.current?.matches(':hover')`).

**Selection bar**: replace the sticky full-width bar with a floating bar:

```tsx
      {checked.size > 0 && (
        <div className="animate-in slide-in-from-bottom-4 border-border bg-popover fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-full border py-2 pr-2 pl-5 shadow-deep">
          <span className="text-sm font-medium">{checked.size} selected</span>
          <Button size="sm" className="rounded-full" onClick={() => setConfirming(true)}>
            Post to PR…
          </Button>
        </div>
      )}
```

**Confirm dialog**: content list wraps in `ScrollArea className="max-h-96"`; the already-posted/resolved labels stay badges. `post()` success path: `toast.success(message)` / failure `toast.error(...)` instead of `setPostMessage` (delete the `postMessage` state and its render).

Page root `<main>` → `<div className="flex flex-col gap-6 pb-24">` (padding for the floating bar).

- [ ] **Step 2: Verify** — `cd web && npx vitest run && npx tsc --noEmit && npm run build` (report.test.ts untouched and green). Dev-server with a real or fake run: tabs switch, console default while running then auto-switch + toast, floating bar appears on selection, copy chip toasts, posting toasts.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/RunView.tsx web/src/components/FindingCard.tsx web/src/components/ReviewConsole.tsx
git commit -m "feat(ui): run view with findings/console tabs, severity-marked cards, floating post bar"
```

---

### Task 7: Settings rebuild — tabs + dirty save bar

**Files:**
- Modify: `web/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: `Tabs`, `Select`, `toast` (Task 2).

- [ ] **Step 1: Restructure.** Keep every handler and child component (`ModelProfilesEditor`, `SkillSources`, `ClearCache`) — this task moves them into tabs and modernizes chrome:

- Page root `<div className="flex flex-col gap-6 pb-20">`, heading row as in other pages.
- **Dirty tracking**: `const [savedCfg, setSavedCfg] = useState<Config | null>(null)` set alongside the initial `getConfig` load and after each successful save; `const dirty = cfg !== null && savedCfg !== null && JSON.stringify(cfg) !== JSON.stringify(savedCfg)`.
- `handleSave` success: `setSavedCfg(cfg)` + `toast.success('Settings saved')`; failure `toast.error(message)`. Delete the `saved` state and "Saved." paragraph and the always-visible save row.
- **Tabs** (default `connections`):

```tsx
      <Tabs defaultValue="connections">
        <Tabs.List>
          <Tabs.Trigger value="connections">Connections</Tabs.Trigger>
          <Tabs.Trigger value="models">Models</Tabs.Trigger>
          <Tabs.Trigger value="skills">Skills</Tabs.Trigger>
          <Tabs.Trigger value="storage">Storage</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="connections">…Bitbucket card + GitHub card…</Tabs.Content>
        <Tabs.Content value="models">…Review models card (ModelProfilesEditor + diff-warn field)…</Tabs.Content>
        <Tabs.Content value="skills">…Skill sources card…</Tabs.Content>
        <Tabs.Content value="storage">…Storage card (cache dir + ClearCache)…</Tabs.Content>
      </Tabs>
```

(each Content holds the existing card JSX, moved verbatim).
- Inside `ModelProfilesEditor`: the two default-model native `<select>`s become `Select` components (same values/handlers); the add-form's three kind buttons become a small nested `Tabs`; kind icons per row (`Bot` for claude, `Terminal` for cli, `Globe` for openai from lucide).
- **Sticky save bar**, rendered only when dirty:

```tsx
      {dirty && (
        <div className="animate-in slide-in-from-bottom-4 border-border bg-popover fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border py-2 pr-2 pl-5 shadow-deep">
          <span className="text-sm">Unsaved changes</span>
          <Button variant="ghost-muted" size="sm" className="rounded-full" onClick={() => setCfg(savedCfg)}>
            Discard
          </Button>
          <Button size="sm" className="rounded-full" onClick={handleSave}>
            Save
          </Button>
        </div>
      )}
```

- [ ] **Step 2: Verify** — `cd web && npx vitest run && npx tsc --noEmit && npm run build`. Dev-server: tabs navigate; editing any field pops the save bar; Discard restores; Save toasts and the bar disappears; profile editor still adds/removes/blocks-referenced.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/Settings.tsx
git commit -m "feat(ui): tabbed settings with dirty-state save bar and toasts"
```

---

### Task 8: Visual smoke, docs, green-gate

**Files:**
- Modify: `README.md` (one line noting the dark-first UI + Runs page)
- Test artifacts: Playwright screenshots (scratch only, not committed)

- [ ] **Step 1: Playwright visual smoke.** Start the app (`npm start` at the repo root, or server + web dev). Using the `playwright-cli` skill: for each of `/`, `/runs`, `/settings` and one `/runs/:id` from history — load the page, assert the sidebar nav ("New review", "Runs", "Settings") is visible, on `/` assert both the URL textarea and the "Run configuration" heading are visible (two-column proof), screenshot to the scratchpad. Then click the theme toggle and screenshot `/` again in light mode. Present the screenshots for human review.

- [ ] **Step 2: README** — in the intro paragraph, note the UI: "The UI is a dark-first dashboard: compose reviews on the home page, monitor concurrent runs under Runs, and manage connections/models/skills in Settings (light theme available via the sidebar toggle)."

- [ ] **Step 3: Full green-gate**

Run: `npm test` at the repo root, plus `cd web && npx tsc --noEmit && npm run build`.
Expected: 238 server + 72 web tests pass (67 existing unmodified + theme 2 + time 1 + runsPolling 2), clean build.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: note the dark-first UI and runs dashboard"
```
