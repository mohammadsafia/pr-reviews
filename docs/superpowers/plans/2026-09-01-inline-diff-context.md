# Inline Diff Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a small, exact snippet of surrounding diff code to each finding at review time, and show it on `FindingCard` behind a collapsed "Show context" toggle.

**Architecture:** A new pure module (`review/diffContext.ts`) parses the unified diff already fetched for the run and extracts a radius-clamped slice of lines around a finding's `file:line`, matched against the diff's new-file (post-PR) line numbers. `app.ts` attaches the result to each finding right before it's persisted, while the diff is still in memory (it's never written back to disk). The `Finding` type gains one optional field; the client renders it if present, renders nothing if not.

**Tech Stack:** TypeScript, Vitest, Fastify (server); React, Radix `Collapsible` primitive (web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-inline-diff-context-design.md`

## Global Constraints

- Context radius defaults to 3 lines above/below the matched line.
- Matching is against the diff's **new-file** line number (the PR's resulting code — same numbering used for posted inline comments), never the old-file number.
- A returned snippet must never extend past the boundary of the hunk the match falls in, even if radius would reach further in a flattened view across hunks.
- `extractDiffContext` never throws — an unresolvable file/line, or a malformed/empty diff, returns `undefined`.
- `Finding.context` is optional; absent on runs recorded before this feature and on findings where extraction failed. No run-storage migration is needed (`RunStore` does plain JSON persistence with no schema validation).
- The UI shows the snippet collapsed by default, using the existing `Collapsible` primitive already used elsewhere in the app (no new UI pattern).

---

### Task 1: Diff context extraction (`review/diffContext.ts`)

**Files:**
- Create: `server/src/review/diffContext.ts`
- Test: `server/test/diffContext.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DiffContextLine {
    type: 'context' | 'add' | 'remove'
    text: string
    newLine?: number // set for context/add lines
    oldLine?: number // set for context/remove lines
  }

  export function extractDiffContext(
    diff: string,
    file: string,
    line: number,
    radius = 3,
  ): DiffContextLine[] | undefined
  ```
  This is the only export later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Create `server/test/diffContext.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractDiffContext } from '../src/review/diffContext.js'

describe('extractDiffContext', () => {
  it('returns undefined when the file is not in the diff', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n')
    expect(extractDiffContext(diff, 'b.ts', 1)).toBeUndefined()
  })

  it('returns undefined when the line is not found in any hunk', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n')
    expect(extractDiffContext(diff, 'a.ts', 999)).toBeUndefined()
  })

  it('returns undefined for an empty diff without throwing', () => {
    expect(extractDiffContext('', 'a.ts', 1)).toBeUndefined()
  })

  it('centers radius lines of context around a matched new-file line', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,10 +1,10 @@',
      ' line1',
      ' line2',
      ' line3',
      ' line4',
      ' line5',
      ' line6',
      ' line7',
      ' line8',
      ' line9',
      ' line10',
    ].join('\n')
    expect(extractDiffContext(diff, 'f.ts', 5, 3)).toEqual([
      { type: 'context', text: 'line2', oldLine: 2, newLine: 2 },
      { type: 'context', text: 'line3', oldLine: 3, newLine: 3 },
      { type: 'context', text: 'line4', oldLine: 4, newLine: 4 },
      { type: 'context', text: 'line5', oldLine: 5, newLine: 5 },
      { type: 'context', text: 'line6', oldLine: 6, newLine: 6 },
      { type: 'context', text: 'line7', oldLine: 7, newLine: 7 },
      { type: 'context', text: 'line8', oldLine: 8, newLine: 8 },
    ])
  })

  it('clamps the radius at the start of a hunk instead of padding', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,10 +1,10 @@',
      ' line1',
      ' line2',
      ' line3',
      ' line4',
      ' line5',
    ].join('\n')
    expect(extractDiffContext(diff, 'f.ts', 1, 3)).toEqual([
      { type: 'context', text: 'line1', oldLine: 1, newLine: 1 },
      { type: 'context', text: 'line2', oldLine: 2, newLine: 2 },
      { type: 'context', text: 'line3', oldLine: 3, newLine: 3 },
      { type: 'context', text: 'line4', oldLine: 4, newLine: 4 },
    ])
  })

  it('clamps the radius at the end of a hunk instead of padding', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,10 +1,10 @@',
      ' line1',
      ' line2',
      ' line3',
      ' line4',
      ' line5',
    ].join('\n')
    expect(extractDiffContext(diff, 'f.ts', 5, 3)).toEqual([
      { type: 'context', text: 'line2', oldLine: 2, newLine: 2 },
      { type: 'context', text: 'line3', oldLine: 3, newLine: 3 },
      { type: 'context', text: 'line4', oldLine: 4, newLine: 4 },
      { type: 'context', text: 'line5', oldLine: 5, newLine: 5 },
    ])
  })

  it('never crosses into a second hunk in the same file, even when radius would reach it', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,3 +1,3 @@',
      ' a1',
      ' a2',
      ' a3',
      '@@ -50,3 +50,3 @@',
      ' b1',
      ' b2',
      ' b3',
    ].join('\n')
    // a3 is the last line of hunk 1; radius 3 would reach 3 lines into hunk 2 if hunks
    // were flattened together. It must not.
    expect(extractDiffContext(diff, 'f.ts', 3, 3)).toEqual([
      { type: 'context', text: 'a1', oldLine: 1, newLine: 1 },
      { type: 'context', text: 'a2', oldLine: 2, newLine: 2 },
      { type: 'context', text: 'a3', oldLine: 3, newLine: 3 },
    ])
  })

  it('classifies add and remove lines, and picks the requested file out of a multi-file diff', () => {
    const diff = [
      'diff --git a/first.ts b/first.ts',
      '--- a/first.ts',
      '+++ b/first.ts',
      '@@ -1,1 +1,1 @@',
      '-old first',
      '+new first',
      'diff --git a/second.ts b/second.ts',
      '--- a/second.ts',
      '+++ b/second.ts',
      '@@ -1,1 +1,1 @@',
      '-old second',
      '+new second',
    ].join('\n')
    expect(extractDiffContext(diff, 'second.ts', 1, 3)).toEqual([
      { type: 'remove', text: 'old second', oldLine: 1 },
      { type: 'add', text: 'new second', newLine: 1 },
    ])
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd server && npx vitest run test/diffContext.test.ts`
Expected: FAIL — `Cannot find module '../src/review/diffContext.js'` (or equivalent resolve error). If any test fails for a different reason, fix the test file, not the (nonexistent) implementation.

- [ ] **Step 3: Implement `diffContext.ts`**

Create `server/src/review/diffContext.ts`:

```ts
export interface DiffContextLine {
  type: 'context' | 'add' | 'remove'
  text: string
  newLine?: number
  oldLine?: number
}

/** Groups a unified diff's raw lines by file, keyed by the b/ (destination) path — the
 * same rename convention parseDiffStats (contextPack.ts) uses: the b/ path wins. */
function splitByFile(diff: string): Map<string, string[]> {
  const files = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (header) {
      current = []
      files.set(header[2], current)
      continue
    }
    current?.push(line)
  }
  return files
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Parses one file's diff lines into hunks of typed, line-numbered content. Context lines
 * increment both old/new counters; additions increment only new; removals increment only
 * old — standard unified diff semantics. */
function parseHunks(lines: string[]): DiffContextLine[][] {
  const hunks: DiffContextLine[][] = []
  let oldLine = 0
  let newLine = 0
  let current: DiffContextLine[] | undefined
  for (const line of lines) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      current = []
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith(' ')) {
      current.push({ type: 'context', text: line.slice(1), oldLine, newLine })
      oldLine++
      newLine++
    } else if (line.startsWith('+')) {
      current.push({ type: 'add', text: line.slice(1), newLine })
      newLine++
    } else if (line.startsWith('-')) {
      current.push({ type: 'remove', text: line.slice(1), oldLine })
      oldLine++
    }
  }
  return hunks
}

/** Extracts up to `radius` lines of diff context on each side of `file`'s line `line`
 * (matched against the new-file/post-PR line number). Returns undefined when the file or
 * line can't be located — never throws. The returned slice is clamped to the hunk the
 * match falls in; it never extends into a neighboring hunk, since the diff omits the
 * unchanged gap between hunks and flattening them would misrepresent unrelated code as
 * adjacent. */
export function extractDiffContext(
  diff: string,
  file: string,
  line: number,
  radius = 3,
): DiffContextLine[] | undefined {
  const fileLines = splitByFile(diff).get(file)
  if (!fileLines) return undefined
  for (const hunk of parseHunks(fileLines)) {
    const idx = hunk.findIndex((l) => l.newLine === line)
    if (idx === -1) continue
    const start = Math.max(0, idx - radius)
    const end = Math.min(hunk.length, idx + radius + 1)
    return hunk.slice(start, end)
  }
  return undefined
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd server && npx vitest run test/diffContext.test.ts`
Expected: PASS, all 8 tests, no console warnings.

- [ ] **Step 5: Commit**

```bash
cd /Users/mohammadsafia/Desktop/projects/pr-reviewer
git add server/src/review/diffContext.ts server/test/diffContext.test.ts
git commit -m "feat: extract diff context around a finding's line"
```

---

### Task 2: Wire context into the run pipeline

**Files:**
- Modify: `server/src/types.ts` (`Finding` interface)
- Modify: `web/src/types.ts` (`Finding` interface)
- Modify: `server/src/app.ts:1-20` (imports), `server/src/app.ts:412` (`run.findings = findings`)
- Modify: `server/test/runPipeline.test.ts`

**Interfaces:**
- Consumes: `extractDiffContext(diff, file, line, radius?)` and `DiffContextLine` from Task 1.
- Produces: `Finding.context?: DiffContextLine[]` on both server and web `Finding` types — Task 3 consumes this on the web side.

- [ ] **Step 1: Add `context` to the server `Finding` type**

In `server/src/types.ts`, add the import at the top of the file and extend `Finding`:

```ts
import type { DiffContextLine } from './review/diffContext.js'
```

```ts
export interface Finding {
  file: string
  line: number
  severity: Severity
  category: string
  summary: string
  detail: string
  suggestion: string
  /** Short fenced before/after code snippet. Empty/absent on legacy runs and when the
   * model omitted it — renderers must degrade gracefully. */
  example?: string
  /** A few lines of surrounding diff context, extracted from the diff at review time.
   * Absent when the line couldn't be located in the diff, and on runs recorded before this
   * field existed — renderers must degrade gracefully. */
  context?: DiffContextLine[]
  skills: string[]
  verdict: 'confirmed' | 'unverified'
  verifierReason?: string
}
```

- [ ] **Step 2: Add the matching field to the web `Finding` type**

`web/src/types.ts` has its own independent copy of `Finding` (not shared with the server package). Add the same interface and field there:

```ts
export interface DiffContextLine {
  type: 'context' | 'add' | 'remove'
  text: string
  newLine?: number
  oldLine?: number
}

export interface Finding {
  file: string
  line: number
  severity: Severity
  category: string
  summary: string
  detail: string
  suggestion: string
  /** Short fenced before/after code snippet. Empty/absent on legacy runs and when the
   * model omitted it — renderers must degrade gracefully. */
  example?: string
  /** A few lines of surrounding diff context, extracted from the diff at review time.
   * Absent when the line couldn't be located in the diff, and on runs recorded before this
   * field existed — renderers must degrade gracefully. */
  context?: DiffContextLine[]
  skills: string[]
  verdict: 'confirmed' | 'unverified'
  verifierReason?: string
}
```

- [ ] **Step 3: Write the failing integration test**

In `server/test/runPipeline.test.ts`, add a new test inside `describe('run pipeline integration', ...)`, after the existing "drives POST /api/runs..." test:

```ts
  it('attaches diff context to a finding whose line is present in the diff', async () => {
    const path = tempConfig()
    const diff = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1,1 +1,1 @@', '-main', '+feature'].join(
      '\n',
    )
    const finding = {
      file: 'a.txt',
      line: 1,
      severity: 'low',
      category: 'style',
      summary: 's',
      detail: 'd',
      suggestion: 'x',
      skill: 'review-code',
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgent([finding]),
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [] },
    })
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    expect(run.findings[0].context).toEqual([
      { type: 'remove', text: 'main', oldLine: 1 },
      { type: 'add', text: 'feature', newLine: 1 },
    ])
  })
```

- [ ] **Step 4: Run the test and verify it fails**

Run: `cd server && npx vitest run test/runPipeline.test.ts -t "attaches diff context"`
Expected: FAIL — `run.findings[0].context` is `undefined`, not the expected array (the field doesn't exist yet on the finding).

- [ ] **Step 5: Wire the extraction call into `app.ts`**

Add the import near the other `review/` imports (`server/src/app.ts`, next to `import { writeContextPack } from './review/contextPack.js'`):

```ts
import { extractDiffContext } from './review/diffContext.js'
```

Find `run.findings = findings` (currently `server/src/app.ts:412`, right after the `findings.sort(...)` call) and insert the attachment loop immediately before it:

```ts
      findings.forEach((f) => {
        f.context = extractDiffContext(ctx.diff, f.file, f.line)
      })
      run.findings = findings
```

- [ ] **Step 6: Run the full server test suite and verify it passes**

Run: `cd server && npm test`
Expected: PASS, all tests including the new one and the pre-existing "drives POST /api/runs..." test (which uses a non-unified-diff fixture `'+line1\n+line2\n'` — `extractDiffContext` returns `undefined` for it, and `toEqual` treats an `undefined`-valued `context` key as equivalent to it being absent, so that test's exact-equality assertion is unaffected).

- [ ] **Step 7: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/mohammadsafia/Desktop/projects/pr-reviewer
git add server/src/types.ts web/src/types.ts server/src/app.ts server/test/runPipeline.test.ts
git commit -m "feat: attach diff context to findings during the run pipeline"
```

---

### Task 3: Show context on `FindingCard`

**Files:**
- Modify: `web/src/components/FindingCard.tsx`

**Interfaces:**
- Consumes: `Finding.context?: DiffContextLine[]` from Task 2; `Collapsible`/`Collapsible.Trigger`/`Collapsible.Content` from `@/components/ui/collapsible` (existing primitive, already used in `web/src/pages/NewReview.tsx` for "+ Add reviewer focus"); `cn` from `@/lib/utils`.

No new unit tests — this repo has no component-rendering test harness (`web/test/*.test.ts` covers only pure functions extracted from page/component files; there is no `@testing-library/react` dependency). Verification is the typecheck + build + full test-suite steps below, consistent with how `FindingCard.tsx`'s prior changes (B1–B3 in the earlier round) were verified.

- [ ] **Step 1: Add the import**

In `web/src/components/FindingCard.tsx`, add to the existing import block:

```ts
import { Collapsible } from '@/components/ui/collapsible'
```

- [ ] **Step 2: Render the collapsed context toggle**

Insert this block right after the existing `finding.suggestion` block (i.e. as the last child inside the `<div className="flex min-w-0 flex-1 flex-col gap-1.5">` wrapper, right before its closing `</div>`):

```tsx
          {finding.context && finding.context.length > 0 && (
            <Collapsible>
              <Collapsible.Trigger className="text-muted-foreground hover:text-foreground w-fit text-xs">
                Show context
              </Collapsible.Trigger>
              <Collapsible.Content>
                <pre className="bg-code-surface text-code-foreground font-family-mono mt-1 overflow-x-auto rounded-md p-3 text-xs">
                  {finding.context.map((l, i) => (
                    <div
                      key={i}
                      className={cn(
                        'flex gap-2',
                        l.type === 'add' && 'text-success',
                        l.type === 'remove' && 'text-destructive',
                      )}
                    >
                      <span className="text-muted-foreground w-8 shrink-0 text-right select-none">
                        {l.type === 'remove' ? l.oldLine : l.newLine}
                      </span>
                      <span className="w-3 shrink-0 select-none">
                        {l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ''}
                      </span>
                      <span className="whitespace-pre">{l.text}</span>
                    </div>
                  ))}
                </pre>
              </Collapsible.Content>
            </Collapsible>
          )}
```

- [ ] **Step 3: Run the full web test suite**

Run: `cd web && npx vitest run`
Expected: PASS, all existing tests (no new ones needed for this presentational-only change; `FindingCard.tsx` has no pure-function exports).

- [ ] **Step 4: Typecheck and build**

Run: `cd web && npm run build`
Expected: `tsc --noEmit` reports no errors and the Vite build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /Users/mohammadsafia/Desktop/projects/pr-reviewer
git add web/src/components/FindingCard.tsx
git commit -m "feat(ui): show collapsed diff context on finding cards"
```
