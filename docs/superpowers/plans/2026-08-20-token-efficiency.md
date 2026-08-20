# Token Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut per-run token cost by removing the inline diff from every prompt (context pack on disk), grouping skills into fewer agent sessions (depth modes), verifying all findings in one cheap-model session, and making posted comments compact and example-driven.

**Architecture:** A per-run "context pack" (`.pr-review/diff.patch` + `.pr-review/pr.md`) is written into the repo checkout; review and verify prompts point at it instead of embedding the diff. Skills are chunked into session groups by a per-run depth mode (thorough/balanced/economy). Verification becomes one batched session per run on a configurable cheap model. The comment body moves to a compact emoji/why/example/fix template shared by server and web preview.

**Tech Stack:** Node 20 + TypeScript ESM (imports use `.js` suffixes), Fastify, zod, `@anthropic-ai/claude-agent-sdk`, vitest; React + Vite on the web side.

**Spec:** `docs/superpowers/specs/2026-08-20-token-efficiency-design.md`

## Global Constraints

- ESM everywhere: relative imports end in `.js` even from `.ts` files (existing convention).
- No new npm dependencies.
- `verifyModel` default: exactly `claude-haiku-4-5-20251001`. `defaultDepth` default: exactly `balanced`.
- Depth chunk sizes: thorough = 1 skill/session, balanced = 3, economy = all.
- Batch verification chunk size: 20 findings per session.
- The batch verify prompt MUST contain the phrase `adversarially verifying` — test fakes across the suite dispatch on it.
- The review prompt MUST NOT contain the diff body; it points at `.pr-review/diff.patch` and `.pr-review/pr.md`.
- Verification must never drop a finding: every error path fails open to `verdict: 'confirmed'` with a reason.
- Server tests: `cd server && npx vitest run test/<file>`. Web tests: `cd web && npx vitest run test/<file>`. Full suite: `npm test` at repo root.
- Commit after every task. Never commit unrelated working-tree changes (the tree may carry pre-existing modifications; `git add` only the files your task touched).

---

### Task 1: Config fields `verifyModel` and `defaultDepth`

**Files:**
- Modify: `server/src/config.ts` (schema at lines 8–20)
- Modify: `server/src/types.ts` (add `Depth` type)
- Test: `server/test/config.test.ts`

**Interfaces:**
- Consumes: existing `ConfigSchema` / `loadConfig`.
- Produces: `Config.verifyModel: string` (default `'claude-haiku-4-5-20251001'`), `Config.defaultDepth: Depth` (default `'balanced'`), and `export type Depth = 'thorough' | 'balanced' | 'economy'` in `server/src/types.ts`. Later tasks import `Depth` from `../types.js` and read both config fields.

- [ ] **Step 1: Write the failing test** — append to `server/test/config.test.ts`:

```ts
describe('verifyModel and defaultDepth', () => {
  it('defaults verifyModel and defaultDepth when absent from stored config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-config-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ model: 'claude-sonnet-5' }))
    const cfg = loadConfig(path)
    expect(cfg.verifyModel).toBe('claude-haiku-4-5-20251001')
    expect(cfg.defaultDepth).toBe('balanced')
  })

  it('preserves stored verifyModel and defaultDepth, and falls back per-field on invalid depth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-config-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ verifyModel: 'claude-sonnet-5', defaultDepth: 'bogus' }))
    const cfg = loadConfig(path)
    expect(cfg.verifyModel).toBe('claude-sonnet-5')
    expect(cfg.defaultDepth).toBe('balanced') // invalid enum value → that field's default
  })
})
```

(Reuse the file's existing imports; add `mkdtempSync`/`writeFileSync`/`tmpdir`/`join` imports only if not already present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/config.test.ts`
Expected: FAIL — `verifyModel` is `undefined`.

- [ ] **Step 3: Implement** — in `server/src/types.ts` add near the top:

```ts
export type Depth = 'thorough' | 'balanced' | 'economy'
```

In `server/src/config.ts`, inside `ConfigSchema` after the `model` field:

```ts
  verifyModel: z.string().default('claude-haiku-4-5-20251001'),
  defaultDepth: z.enum(['thorough', 'balanced', 'economy']).default('balanced'),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/config.test.ts`
Expected: PASS (including all pre-existing cases — the per-field degradation loop in `loadConfig` handles the new fields automatically).

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/src/types.ts server/test/config.test.ts
git commit -m "feat: add verifyModel and defaultDepth config fields"
```

---

### Task 2: Context pack module

**Files:**
- Create: `server/src/review/contextPack.ts`
- Test: `server/test/contextPack.test.ts`

**Interfaces:**
- Consumes: `PrMeta` from `../types.js`.
- Produces:
  - `parseDiffStats(diff: string): { file: string; added: number; removed: number }[]`
  - `buildPrManifest(meta: PrMeta, diff: string): string`
  - `writeContextPack(cwd: string, meta: PrMeta, diff: string): void` — throws on fs errors (callers treat that as fatal).

- [ ] **Step 1: Write the failing test** — create `server/test/contextPack.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPrManifest, parseDiffStats, writeContextPack } from '../src/review/contextPack.js'
import type { PrMeta } from '../src/types.js'

const meta: PrMeta = {
  title: 'My PR',
  description: 'does things',
  sourceBranch: 'feat/x',
  destinationBranch: 'main',
  sourceCommit: 'abc',
}

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' unchanged',
  '+added one',
  '+added two',
  '-removed one',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/old.ts b/new.ts',
  '--- a/old.ts',
  '+++ b/new.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
].join('\n')

describe('parseDiffStats', () => {
  it('counts added/removed per file, ignores +++/--- headers, handles binary and renames', () => {
    expect(parseDiffStats(diff)).toEqual([
      { file: 'src/a.ts', added: 2, removed: 1 },
      { file: 'img.png', added: 0, removed: 0 },
      { file: 'new.ts', added: 1, removed: 1 }, // rename: the b/ path wins
    ])
  })

  it('returns [] for an empty diff', () => {
    expect(parseDiffStats('')).toEqual([])
  })
})

describe('buildPrManifest', () => {
  it('renders title, description, branches, and the changed-file list with counts', () => {
    const md = buildPrManifest(meta, diff)
    expect(md).toContain('# PR: My PR')
    expect(md).toContain('does things')
    expect(md).toContain('feat/x → main')
    expect(md).toContain('## Changed files (3)')
    expect(md).toContain('- src/a.ts (+2/-1)')
  })

  it('renders (none) when the description is empty', () => {
    expect(buildPrManifest({ ...meta, description: '' }, diff)).toContain('(none)')
  })
})

describe('writeContextPack', () => {
  function tempCheckout(): string {
    const dir = mkdtempSync(join(tmpdir(), 'prr-pack-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    return dir
  }

  it('writes diff.patch and pr.md and excludes .pr-review/ via .git/info/exclude', () => {
    const cwd = tempCheckout()
    writeContextPack(cwd, meta, diff)
    expect(readFileSync(join(cwd, '.pr-review', 'diff.patch'), 'utf8')).toBe(diff)
    expect(readFileSync(join(cwd, '.pr-review', 'pr.md'), 'utf8')).toContain('# PR: My PR')
    expect(readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')).toContain('.pr-review/')
  })

  it('removes stale contents from a previous run and does not duplicate the exclude entry', () => {
    const cwd = tempCheckout()
    mkdirSync(join(cwd, '.pr-review'), { recursive: true })
    writeFileSync(join(cwd, '.pr-review', 'stale.txt'), 'old')
    writeContextPack(cwd, meta, diff)
    writeContextPack(cwd, meta, diff) // second run: exclude entry must not duplicate
    expect(existsSync(join(cwd, '.pr-review', 'stale.txt'))).toBe(false)
    const exclude = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter((l) => l === '.pr-review/')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/contextPack.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `server/src/review/contextPack.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PrMeta } from '../types.js'

export interface DiffStat {
  file: string
  added: number
  removed: number
}

export function parseDiffStats(diff: string): DiffStat[] {
  const stats: DiffStat[] = []
  let cur: DiffStat | undefined
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (header) {
      cur = { file: header[2], added: 0, removed: 0 }
      stats.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) cur.added++
    else if (line.startsWith('-')) cur.removed++
  }
  return stats
}

export function buildPrManifest(meta: PrMeta, diff: string): string {
  const stats = parseDiffStats(diff)
  const files = stats.map((s) => `- ${s.file} (+${s.added}/-${s.removed})`).join('\n')
  return [
    `# PR: ${meta.title}`,
    '',
    meta.description || '(none)',
    '',
    `Branches: ${meta.sourceBranch} → ${meta.destinationBranch}`,
    '',
    `## Changed files (${stats.length})`,
    files,
    '',
  ].join('\n')
}

/** Writes the per-run context pack into the checkout. Deletes any previous pack first so a
 * run can never see stale data, and hides the directory from git via .git/info/exclude
 * (never the repo's tracked .gitignore). Throws on any fs error — callers treat that as
 * fatal to the run. */
export function writeContextPack(cwd: string, meta: PrMeta, diff: string): void {
  const dir = join(cwd, '.pr-review')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'diff.patch'), diff)
  writeFileSync(join(dir, 'pr.md'), buildPrManifest(meta, diff))
  const excludePath = join(cwd, '.git', 'info', 'exclude')
  mkdirSync(dirname(excludePath), { recursive: true })
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  if (!existing.split('\n').includes('.pr-review/')) {
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
    writeFileSync(excludePath, `${existing}${sep}.pr-review/\n`)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/contextPack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/review/contextPack.ts server/test/contextPack.test.ts
git commit -m "feat: context pack — diff.patch + pr.md written into the checkout"
```

---

### Task 3: Skill grouping module

**Files:**
- Create: `server/src/review/grouping.ts`
- Test: `server/test/skillGrouping.test.ts` (a `web/test/grouping.test.ts` already exists for an unrelated web helper — do not touch it)

**Interfaces:**
- Consumes: `Depth` from `../types.js` (Task 1).
- Produces: `groupSkills<T>(items: T[], depth: Depth): T[][]` — order-preserving chunking; `[]` in → `[]` out.

- [ ] **Step 1: Write the failing test** — create `server/test/skillGrouping.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { groupSkills } from '../src/review/grouping.js'

const skills = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

describe('groupSkills', () => {
  it('thorough → one skill per group', () => {
    expect(groupSkills(skills(3), 'thorough')).toEqual([['s0'], ['s1'], ['s2']])
  })
  it('balanced → chunks of 3, remainder in the last group', () => {
    expect(groupSkills(skills(7), 'balanced')).toEqual([
      ['s0', 's1', 's2'],
      ['s3', 's4', 's5'],
      ['s6'],
    ])
  })
  it('economy → everything in one group', () => {
    expect(groupSkills(skills(5), 'economy')).toEqual([['s0', 's1', 's2', 's3', 's4']])
  })
  it('empty input → no groups, for every depth', () => {
    expect(groupSkills([], 'thorough')).toEqual([])
    expect(groupSkills([], 'balanced')).toEqual([])
    expect(groupSkills([], 'economy')).toEqual([])
  })
  it('single skill → one group of one, for every depth', () => {
    expect(groupSkills(['a'], 'balanced')).toEqual([['a']])
    expect(groupSkills(['a'], 'economy')).toEqual([['a']])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/skillGrouping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `server/src/review/grouping.ts`:

```ts
import type { Depth } from '../types.js'

/** Chunks skills into session groups by review depth. Order-preserving. */
export function groupSkills<T>(items: T[], depth: Depth): T[][] {
  if (items.length === 0) return []
  const size = depth === 'thorough' ? 1 : depth === 'balanced' ? 3 : items.length
  const groups: T[][] = []
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size))
  return groups
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/skillGrouping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/review/grouping.ts server/test/skillGrouping.test.ts
git commit -m "feat: groupSkills — chunk skills into session groups by depth"
```

---

### Task 4: Findings contract — `example` field, `validSkills` reattribution, dedup carries examples

**Files:**
- Modify: `server/src/review/findings.ts` (schema lines 11–20, `extractFindings` lines 30–46)
- Modify: `server/src/review/dedup.ts`
- Modify: `server/src/types.ts` (`Finding`)
- Test: `server/test/findings.test.ts`, `server/test/dedup.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `Finding.example?: string` (server `types.ts`).
  - `FindingSchema` gains `example: z.string().default('')`.
  - `extractFindings(text: string, validSkills: string[]): Finding[]` — NEW required second parameter. A finding whose `skill` is not in `validSkills` is attributed to `validSkills[0]`.
  - `dedupeFindings` keeps the longer `example` when merging (same rule as `detail`/`suggestion`).

- [ ] **Step 1: Write the failing tests** — append to `server/test/findings.test.ts` (and update every existing `extractFindings(text)` call in that file to `extractFindings(text, ['general'])` — with `['general']` the reattribution reproduces the old single-unit behavior, so existing assertions that expect `skills: ['general']`-agnostic output need only the changed call; where an existing assertion checks `skills: [<original label>]`, pass that label in `validSkills` instead):

```ts
const base = {
  file: 'a.ts',
  line: 1,
  severity: 'low',
  category: 'style',
  summary: 's',
  detail: 'd',
  suggestion: 'x',
}

describe('extractFindings with validSkills', () => {
  it('keeps a skill label that is in validSkills', () => {
    const text = '```json\n' + JSON.stringify([{ ...base, skill: 'skill-b' }]) + '\n```'
    const [f] = extractFindings(text, ['skill-a', 'skill-b'])
    expect(f.skills).toEqual(['skill-b'])
  })

  it('reattributes an unknown skill label to the first valid skill', () => {
    const text = '```json\n' + JSON.stringify([{ ...base, skill: 'made-up' }]) + '\n```'
    const [f] = extractFindings(text, ['skill-a', 'skill-b'])
    expect(f.skills).toEqual(['skill-a'])
  })

  it('defaults example to empty string when the model omits it', () => {
    const text = '```json\n' + JSON.stringify([{ ...base, skill: 'skill-a' }]) + '\n```'
    const [f] = extractFindings(text, ['skill-a'])
    expect(f.example).toBe('')
  })

  it('passes example through when present', () => {
    const text =
      '```json\n' + JSON.stringify([{ ...base, skill: 'skill-a', example: '```ts\n// before\n```' }]) + '\n```'
    const [f] = extractFindings(text, ['skill-a'])
    expect(f.example).toBe('```ts\n// before\n```')
  })
})
```

Append to `server/test/dedup.test.ts` (match the file's existing finding fixture style):

```ts
it('keeps the longer example when merging duplicate findings', () => {
  const a = { file: 'a.ts', line: 1, severity: 'low' as const, category: 'style', summary: 's', detail: 'd', suggestion: 'x', skills: ['s1'], verdict: 'confirmed' as const, example: 'short' }
  const b = { ...a, skills: ['s2'], example: 'much longer example text' }
  const [merged] = dedupeFindings([a, b])
  expect(merged.example).toBe('much longer example text')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/findings.test.ts test/dedup.test.ts`
Expected: FAIL — `example` undefined / reattribution not applied.

- [ ] **Step 3: Implement**

In `server/src/types.ts`, add to `Finding` (after `suggestion`):

```ts
  /** Short fenced before/after code snippet. Empty/absent on legacy runs and when the
   * model omitted it — renderers must degrade gracefully. */
  example?: string
```

In `server/src/review/findings.ts`, add to `FindingSchema` after `suggestion`:

```ts
  example: z.string().default(''),
```

Replace `extractFindings`:

```ts
export function extractFindings(text: string, validSkills: string[]): Finding[] {
  const raw = candidateJson(text)
  if (raw === undefined) throw new FindingsParseError()
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    throw new FindingsParseError()
  }
  if (!Array.isArray(arr)) throw new FindingsParseError()
  return arr.flatMap((item) => {
    const parsed = FindingSchema.safeParse(item)
    if (!parsed.success) return []
    const { skill, ...rest } = parsed.data
    // Never discard a real finding over a labeling error: unknown labels fall back to the
    // session's first skill.
    const attributed = validSkills.includes(skill) ? skill : validSkills[0]
    return [{ ...rest, skills: [attributed], verdict: 'confirmed' as const }]
  })
}
```

In `server/src/review/dedup.ts`, inside the merge branch after the `suggestion` line:

```ts
    cur.example = longer(cur.example ?? '', f.example ?? '')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/findings.test.ts test/dedup.test.ts`
Expected: PASS. (`test/runner.test.ts` and the pipeline test will be broken by the signature change until Tasks 6 and 9 — that's expected; do not run the full suite green-gate until Task 9.)

- [ ] **Step 5: Commit**

```bash
git add server/src/types.ts server/src/review/findings.ts server/src/review/dedup.ts server/test/findings.test.ts server/test/dedup.test.ts
git commit -m "feat: findings gain example field and validSkills attribution"
```

---

### Task 5: Review prompt rewrite — context-pack pointers, multi-skill, example contract

**Files:**
- Modify: `server/src/review/prompt.ts` (full rewrite of `buildReviewPrompt`)
- Test: `server/test/prompt.test.ts`

**Interfaces:**
- Consumes: `PrMeta`.
- Produces: `buildReviewPrompt(input: { meta: PrMeta; skills: { name: string; content: string }[]; focus?: string }): string` — the `diff` parameter is REMOVED. Runner (Task 6) calls this new signature.

- [ ] **Step 1: Rewrite the test** — replace the body of `server/test/prompt.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { buildReviewPrompt } from '../src/review/prompt.js'
import type { PrMeta } from '../src/types.js'

const meta: PrMeta = {
  title: 'T',
  description: 'D',
  sourceBranch: 'feat/x',
  destinationBranch: 'main',
  sourceCommit: 'abc',
}

describe('buildReviewPrompt', () => {
  it('points at the context pack and never embeds a diff', () => {
    const p = buildReviewPrompt({ meta, skills: [{ name: 'sec', content: 'check auth' }] })
    expect(p).toContain('.pr-review/pr.md')
    expect(p).toContain('.pr-review/diff.patch')
    expect(p).not.toContain('```diff')
  })

  it('embeds every skill section and constrains the skill field to session names', () => {
    const p = buildReviewPrompt({
      meta,
      skills: [
        { name: 'sec', content: 'check auth' },
        { name: 'perf', content: 'check loops' },
      ],
    })
    expect(p).toContain('## Skill: sec')
    expect(p).toContain('check auth')
    expect(p).toContain('## Skill: perf')
    expect(p).toContain('["sec","perf"]')
  })

  it('falls back to a general review with skill name "general" when no skills are given', () => {
    const p = buildReviewPrompt({ meta, skills: [] })
    expect(p).toContain('general code review')
    expect(p).toContain('["general"]')
  })

  it('includes the focus section only when focus is set', () => {
    expect(buildReviewPrompt({ meta, skills: [], focus: 'dates' })).toContain('# Reviewer focus\ndates')
    expect(buildReviewPrompt({ meta, skills: [] })).not.toContain('# Reviewer focus')
  })

  it('demands the example field and the two-sentence detail cap in the output contract', () => {
    const p = buildReviewPrompt({ meta, skills: [] })
    expect(p).toContain('"example"')
    expect(p).toContain('// before')
    expect(p).toMatch(/two sentences/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/prompt.test.ts`
Expected: FAIL — old signature requires `diff`; assertions on pack pointers fail.

- [ ] **Step 3: Implement** — replace `server/src/review/prompt.ts` with:

```ts
import type { PrMeta } from '../types.js'

export function buildReviewPrompt(input: {
  meta: PrMeta
  skills: { name: string; content: string }[]
  focus?: string
}): string {
  const { meta, skills, focus } = input
  const skillSections = skills
    .map((s) => `## Skill: ${s.name}\n\n${s.content}`)
    .join('\n\n')
  const skillNames = skills.length > 0 ? skills.map((s) => s.name) : ['general']

  return `You are performing a code review of a pull request.
The repository is checked out at your working directory at the PR's head commit.

READ FIRST (with the Read tool):
- .pr-review/pr.md — the PR's title, description, and changed-file list with per-file line counts
- .pr-review/diff.patch — the full diff. Read ONLY the sections relevant to your skills; use the changed-file list in pr.md to decide which files to skip entirely.

Use Read/Grep/Glob to inspect surrounding code — do not limit yourself to the diff.

# Pull request
Title: ${meta.title}
Source branch: ${meta.sourceBranch} → Destination: ${meta.destinationBranch}

# Mandatory review instructions
Apply EVERY skill below. Each is mandatory, not optional.

${skillSections || '(no extra skills selected — perform a general code review)'}
${focus ? `\n# Reviewer focus\n${focus}\n` : ''}
# Output contract (strict)
After your investigation, end your reply with ONE fenced \`\`\`json block containing a JSON array.
Each element must be exactly:
{
  "file": "path relative to repo root",
  "line": <positive integer — line in the NEW file version>,
  "severity": "high" | "medium" | "low" | "info",
  "category": "bug" | "security" | "performance" | "a11y" | "rtl" | "style" | "convention",
  "summary": "one sentence",
  "detail": "the reasoning, AT MOST two sentences",
  "suggestion": "concrete fix in one or two sentences",
  "example": "a short fenced code block showing the fix as // before and // after, or \\"\\" if no code example applies",
  "skill": <the skill that produced this finding — MUST be one of ${JSON.stringify(skillNames)}>
}
Only report findings on files listed in .pr-review/pr.md, on lines changed in the diff.
An empty array [] is a valid result.
Do not put any text after the json block.`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/review/prompt.ts server/test/prompt.test.ts
git commit -m "feat: review prompt points at the context pack instead of embedding the diff"
```

---

### Task 6: Runner — grouped `runReview`, reformat retry on the cheap model

**Files:**
- Modify: `server/src/review/runner.ts` (`runReview` at lines 85–107; `buildQueryOptions`/`sdkQuery`/`runOnce` are unchanged)
- Test: `server/test/runner.test.ts`

**Interfaces:**
- Consumes: `buildReviewPrompt` (Task 5 signature), `extractFindings(text, validSkills)` (Task 4).
- Produces:

```ts
runReview(
  input: {
    meta: PrMeta
    skills: { name: string; content: string }[]
    focus?: string
    cwd: string
    model: string
    reformatModel: string
  },
  onEvent: (e: RunEvent) => void,
  agentQuery?: AgentQuery,
): Promise<Finding[]>
```

The `diff` input field is REMOVED. `validSkills` is derived internally: `skills.map(s => s.name)`, or `['general']` when empty. The malformed-output retry runs on `reformatModel`.

- [ ] **Step 1: Update/extend the tests** — in `server/test/runner.test.ts`, update every `runReview({...})` call: drop `diff`, add `reformatModel: 'cheap-model'`. Then append:

```ts
it('derives validSkills from the skill group and reattributes unknown labels', async () => {
  const finding = { file: 'a.ts', line: 1, severity: 'low', category: 'style', summary: 's', detail: 'd', suggestion: 'x', skill: 'nonsense' }
  const agent: AgentQuery = async function* () {
    yield { type: 'result', ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
  }
  const out = await runReview(
    { meta, skills: [{ name: 'sec', content: 'c' }, { name: 'perf', content: 'c' }], cwd: '/tmp', model: 'm', reformatModel: 'cheap' },
    () => {},
    agent,
  )
  expect(out[0].skills).toEqual(['sec'])
})

it('runs the reformat retry on reformatModel, not the main model', async () => {
  const models: string[] = []
  const finding = { file: 'a.ts', line: 1, severity: 'low', category: 'style', summary: 's', detail: 'd', suggestion: 'x', skill: 'general' }
  let call = 0
  const agent: AgentQuery = async function* (_prompt, opts) {
    models.push(opts.model)
    call++
    if (call === 1) {
      yield { type: 'result', ok: true, text: 'no json here' }
    } else {
      yield { type: 'result', ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
    }
  }
  const out = await runReview(
    { meta, skills: [], cwd: '/tmp', model: 'main-model', reformatModel: 'cheap-model' },
    () => {},
    agent,
  )
  expect(out).toHaveLength(1)
  expect(models).toEqual(['main-model', 'cheap-model'])
})
```

(Reuse the file's existing `meta` fixture and imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/runner.test.ts`
Expected: FAIL — type errors on the new input shape / retry uses the main model.

- [ ] **Step 3: Implement** — replace `runReview` in `server/src/review/runner.ts`:

```ts
export async function runReview(
  input: {
    meta: PrMeta
    skills: { name: string; content: string }[]
    focus?: string
    cwd: string
    model: string
    reformatModel: string
  },
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery = sdkQuery,
): Promise<Finding[]> {
  const validSkills = input.skills.length > 0 ? input.skills.map((s) => s.name) : ['general']
  const text = await runOnce(
    buildReviewPrompt(input),
    { cwd: input.cwd, model: input.model },
    onEvent,
    agentQuery,
  )
  try {
    return extractFindings(text, validSkills)
  } catch (err) {
    if (!(err instanceof FindingsParseError)) throw err
    onEvent({ kind: 'status', text: 'Output malformed — asking agent to reformat', at: new Date().toISOString() })
    // Pure formatting fix — no reasoning needed, so the cheap model handles the retry.
    const retryText = await runOnce(
      REFORMAT_PROMPT + text,
      { cwd: input.cwd, model: input.reformatModel },
      onEvent,
      agentQuery,
    )
    return extractFindings(retryText, validSkills)
  }
}
```

Also remove the now-unused `diff` from the `PrMeta`-adjacent imports only if flagged; `buildReviewPrompt` import stays.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/review/runner.ts server/test/runner.test.ts
git commit -m "feat: runReview takes a skill group, retries formatting on the cheap model"
```

---

### Task 7: Batched verification

**Files:**
- Modify: `server/src/review/verify.ts` (full rewrite; delete `buildVerifyPrompt`, `extractVerdict`, `verifyFinding`; keep `runVerifyTurn` as-is)
- Test: `server/test/verify.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `AgentQuery`/`sdkQuery` from `./runner.js`; `Finding`, `PrMeta`, `RunEvent` from `../types.js`.
- Produces:
  - `buildBatchVerifyPrompt(findings: Finding[], meta: PrMeta, offset: number): string` — contains the phrase `adversarially verifying`, context-pack pointers, and the findings as a ```json fence of `{ index, file, line, severity, category, summary, detail, suggestion }` (index is global: `offset + i`).
  - `extractBatchVerdicts(text: string): Map<number, { verdict: 'confirmed' | 'unverified'; reason?: string }> | undefined` — last json fence; `undefined` when unparseable; first verdict wins on duplicate indexes; invalid entries skipped.
  - `verifyFindingsBatch(findings: Finding[], ctx: { meta: PrMeta; cwd: string; model: string }, onEvent: (e: RunEvent) => void, agentQuery?: AgentQuery): Promise<{ verdict: 'confirmed' | 'unverified'; reason?: string }[]>` — result aligned index-for-index with the input; sequential chunks of 20; every error path fails open per the spec.

- [ ] **Step 1: Rewrite the test** — replace `server/test/verify.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { buildBatchVerifyPrompt, extractBatchVerdicts, verifyFindingsBatch } from '../src/review/verify.js'
import type { AgentQuery } from '../src/review/runner.js'
import type { Finding, PrMeta } from '../src/types.js'

const meta: PrMeta = { title: 'T', description: '', sourceBranch: 'f', destinationBranch: 'main', sourceCommit: '' }

const mkFinding = (n: number): Finding => ({
  file: `f${n}.ts`,
  line: n + 1,
  severity: 'low',
  category: 'style',
  summary: `finding ${n}`,
  detail: 'd',
  suggestion: 'x',
  skills: ['s'],
  verdict: 'confirmed',
})

const ok = (text: string) => ({ type: 'result' as const, ok: true, text })

describe('buildBatchVerifyPrompt', () => {
  it('carries the dispatch phrase, pack pointers, and globally-indexed findings — no inline diff', () => {
    const p = buildBatchVerifyPrompt([mkFinding(0), mkFinding(1)], meta, 20)
    expect(p).toContain('adversarially verifying')
    expect(p).toContain('.pr-review/diff.patch')
    expect(p).toContain('"index": 20')
    expect(p).toContain('"index": 21')
    expect(p).not.toContain('```diff')
  })
})

describe('extractBatchVerdicts', () => {
  it('parses the last json fence into a map, first verdict wins on duplicates, bad entries skipped', () => {
    const text =
      'thinking…\n```json\n' +
      JSON.stringify([
        { index: 0, verdict: 'confirmed' },
        { index: 1, verdict: 'unverified', reason: 'nope' },
        { index: 1, verdict: 'confirmed' },
        { index: 'bad', verdict: 'confirmed' },
      ]) +
      '\n```'
    const m = extractBatchVerdicts(text)!
    expect(m.get(0)).toEqual({ verdict: 'confirmed', reason: undefined })
    expect(m.get(1)).toEqual({ verdict: 'unverified', reason: 'nope' })
    expect(m.size).toBe(2)
  })

  it('returns undefined for unparseable text', () => {
    expect(extractBatchVerdicts('no json at all')).toBeUndefined()
    expect(extractBatchVerdicts('```json\n{"not":"array"}\n```')).toBeUndefined()
  })
})

describe('verifyFindingsBatch', () => {
  it('verifies all findings in one session and aligns verdicts with input order', async () => {
    let calls = 0
    const agent: AgentQuery = async function* (prompt) {
      calls++
      const items = JSON.parse(/```json\n([\s\S]*?)```/.exec(prompt)![1]) as { index: number; summary: string }[]
      yield ok(
        '```json\n' +
          JSON.stringify(items.map((it) => ({ index: it.index, verdict: it.summary === 'finding 1' ? 'unverified' : 'confirmed', reason: it.summary === 'finding 1' ? 'refuted' : undefined }))) +
          '\n```',
      )
    }
    const verdicts = await verifyFindingsBatch([mkFinding(0), mkFinding(1)], { meta, cwd: '/tmp', model: 'cheap' }, () => {}, agent)
    expect(calls).toBe(1)
    expect(verdicts[0].verdict).toBe('confirmed')
    expect(verdicts[1]).toEqual({ verdict: 'unverified', reason: 'refuted' })
  })

  it('fails open per finding when the verifier omits an index', async () => {
    const agent: AgentQuery = async function* () {
      yield ok('```json\n[{"index":0,"verdict":"confirmed"}]\n```')
    }
    const verdicts = await verifyFindingsBatch([mkFinding(0), mkFinding(1)], { meta, cwd: '/tmp', model: 'cheap' }, () => {}, agent)
    expect(verdicts[1]).toEqual({ verdict: 'confirmed', reason: 'verifier gave no verdict' })
  })

  it('retries once on unparseable output, then fails the whole chunk open', async () => {
    let calls = 0
    const agent: AgentQuery = async function* () {
      calls++
      yield ok('still not json')
    }
    const verdicts = await verifyFindingsBatch([mkFinding(0)], { meta, cwd: '/tmp', model: 'cheap' }, () => {}, agent)
    expect(calls).toBe(2)
    expect(verdicts[0].verdict).toBe('confirmed')
    expect(verdicts[0].reason).toMatch(/verifier failed/)
  })

  it('fails open when the agent session itself errors', async () => {
    const agent: AgentQuery = async function* () {
      yield { type: 'result' as const, ok: false, text: 'boom' }
    }
    const verdicts = await verifyFindingsBatch([mkFinding(0)], { meta, cwd: '/tmp', model: 'cheap' }, () => {}, agent)
    expect(verdicts[0].verdict).toBe('confirmed')
    expect(verdicts[0].reason).toMatch(/verifier failed: boom/)
  })

  it('chunks more than 20 findings into sequential sessions with global indexes', async () => {
    const prompts: string[] = []
    const agent: AgentQuery = async function* (prompt) {
      prompts.push(prompt)
      const items = JSON.parse(/```json\n([\s\S]*?)```/.exec(prompt)![1]) as { index: number }[]
      yield ok('```json\n' + JSON.stringify(items.map((it) => ({ index: it.index, verdict: 'confirmed' }))) + '\n```')
    }
    const findings = Array.from({ length: 25 }, (_, i) => mkFinding(i))
    const verdicts = await verifyFindingsBatch(findings, { meta, cwd: '/tmp', model: 'cheap' }, () => {}, agent)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('"index": 20')
    expect(verdicts).toHaveLength(25)
    expect(verdicts.every((v) => v.verdict === 'confirmed')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/verify.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement** — replace `server/src/review/verify.ts` with (keeping `runVerifyTurn` verbatim from the current file):

```ts
import { z } from 'zod'
import { sdkQuery, type AgentQuery } from './runner.js'
import type { Finding, PrMeta, RunEvent } from '../types.js'

const CHUNK = 20

const BatchItemSchema = z.object({
  index: z.number().int().nonnegative(),
  verdict: z.enum(['confirmed', 'unverified']),
  reason: z.string().optional(),
})

export type Verdict = { verdict: 'confirmed' | 'unverified'; reason?: string }

export function buildBatchVerifyPrompt(findings: Finding[], meta: PrMeta, offset: number): string {
  const items = findings.map((f, i) => ({
    index: offset + i,
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category,
    summary: f.summary,
    detail: f.detail,
    suggestion: f.suggestion,
  }))
  return `You are adversarially verifying claimed code-review findings on a pull request.
The repository is checked out at your working directory at the PR's head commit.

READ FIRST (with the Read tool):
- .pr-review/pr.md — PR context and the changed-file list
- .pr-review/diff.patch — the diff; read the sections around each finding

# Pull request
Title: ${meta.title}

# Claimed findings
\`\`\`json
${JSON.stringify(items, null, 2)}
\`\`\`

# Your job
For EACH finding, re-read the real code at its file:line and try to REFUTE it. Decide:
- "confirmed" ONLY if the issue is real AND applies to code changed in this diff.
- "unverified" if it's wrong, already handled, not in the changed code, or you cannot confirm it.
When uncertain, answer "unverified".

# Output contract (strict)
End your reply with ONE fenced \`\`\`json block containing a JSON array with one entry per finding:
[{ "index": <number from the list above>, "verdict": "confirmed" | "unverified", "reason": "one short sentence" }]
Do not put any text after the json block.`
}

export function extractBatchVerdicts(text: string): Map<number, Verdict> | undefined {
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  const raw = fenced.length > 0 ? fenced[fenced.length - 1][1] : text.trim()
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(arr)) return undefined
  const map = new Map<number, Verdict>()
  for (const item of arr) {
    const parsed = BatchItemSchema.safeParse(item)
    if (!parsed.success) continue
    if (!map.has(parsed.data.index)) {
      map.set(parsed.data.index, { verdict: parsed.data.verdict, reason: parsed.data.reason })
    }
  }
  return map
}

const VERDICT_REFORMAT_PROMPT =
  'Your previous reply did not end with a valid ```json verdicts array. ' +
  'Reply now with ONLY the ```json array [{"index":<n>,"verdict":"confirmed"|"unverified","reason":"..."}], nothing else. ' +
  'Previous reply:\n\n'

/** Runs one agent turn and returns its final result text (the resolved text from the
 * `result` message), mirroring runner.ts's runOnce. Throws if the agent errors or never
 * produces a result. */
async function runVerifyTurn(
  prompt: string,
  opts: { cwd: string; model: string },
  emit: (e: RunEvent) => void,
  agentQuery: AgentQuery,
): Promise<string> {
  let resultText: string | undefined
  for await (const msg of agentQuery(prompt, opts)) {
    const at = new Date().toISOString()
    if (msg.type === 'assistant') {
      if (msg.text) emit({ kind: 'text', text: msg.text, at })
      if (msg.tool) emit({ kind: 'tool', text: msg.tool, at })
    } else {
      if (!msg.ok) throw new Error(msg.text)
      resultText = msg.text
    }
  }
  if (resultText === undefined) throw new Error('Agent run produced no result message.')
  return resultText
}

/** Verifies all findings in batched sessions (CHUNK per session) on the cheap verify model.
 * Returns verdicts aligned index-for-index with the input. Fail-open everywhere: a finding
 * is never dropped or downgraded because the VERIFIER broke. */
export async function verifyFindingsBatch(
  findings: Finding[],
  ctx: { meta: PrMeta; cwd: string; model: string },
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery = sdkQuery,
): Promise<Verdict[]> {
  const out: Verdict[] = new Array(findings.length)
  const emit = (e: RunEvent) => onEvent({ ...e, skill: 'verify' })
  const opts = { cwd: ctx.cwd, model: ctx.model }
  for (let start = 0; start < findings.length; start += CHUNK) {
    const chunk = findings.slice(start, start + CHUNK)
    try {
      const text = await runVerifyTurn(buildBatchVerifyPrompt(chunk, ctx.meta, start), opts, emit, agentQuery)
      let verdicts = extractBatchVerdicts(text)
      if (!verdicts) {
        const retryText = await runVerifyTurn(VERDICT_REFORMAT_PROMPT + text, opts, emit, agentQuery)
        verdicts = extractBatchVerdicts(retryText)
        if (!verdicts) throw new Error('unparseable verdicts')
      }
      for (let i = 0; i < chunk.length; i++) {
        out[start + i] = verdicts.get(start + i) ?? { verdict: 'confirmed', reason: 'verifier gave no verdict' }
      }
    } catch (err: any) {
      emit({ kind: 'error', text: `verifier failed: ${err.message}`, at: new Date().toISOString() })
      for (let i = 0; i < chunk.length; i++) {
        out[start + i] = { verdict: 'confirmed', reason: `verifier failed: ${err.message}` }
      }
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/review/verify.ts server/test/verify.test.ts
git commit -m "feat: batched adversarial verification on the cheap model"
```

---

### Task 8: Compact comment formatter

**Files:**
- Create: `server/src/review/comment.ts`
- Test: `server/test/comment.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Severity` from `../types.js`.
- Produces: `formatComment(f: Finding): string` — compact body WITHOUT the fingerprint marker (the route appends the marker, unchanged). Task 9 wires it into `app.ts`; Task 10 mirrors it in `web/src/pages/RunView.tsx`.

- [ ] **Step 1: Write the failing test** — create `server/test/comment.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatComment } from '../src/review/comment.js'
import type { Finding } from '../src/types.js'

const base: Finding = {
  file: 'a.ts',
  line: 3,
  severity: 'high',
  category: 'bug',
  summary: 'socket leaks on unmount',
  detail: 'Each remount opens a new connection.',
  suggestion: 'Return a cleanup from the effect.',
  example: '```tsx\n// before\nuseEffect(() => { s.connect() }, [])\n// after\nuseEffect(() => { s.connect(); return () => s.disconnect() }, [])\n```',
  skills: ['react-hooks'],
  verdict: 'confirmed',
}

describe('formatComment', () => {
  it('renders header, why, example, and fix in the compact template', () => {
    const c = formatComment(base)
    expect(c).toBe(
      '**🔴 High · bug** — socket leaks on unmount\n\n' +
        '**Why:** Each remount opens a new connection.\n\n' +
        base.example +
        '\n\n**Fix:** Return a cleanup from the effect.',
    )
  })

  it('uses the right emoji per severity', () => {
    expect(formatComment({ ...base, severity: 'medium' })).toContain('**🟠 Medium · bug**')
    expect(formatComment({ ...base, severity: 'low' })).toContain('**🟡 Low · bug**')
    expect(formatComment({ ...base, severity: 'info' })).toContain('**ℹ️ Info · bug**')
  })

  it('omits the example block when example is empty or absent (legacy findings)', () => {
    const noExample = formatComment({ ...base, example: '' })
    expect(noExample).not.toContain('```tsx')
    const legacy = formatComment({ ...base, example: undefined })
    expect(legacy).toContain('**Fix:**')
  })

  it('omits the fix line when suggestion is empty', () => {
    expect(formatComment({ ...base, suggestion: '' })).not.toContain('**Fix:**')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/comment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `server/src/review/comment.ts`:

```ts
import type { Finding, Severity } from '../types.js'

const EMOJI: Record<Severity, string> = { high: '🔴', medium: '🟠', low: '🟡', info: 'ℹ️' }
const LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }

/** Compact PR comment body: header, why, optional before/after example, optional fix.
 * The invisible fingerprint marker is NOT included — the posting route appends it. Keep
 * this in sync with formatCommentBody in web/src/pages/RunView.tsx (the preview mirror). */
export function formatComment(f: Finding): string {
  const parts = [
    `**${EMOJI[f.severity]} ${LABEL[f.severity]} · ${f.category}** — ${f.summary}`,
    `**Why:** ${f.detail}`,
  ]
  if (f.example) parts.push(f.example)
  if (f.suggestion) parts.push(`**Fix:** ${f.suggestion}`)
  return parts.join('\n\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/comment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/review/comment.ts server/test/comment.test.ts
git commit -m "feat: compact example-driven comment formatter"
```

---

### Task 9: Orchestration — depth param, context pack, grouped fan-out, batch verify, formatted comments

**Files:**
- Modify: `server/src/app.ts` (imports at 10–17; run body type at ~194; `store().create` at ~219; `executeRun` at 231–351; comment `text` at ~396)
- Modify: `server/src/types.ts` (`RunRecord`)
- Test: `server/test/runPipeline.test.ts` (updates + new cases)

**Interfaces:**
- Consumes: `writeContextPack` (Task 2), `groupSkills` (Task 3), new `runReview` (Task 6), `verifyFindingsBatch` (Task 7), `formatComment` (Task 8), `Config.verifyModel`/`Config.defaultDepth` (Task 1).
- Produces:
  - `POST /api/runs` accepts `depth?: Depth`; invalid values → 400; absent → `config.defaultDepth`. The chosen depth is stored as `RunRecord.depth`.
  - `RunRecord.depth?: Depth` in `server/src/types.ts` (optional so legacy stored runs parse; always set on new runs).
  - Grouped review sessions with group-label events and per-skill `SkillRunResult`s — the contract Tasks 10–11 rely on is unchanged shapes, plus `depth` on the run.

- [ ] **Step 1: Update the pipeline tests.** In `server/test/runPipeline.test.ts`:

**(a)** Add a shared batch-verify responder near `fakeAgent` and use it in BOTH fakes' `/adversarially verifying/` branches:

```ts
/** Answers a batch-verify prompt by parsing the findings fence it embeds and confirming
 * every index (verdictFor overrides per summary). Reasons are omitted for confirmed so
 * exact-equality assertions on findings stay clean. */
function batchVerdicts(prompt: string, verdictFor: (summary: string) => 'confirmed' | 'unverified' = () => 'confirmed'): string {
  const items = JSON.parse(/```json\n([\s\S]*?)```/.exec(prompt)![1]) as { index: number; summary: string }[]
  const verdicts = items.map((it) => {
    const verdict = verdictFor(it.summary)
    return verdict === 'confirmed' ? { index: it.index, verdict } : { index: it.index, verdict, reason: 'nope' }
  })
  return '```json\n' + JSON.stringify(verdicts) + '\n```'
}
```

In `fakeAgent` and `fakeAgentPerSkill`, replace the verify branch's yielded text with `batchVerdicts(prompt)`.

**(b)** Every test that selects 2+ skills and depends on per-skill sessions must pin them: add `depth: 'thorough'` to its POST payload. The default is now `balanced`, which would put both skills into ONE session and break these tests. This applies to all tests using `fakeAgentPerSkill` (it dispatches on the FIRST `## Skill:` match) AND to the "dedupes same-location findings across skills" test (its cross-skill merge assertion needs each skill to report the finding from its own session) AND to the "sorts unverified findings" test (its custom agent dispatches per skill).

**(c)** The "verifies once each" test's `verifyCalls` counter still counts 1 (one batch session). The "sorts unverified after confirmed" test's verify branch becomes `batchVerdicts(prompt, (s) => (s === 'drop' ? 'unverified' : 'confirmed'))`; its review branches are unchanged; add `depth: 'thorough'` to its payload. Its assertion `run.findings[1].verdict === 'unverified'` keeps working; the confirmed finding must have NO `verifierReason` key.

**(d)** Findings fixtures gain `example: ''` in expected outputs: `extractFindings` now defaults `example` to `''`, so exact-equality assertions become e.g. `{ ...findingRest, example: '', skills: ['general'], verdict: 'confirmed' }`. Where the fixture already passes through `example`, keep as-is.

**(e)** Add three new tests:

```ts
it('rejects an invalid depth with 400', async () => {
  const path = tempConfig()
  const app = buildApp({
    configPath: path,
    clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
    agentQuery: fakeAgent([]),
  })
  const res = await app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], depth: 'bogus' },
  })
  expect(res.statusCode).toBe(400)
})

it('balanced depth reviews grouped skills in ONE session, attributes per skill, and never embeds the diff', async () => {
  const path = tempConfigWithSkills(['skill-a', 'skill-b'])
  const diff = '+line1\n+line2\n'
  const mk = (skill: string, line: number) => ({
    file: 'a.txt', line, severity: 'low', category: 'style', summary: `from ${skill}`,
    detail: 'd', suggestion: 'x', skill,
  })
  const reviewPrompts: string[] = []
  const agent: AgentQuery = async function* (prompt: string) {
    if (/adversarially verifying/.test(prompt)) {
      yield { type: 'result' as const, ok: true, text: batchVerdicts(prompt) }
      return
    }
    reviewPrompts.push(prompt)
    yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([mk('skill-a', 1), mk('skill-b', 2)]) + '\n```' }
  }
  const app = buildApp({
    configPath: path,
    clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
    agentQuery: agent,
  })
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'], depth: 'balanced' },
  })
  const { id } = createRes.json()
  const run = await pollRun(app, id)
  expect(run.status).toBe('completed')
  expect(run.depth).toBe('balanced')
  expect(reviewPrompts).toHaveLength(1) // one grouped session, not two
  expect(reviewPrompts[0]).toContain('## Skill: skill-a')
  expect(reviewPrompts[0]).toContain('## Skill: skill-b')
  expect(reviewPrompts[0]).toContain('.pr-review/diff.patch')
  expect(reviewPrompts[0]).not.toContain('+line1') // the diff body stays out of the prompt
  const bySkill = Object.fromEntries(run.skillResults.map((r: any) => [r.skill, r]))
  expect(bySkill['skill-a']).toEqual({ skill: 'skill-a', status: 'completed', findingCount: 1 })
  expect(bySkill['skill-b']).toEqual({ skill: 'skill-b', status: 'completed', findingCount: 1 })
  expect(run.transcript.some((e: any) => e.skill === 'skill-a, skill-b')).toBe(true)
})

it('a failed grouped session marks every skill in the group failed', async () => {
  const path = tempConfigWithSkills(['skill-a', 'skill-b'])
  const agent: AgentQuery = async function* (prompt: string) {
    if (/adversarially verifying/.test(prompt)) {
      yield { type: 'result' as const, ok: true, text: batchVerdicts(prompt) }
      return
    }
    yield { type: 'result' as const, ok: false, text: 'boom' }
  }
  const app = buildApp({
    configPath: path,
    clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
    agentQuery: agent,
  })
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: ['skill-a', 'skill-b'], depth: 'balanced' },
  })
  const { id } = createRes.json()
  const run = await pollRun(app, id)
  expect(run.status).toBe('failed')
  expect(run.error).toMatch(/all 2 skill reviews failed/i)
  expect(run.skillResults).toHaveLength(2)
  expect(run.skillResults.every((r: any) => r.status === 'failed')).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/runPipeline.test.ts`
Expected: FAIL — `depth` unknown, old runReview call signature, per-finding verify fakes mismatch.

- [ ] **Step 3: Implement** — in `server/src/types.ts`, add to `RunRecord` after `verify`:

```ts
  /** Review depth used for this run. Absent on runs stored before depth modes existed. */
  depth?: Depth
```

In `server/src/app.ts`:

**(a) Imports** — replace the `verifyFinding` import with the new modules:

```ts
import { formatComment } from './review/comment.js'
import { writeContextPack } from './review/contextPack.js'
import { groupSkills } from './review/grouping.js'
import { verifyFindingsBatch } from './review/verify.js'
```

and add `Depth` to the type import from `./types.js`.

**(b) `POST /api/runs`** — extend the body type and resolve/validate depth before `store().create`:

```ts
    const body = req.body as {
      url: string
      skills: string[]
      focus?: string
      force?: boolean
      verify?: boolean
      depth?: Depth
    }
```

after the oversized-diff gate:

```ts
    const DEPTHS: readonly Depth[] = ['thorough', 'balanced', 'economy']
    if (body.depth !== undefined && !DEPTHS.includes(body.depth)) {
      return reply.code(400).send({ error: `Invalid depth: ${String(body.depth)}` })
    }
    const depth: Depth = body.depth ?? c.defaultDepth
```

add `depth,` to the `store().create({...})` object, and pass it through: `runQueue.push(() => executeRun(run.id, { pr, meta, diff, depth, body }))` (extend `executeRun`'s `ctx` type with `depth: Depth`).

**(c) `executeRun`** — after the `ensureCheckout` call and before "Starting review agent…":

```ts
      emit({ kind: 'status', text: 'Writing review context…', at: new Date().toISOString() })
      writeContextPack(cwd, ctx.meta, ctx.diff) // throws → outer catch fails the run (never review without a pack)
```

Replace the whole `units`/`outcomes` block (current lines 262–307) with:

```ts
      const groups: { name: string; content: string }[][] =
        selected.length > 0 ? groupSkills(selected, ctx.depth) : [[{ name: 'general', content: '' }]]

      const outcomes = await Promise.all(
        groups.map(async (group): Promise<{ results: SkillRunResult[]; findings: Finding[] }> => {
          const label = group.map((g) => g.name).join(', ')
          const wrappedEmit = (e: RunEvent) => emit({ ...e, skill: label })
          try {
            wrappedEmit({ kind: 'status', text: `Reviewing with: ${label}…`, at: new Date().toISOString() })
            const findings = await runReview(
              {
                meta: ctx.meta,
                skills: group[0].name === 'general' ? [] : group,
                focus: ctx.body.focus,
                cwd,
                model: c.model,
                reformatModel: c.verifyModel,
              },
              wrappedEmit,
              agentQuery,
            )
            return {
              results: group.map((g) => ({
                skill: g.name,
                status: 'completed' as const,
                findingCount: findings.filter((f) => f.skills.includes(g.name)).length,
              })),
              findings,
            }
          } catch (err: any) {
            wrappedEmit({ kind: 'error', text: err.message, at: new Date().toISOString() })
            return {
              results: group.map((g) => ({
                skill: g.name,
                status: 'failed' as const,
                findingCount: 0,
                error: err.message,
              })),
              findings: [],
            }
          }
        }),
      )

      const merged = outcomes.flatMap((o) => o.findings)
      run.skillResults = outcomes.flatMap((o) => o.results)
      const allFailed = run.skillResults.every((r) => r.status === 'failed')
```

(The `general` group's findings come back attributed to `'general'` via `runReview`'s internal `validSkills`, so `findingCount` filtering works unchanged. The old force-attribution loop is deleted.)

Replace the verify block (current lines 310–322) with:

```ts
      const doVerify = ctx.body.verify !== false
      run.verify = doVerify
      if (doVerify && findings.length > 0 && !allFailed) {
        emit({ kind: 'status', text: `Verifying ${findings.length} findings…`, at: new Date().toISOString() })
        const verdicts = await verifyFindingsBatch(
          findings,
          { meta: ctx.meta, cwd, model: c.verifyModel },
          emit,
          agentQuery,
        )
        findings.forEach((f, i) => {
          f.verdict = verdicts[i].verdict
          if (verdicts[i].reason) f.verifierReason = verdicts[i].reason
        })
      }
```

Keep the `allFailed` error message computing the total skill count: `run.error = \`All ${run.skillResults.length} skill reviews failed\``.

**(d) Comments route** — replace the `text` template literal (~line 396) with:

```ts
      const text = `${formatComment(f)}\n\n${commentMarker(fp)}`
```

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npx vitest run`
Expected: PASS — pipeline, app, runner, verify, findings, prompt, config, and all untouched suites.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/types.ts server/test/runPipeline.test.ts
git commit -m "feat: grouped review sessions, context pack, batched cheap-model verify, compact comments"
```

---

### Task 10: Web — types, API, comment mirror, example rendering, depth badge

**Files:**
- Modify: `web/src/types.ts` (`Finding`, `RunRecord`, `Config`)
- Modify: `web/src/api.ts` (`createRun` input)
- Modify: `web/src/pages/RunView.tsx` (`formatCommentBody` at lines 36–38; `retry`/`retryFailedSkills`; header badges)
- Modify: `web/src/components/FindingCard.tsx`
- Test: `web/test/report.test.ts`

**Interfaces:**
- Consumes: server behavior from Task 9 (`RunRecord.depth`, `Finding.example`, compact comment format from Task 8).
- Produces:
  - `web/src/types.ts`: `Finding.example?: string`; `RunRecord.depth?: 'thorough' | 'balanced' | 'economy'`; `Config.verifyModel: string`; `Config.defaultDepth: 'thorough' | 'balanced' | 'economy'`.
  - `createRun` input gains `depth?: 'thorough' | 'balanced' | 'economy'` (Task 11 uses it).
  - `formatCommentBody(f: Finding): string` — byte-identical to the server's `formatComment` output.

- [ ] **Step 1: Update the failing test** — in `web/test/report.test.ts`, replace the `formatCommentBody` cases with mirrors of Task 8's expectations (adapt to the file's existing fixture style):

```ts
const base: Finding = {
  file: 'a.ts', line: 3, severity: 'high', category: 'bug',
  summary: 'socket leaks on unmount',
  detail: 'Each remount opens a new connection.',
  suggestion: 'Return a cleanup from the effect.',
  example: '```tsx\n// before\n// after\n```',
  skills: ['react-hooks'], verdict: 'confirmed',
}

describe('formatCommentBody (compact template, mirrors server formatComment)', () => {
  it('renders header, why, example, and fix', () => {
    expect(formatCommentBody(base)).toBe(
      '**🔴 High · bug** — socket leaks on unmount\n\n' +
        '**Why:** Each remount opens a new connection.\n\n' +
        base.example +
        '\n\n**Fix:** Return a cleanup from the effect.',
    )
  })
  it('omits example when empty/absent and fix when suggestion empty', () => {
    expect(formatCommentBody({ ...base, example: undefined })).not.toContain('```tsx')
    expect(formatCommentBody({ ...base, suggestion: '' })).not.toContain('**Fix:**')
  })
  it('maps each severity to its emoji', () => {
    expect(formatCommentBody({ ...base, severity: 'medium' })).toContain('🟠 Medium')
    expect(formatCommentBody({ ...base, severity: 'low' })).toContain('🟡 Low')
    expect(formatCommentBody({ ...base, severity: 'info' })).toContain('ℹ️ Info')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run test/report.test.ts`
Expected: FAIL — old bracket-style format.

- [ ] **Step 3: Implement**

`web/src/types.ts` — add to `Finding` after `suggestion`:

```ts
  example?: string
```

add to `RunRecord` after `verify`:

```ts
  depth?: 'thorough' | 'balanced' | 'economy'
```

add to `Config` after `model`:

```ts
  verifyModel: string
  defaultDepth: 'thorough' | 'balanced' | 'economy'
```

`web/src/api.ts` — add to `createRun`'s input type:

```ts
  depth?: 'thorough' | 'balanced' | 'economy'
```

`web/src/pages/RunView.tsx` — replace `formatCommentBody` (lines 36–38) with:

```ts
const SEVERITY_EMOJI: Record<Severity, string> = { high: '🔴', medium: '🟠', low: '🟡', info: 'ℹ️' }
const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }

/** Mirrors the exact comment body the server posts (formatComment in
 * server/src/review/comment.ts), so the confirm dialog shows the user precisely what will
 * land on the pull request. Keep the two in sync. */
export function formatCommentBody(f: Finding): string {
  const parts = [
    `**${SEVERITY_EMOJI[f.severity]} ${SEVERITY_LABEL[f.severity]} · ${f.category}** — ${f.summary}`,
    `**Why:** ${f.detail}`,
  ]
  if (f.example) parts.push(f.example)
  if (f.suggestion) parts.push(`**Fix:** ${f.suggestion}`)
  return parts.join('\n\n')
}
```

In both `retry()` and `retryFailedSkills()`, add `depth: run.depth,` to the `createRun({...})` call (undefined for legacy runs → server falls back to `defaultDepth`).

In the header (next to `<StatusBadge status={run.status} />`), add:

```tsx
          {run.depth && (
            <Badge variant="muted" size="xs" className="capitalize">
              {run.depth}
            </Badge>
          )}
```

`web/src/components/FindingCard.tsx` — above the existing `finding.suggestion` block, add:

```tsx
          {finding.example && (
            <pre className="bg-code-surface text-code-foreground overflow-x-auto rounded-md p-3 text-xs">
              {finding.example}
            </pre>
          )}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/src/pages/RunView.tsx web/src/components/FindingCard.tsx web/test/report.test.ts
git commit -m "feat: web mirrors compact comments, renders examples, shows run depth"
```

---

### Task 11: New Review — depth selector

**Files:**
- Modify: `web/src/pages/NewReview.tsx`

**Interfaces:**
- Consumes: `createRun`'s `depth` param (Task 10), `getConfig` (existing).
- Produces: the New Review screen posts `depth` with every run; choice persists in localStorage under `pr-reviewer.depth`; first-ever visit preselects `config.defaultDepth`.

- [ ] **Step 1: Implement** (presentational wiring; the depth→server behavior is covered by Task 9's pipeline tests, and web tests here are pure-function only — there is no component-render test rig in this repo, so this task is implementation + typecheck + manual smoke):

Add near the other storage keys (line 28):

```ts
const DEPTH_KEY = 'pr-reviewer.depth'
type Depth = 'thorough' | 'balanced' | 'economy'
const DEPTH_OPTIONS: { value: Depth; label: string; hint: string }[] = [
  { value: 'thorough', label: 'Thorough', hint: 'One agent per skill — highest quality, highest cost.' },
  { value: 'balanced', label: 'Balanced', hint: 'Groups of 3 skills per agent — solid quality at roughly a third of the cost.' },
  { value: 'economy', label: 'Economy', hint: 'All skills in a single agent — cheapest, lighter per-skill attention.' },
]
```

Add `getConfig` to the existing `../api.js` import. Add state + config-default preselect inside `NewReview()`:

```ts
  const [depth, setDepth] = useState<Depth | null>(
    () => (localStorage.getItem(DEPTH_KEY) as Depth | null),
  )

  useEffect(() => {
    if (depth !== null) return
    getConfig()
      .then((c) => setDepth((cur) => cur ?? c.defaultDepth))
      .catch(() => setDepth((cur) => cur ?? 'balanced'))
  }, [depth])

  function pickDepth(d: Depth) {
    setDepth(d)
    localStorage.setItem(DEPTH_KEY, d)
  }
```

In `submit`, pass it: `createRun({ url, skills: [...selected], focus: focus || undefined, verify, force, depth: depth ?? undefined })`.

Render below the "Verify findings" checkbox, reusing the category-pill button style already in this file:

```tsx
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Review depth</h2>
        <div className="flex flex-wrap gap-2">
          {DEPTH_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => pickDepth(o.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                depth === o.value
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted-200 text-muted-foreground hover:border-primary hover:text-primary',
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
```

- [ ] **Step 2: Typecheck + full web suite**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Manual smoke** — `npm start` at the repo root, open http://127.0.0.1:5175, and confirm: the three depth pills render with Balanced preselected on a fresh browser profile, the hint line changes per pill, and the choice survives a reload.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/NewReview.tsx
git commit -m "feat: review depth selector on the New Review screen"
```

---

### Task 12: Documentation

**Files:**
- Modify: `README.md` (the "Review Quality" section, lines 32–48)

- [ ] **Step 1: Update README** — in the "Review Quality" section: replace the sentence about one verification subagent per deduped finding with the batched model ("all findings are verified together in a single session per run — chunked at 20 — on a cheaper model, configurable via `verifyModel` in Settings/config, default `claude-haiku-4-5-20251001`"). Add a short "Review depth & cost" subsection documenting Thorough/Balanced/Economy (1 / 3 / all skills per agent session), the `defaultDepth` config default of `balanced`, and that the diff is no longer embedded in prompts — agents read `.pr-review/diff.patch` from the checkout. Add one sentence to the comment-posting subsection: posted comments now use a compact template (severity emoji header, a two-sentence "Why", a before/after code example when available, and a "Fix" line); the fingerprint marker and idempotency behavior are unchanged.

- [ ] **Step 2: Full suite green-gate**

Run: `npm test` at the repo root.
Expected: PASS (server + web).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document depth modes, batched cheap-model verify, compact comments"
```
