# Review Quality (Dedup + Adversarial Verification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the per-skill subagent fan-out, deduplicate findings deterministically, then verify each with its own adversarial subagent; unverified findings stay visible but downgraded — never hidden.

**Architecture:** A new `dedup → verify → assemble` stage inserted into `executeRun` between the existing fan-out (which produces merged findings) and the save. `dedupeFindings` is a pure function; `verifyFinding` runs one read-only Agent SDK subagent per deduped finding, in parallel unbounded, fail-open. The `Finding` shape changes (`skill: string` → `skills: string[]`, plus `verdict`/`verifierReason`), with a RunStore read-time normalization so old runs still load.

**Tech Stack:** Node 20+, TypeScript strict, Fastify, zod, `@anthropic-ai/claude-agent-sdk`, Vitest (server); Vite + React (web).

**Spec:** `docs/superpowers/specs/2026-07-26-review-quality-design.md`

## Global Constraints

- Node 20+, TypeScript `"strict": true`.
- Server tests: `cd server && npx vitest run` + `npx tsc --noEmit`. Web: `cd web && npx vitest run && npm run build`. All green before each commit.
- Agent subagents get read-only tools only (`Read`, `Grep`, `Glob`) — reuse `buildQueryOptions` / `sdkQuery` from `server/src/review/runner.ts`; never construct a new agent option set.
- Verification is **fail-open**: a verifier error leaves the finding `verdict: 'confirmed'` with a `verifierReason` noting the failure, plus a visible `error` event.
- Dedup is deterministic (key `file:line:category`); no LLM dedup.
- Conventional commits. Commit after each green cycle.
- Do NOT modify `runReview` behavior or the per-skill fan-out's skill loop — only the post-fan-out stage and the `Finding` shape.

---

### Task 1: Finding shape migration (`skills[]`, `verdict`, `verifierReason`) + RunStore normalization

Changing the shared type first so every later task compiles against it. `FindingSchema` (agent output contract) keeps `skill: string` — subagents still report one skill name; the fan-out converts. The pipeline adds `skills`/`verdict`.

**Files:**
- Modify: `server/src/types.ts` (Finding + RunRecord)
- Modify: `server/src/review/findings.ts:11-28` (keep `FindingSchema.skill`; `extractFindings` maps to the new shape)
- Modify: `server/src/store/runs.ts` (read-time normalization of legacy runs)
- Modify: `server/src/app.ts` (fan-out force-attribution `f.skill` → `f.skills`; comment text `f.skill` → `f.skills.join(', ')`)
- Test: `server/test/findings.test.ts`, `server/test/runStore.test.ts` (both exist)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `Finding` = `{ file, line, severity, category, summary, detail, suggestion, skills: string[], verdict: 'confirmed' | 'unverified', verifierReason?: string }`
  - `RunRecord` gains `verify: boolean`.
  - `extractFindings(text: string): Finding[]` — now returns findings with `skills: [<schema skill>]`, `verdict: 'confirmed'`.
  - `normalizeRun(raw: any): RunRecord` exported from `runs.ts` (used by `readRun`).

- [ ] **Step 1: Write failing tests**

Add to `server/test/findings.test.ts` (the fixture object there uses `skill: 'review-code'` — update the valid fixture to the new shape and assert the mapping):

```ts
it('maps the schema skill string into skills[] and defaults verdict', () => {
  const raw = {
    file: 'a.ts', line: 3, severity: 'high', category: 'bug',
    summary: 's', detail: 'd', suggestion: 'fix', skill: 'review-code',
  }
  const out = extractFindings('```json\n' + JSON.stringify([raw]) + '\n```')
  expect(out).toHaveLength(1)
  expect(out[0].skills).toEqual(['review-code'])
  expect(out[0].verdict).toBe('confirmed')
  expect(out[0].verifierReason).toBeUndefined()
})
```

Add to `server/test/runStore.test.ts`:

```ts
it('normalizes a legacy run with skill:string and no verdict on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prr-runs-'))
  const store = new RunStore(dir)
  const legacy = {
    id: 'legacy1', pr: { provider: 'bitbucket', workspace: 'w', repo: 'r', id: 1 },
    prTitle: 'T', skills: ['review-code'], status: 'completed',
    createdAt: new Date().toISOString(), transcript: [], postedCommentIds: [],
    skillResults: [], findings: [
      { file: 'a.ts', line: 1, severity: 'low', category: 'style',
        summary: 's', detail: 'd', suggestion: 'x', skill: 'review-code' },
    ],
  }
  writeFileSync(join(dir, 'legacy1.json'), JSON.stringify(legacy))
  const loaded = store.get('legacy1')!
  expect(loaded.findings[0].skills).toEqual(['review-code'])
  expect(loaded.findings[0].verdict).toBe('confirmed')
  expect(loaded.verify).toBe(true)
})
```

(`runStore.test.ts` already imports `mkdtempSync`/`writeFileSync`/`tmpdir`/`join`; if `writeFileSync` isn't imported, add it to the `node:fs` import.)

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd server && npx vitest run test/findings.test.ts test/runStore.test.ts`
Expected: FAIL — `skills`/`verdict` undefined; `normalizeRun`/`verify` not present.

- [ ] **Step 3: Update types**

`server/src/types.ts` — replace the `Finding` interface and add `verify` to `RunRecord`:

```ts
export interface Finding {
  file: string
  line: number
  severity: Severity
  category: string
  summary: string
  detail: string
  suggestion: string
  skills: string[]
  verdict: 'confirmed' | 'unverified'
  verifierReason?: string
}
```

In `RunRecord`, add after `focus?: string`:

```ts
  verify: boolean
```

- [ ] **Step 4: Update findings extractor**

`server/src/review/findings.ts` — `FindingSchema` KEEPS `skill: z.string()` (unchanged). Change `extractFindings` so each validated item is mapped to the new shape. Current body ends with `return arr.flatMap(...)` returning schema objects directly; wrap the mapping:

```ts
export function extractFindings(text: string): Finding[] {
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
    return [{ ...rest, skills: [skill], verdict: 'confirmed' as const }]
  })
}
```

(Keep `candidateJson`, `FindingSchema`, `FindingsParseError`, `countDiffLines` exactly as they are. `FindingSchema` remains the `skill: string` contract.)

- [ ] **Step 5: Add RunStore normalization**

`server/src/store/runs.ts` — add an exported `normalizeRun` and call it in `readRun`:

```ts
export function normalizeRun(raw: any): RunRecord {
  const run = raw as RunRecord
  if (run.verify === undefined) run.verify = true
  if (Array.isArray(run.findings)) {
    for (const f of run.findings as any[]) {
      if (f.skills === undefined) f.skills = f.skill !== undefined ? [f.skill] : []
      delete f.skill
      if (f.verdict === undefined) f.verdict = 'confirmed'
    }
  }
  return run
}
```

Then in `readRun`, change the parse line:

```ts
    return normalizeRun(JSON.parse(readFileSync(path, 'utf8')))
```

- [ ] **Step 6: Update app.ts attribution + comment text**

`server/src/app.ts` — in the fan-out loop change the force-attribution (currently `for (const f of findings) f.skill = unit.name`):

```ts
      for (const f of findings) f.skills = [unit.name]
```

And the comment text in the comments route (currently uses `f.category`, no skill — leave category, but if any code reads `f.skill` it must move to `f.skills`). Search the file: the comment text line is `**[AI review — ${f.severity}/${f.category}]** ...` and does not use skill, so no change there. Confirm `grep -n "\.skill\b" server/src/app.ts` returns nothing after this step.

- [ ] **Step 7: Run tests + typecheck**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: PASS (existing tests that referenced `finding.skill` in fixtures — e.g. `runPipeline.test.ts` — may need their fixtures updated to `skills: [...]`; update any that break, keeping their intent). `tsc` clean.

- [ ] **Step 8: Commit**

```bash
git add server && git commit -m "refactor: Finding.skills[] + verdict, with legacy run normalization"
```

---

### Task 2: Deterministic dedup

**Files:**
- Create: `server/src/review/dedup.ts`
- Test: `server/test/dedup.test.ts`

**Interfaces:**
- Consumes: `Finding` (Task 1).
- Produces: `dedupeFindings(findings: Finding[]): Finding[]`.

- [ ] **Step 1: Write failing test**

`server/test/dedup.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { dedupeFindings } from '../src/review/dedup.js'
import type { Finding } from '../src/types.js'

const f = (o: Partial<Finding>): Finding => ({
  file: 'a.ts', line: 10, severity: 'low', category: 'bug',
  summary: 's', detail: 'd', suggestion: 'x', skills: ['s1'],
  verdict: 'confirmed', ...o,
})

describe('dedupeFindings', () => {
  it('merges same file+line+category: max severity, union skills, longest detail/suggestion', () => {
    const out = dedupeFindings([
      f({ skills: ['review-code'], severity: 'low', detail: 'short', suggestion: 'a' }),
      f({ skills: ['audit-a11y'], severity: 'high', detail: 'a much longer detail', suggestion: 'bb' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].severity).toBe('high')
    expect(out[0].skills).toEqual(['review-code', 'audit-a11y'])
    expect(out[0].detail).toBe('a much longer detail')
    expect(out[0].suggestion).toBe('bb')
  })

  it('does NOT merge different category on the same line', () => {
    const out = dedupeFindings([f({ category: 'bug' }), f({ category: 'style' })])
    expect(out).toHaveLength(2)
  })

  it('does NOT merge different lines', () => {
    const out = dedupeFindings([f({ line: 10 }), f({ line: 11 })])
    expect(out).toHaveLength(2)
  })

  it('preserves first-seen group order and dedupes repeated skills', () => {
    const out = dedupeFindings([
      f({ file: 'z.ts', skills: ['s1'] }),
      f({ file: 'a.ts', skills: ['s2'] }),
      f({ file: 'z.ts', skills: ['s1'] }),
    ])
    expect(out.map((x) => x.file)).toEqual(['z.ts', 'a.ts'])
    expect(out[0].skills).toEqual(['s1'])
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd server && npx vitest run test/dedup.test.ts`
Expected: FAIL — cannot find `../src/review/dedup.js`.

- [ ] **Step 3: Implement**

`server/src/review/dedup.ts`:

```ts
import type { Finding, Severity } from '../types.js'

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 }
const longer = (a: string, b: string): string => (b.length > a.length ? b : a)

export function dedupeFindings(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding>()
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.category}`
    const cur = groups.get(key)
    if (!cur) {
      groups.set(key, { ...f, skills: [...f.skills] })
      continue
    }
    if (RANK[f.severity] > RANK[cur.severity]) {
      cur.severity = f.severity
      cur.summary = f.summary
    }
    for (const sk of f.skills) if (!cur.skills.includes(sk)) cur.skills.push(sk)
    cur.detail = longer(cur.detail, f.detail)
    cur.suggestion = longer(cur.suggestion, f.suggestion)
  }
  return [...groups.values()]
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd server && npx vitest run test/dedup.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/review/dedup.ts server/test/dedup.test.ts
git commit -m "feat: deterministic cross-skill finding dedup"
```

---

### Task 3: Adversarial verifier

**Files:**
- Create: `server/src/review/verify.ts`
- Test: `server/test/verify.test.ts`

**Interfaces:**
- Consumes: `Finding`, `PrMeta`, `RunEvent` (types); `AgentQuery`, `sdkQuery`, `buildQueryOptions` from `runner.js`.
- Produces: `verifyFinding(finding, ctx, onEvent, agentQuery?): Promise<{ verdict: 'confirmed' | 'unverified'; reason?: string }>` where `ctx = { meta: PrMeta; diff: string; cwd: string; model: string }`.

- [ ] **Step 1: Write failing test**

`server/test/verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { verifyFinding } from '../src/review/verify.js'
import type { Finding, RunEvent } from '../src/types.js'

const finding: Finding = {
  file: 'a.ts', line: 1, severity: 'high', category: 'bug',
  summary: 'null deref', detail: 'x may be null', suggestion: 'guard it',
  skills: ['review-code'], verdict: 'confirmed',
}
const ctx = { meta: { title: 'T', description: '', sourceBranch: 's', destinationBranch: 'd', sourceCommit: 'c' }, diff: 'd', cwd: '/tmp', model: 'm' }

function fakeAgent(resultText: string, ok = true) {
  return async function* () {
    yield { type: 'assistant' as const, text: 'checking' }
    yield { type: 'result' as const, ok, text: resultText }
  }
}

describe('verifyFinding', () => {
  it('parses a confirmed verdict', async () => {
    const v = await verifyFinding(finding, ctx, () => {}, fakeAgent('```json\n{"verdict":"confirmed","reason":"real"}\n```'))
    expect(v.verdict).toBe('confirmed')
  })

  it('parses an unverified verdict with reason', async () => {
    const v = await verifyFinding(finding, ctx, () => {}, fakeAgent('```json\n{"verdict":"unverified","reason":"line not in changed code"}\n```'))
    expect(v.verdict).toBe('unverified')
    expect(v.reason).toBe('line not in changed code')
  })

  it('fails open to confirmed when the agent errors', async () => {
    const events: RunEvent[] = []
    const v = await verifyFinding(finding, ctx, (e) => events.push(e), fakeAgent('boom', false))
    expect(v.verdict).toBe('confirmed')
    expect(v.reason).toMatch(/verifier failed/)
    expect(events.some((e) => e.kind === 'error')).toBe(true)
  })

  it('fails open when the result is unparseable after retry', async () => {
    const v = await verifyFinding(finding, ctx, () => {}, fakeAgent('no json here'))
    expect(v.verdict).toBe('confirmed')
    expect(v.reason).toMatch(/verifier failed/)
  })

  it('tags emitted events with skill "verify"', async () => {
    const events: RunEvent[] = []
    await verifyFinding(finding, ctx, (e) => events.push(e), fakeAgent('```json\n{"verdict":"confirmed"}\n```'))
    expect(events.every((e) => e.skill === 'verify')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd server && npx vitest run test/verify.test.ts`
Expected: FAIL — cannot find `../src/review/verify.js`.

- [ ] **Step 3: Implement**

`server/src/review/verify.ts`:

```ts
import { z } from 'zod'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildQueryOptions, type AgentQuery, sdkQuery } from './runner.js'
import type { Finding, PrMeta, RunEvent } from '../types.js'

const VerdictSchema = z.object({
  verdict: z.enum(['confirmed', 'unverified']),
  reason: z.string().optional(),
})

function buildVerifyPrompt(finding: Finding, meta: PrMeta, diff: string): string {
  return `You are adversarially verifying a single claimed code-review finding on a pull request.
The repository is checked out at your working directory at the PR's head commit.
Use Read/Grep/Glob to inspect the ACTUAL code. Try to REFUTE the finding.

# Pull request
Title: ${meta.title}

# Claimed finding
File: ${finding.file}:${finding.line}
Severity: ${finding.severity} · Category: ${finding.category}
Summary: ${finding.summary}
Detail: ${finding.detail}
Suggested fix: ${finding.suggestion}

# Diff under review
\`\`\`diff
${diff}
\`\`\`

# Your job
Re-read the real code around ${finding.file}:${finding.line}. Decide:
- "confirmed" ONLY if the issue is real AND applies to code changed in this diff.
- "unverified" if it's wrong, already handled, not in the changed code, or you cannot confirm it.
When uncertain, answer "unverified".

# Output contract (strict)
End your reply with ONE fenced \`\`\`json object, nothing after it:
{ "verdict": "confirmed" | "unverified", "reason": "one short sentence" }`
}

function extractVerdict(text: string): { verdict: 'confirmed' | 'unverified'; reason?: string } | undefined {
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  const raw = fenced.length > 0 ? fenced[fenced.length - 1][1] : text.trim()
  try {
    const parsed = VerdictSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export const sdkVerifyQuery: AgentQuery = sdkQuery

export async function verifyFinding(
  finding: Finding,
  ctx: { meta: PrMeta; diff: string; cwd: string; model: string },
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery = sdkQuery,
): Promise<{ verdict: 'confirmed' | 'unverified'; reason?: string }> {
  const emit = (e: RunEvent) => onEvent({ ...e, skill: 'verify' })
  const opts = { cwd: ctx.cwd, model: ctx.model }
  try {
    let resultText: string | undefined
    for await (const msg of agentQuery(buildVerifyPrompt(finding, ctx.meta, ctx.diff), opts)) {
      const at = new Date().toISOString()
      if (msg.type === 'assistant') {
        if (msg.text) emit({ kind: 'text', text: msg.text, at })
        if (msg.tool) emit({ kind: 'tool', text: msg.tool, at })
      } else {
        if (!msg.ok) throw new Error(msg.text)
        resultText = msg.text
      }
    }
    const parsed = resultText !== undefined ? extractVerdict(resultText) : undefined
    if (!parsed) throw new Error('unparseable verdict')
    return parsed
  } catch (err: any) {
    emit({ kind: 'error', text: `verifier failed: ${err.message}`, at: new Date().toISOString() })
    return { verdict: 'confirmed', reason: `verifier failed: ${err.message}` }
  }
}
```

Note: the `query`/`buildQueryOptions` imports are only needed if you call `sdkQuery` internals directly — here we default `agentQuery = sdkQuery`, which already wraps `buildQueryOptions`. Remove the unused `query`/`buildQueryOptions` import line if `tsc` flags it (no `noUnusedLocals` today, but keep the import list clean — import only `sdkQuery` and `type AgentQuery`).

- [ ] **Step 4: Run test + typecheck**

Run: `cd server && npx vitest run test/verify.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/review/verify.ts server/test/verify.test.ts
git commit -m "feat: adversarial per-finding verifier (fail-open)"
```

---

### Task 4: Wire dedup + verify into executeRun; `verify` on run creation

**Files:**
- Modify: `server/src/app.ts` (executeRun post-fan-out; POST /api/runs body; run.create)
- Test: `server/test/runPipeline.test.ts`

**Interfaces:**
- Consumes: `dedupeFindings` (Task 2), `verifyFinding` (Task 3), `Finding.verdict`/`skills` (Task 1).
- Produces: `executeRun` sets `run.findings` deduped+verified+sorted; `run.verify` recorded; `POST /api/runs` accepts `verify?: boolean`.

- [ ] **Step 1: Write failing tests**

Add to `server/test/runPipeline.test.ts` (it already builds the app with a fake agentQuery + fixture checkout; mirror its existing setup). Add a per-skill fake that returns the SAME finding location from two skills, and assert dedup+verify:

```ts
it('dedupes same-location findings across skills and verifies once each', async () => {
  // fake agent: skill prompts return a finding at a.ts:5:bug; verify prompt confirms.
  let verifyCalls = 0
  const agent = (prompt: string) => {
    if (/adversarially verifying/.test(prompt)) {
      verifyCalls++
      return (async function* () {
        yield { type: 'result' as const, ok: true, text: '```json\n{"verdict":"confirmed","reason":"ok"}\n```' }
      })()
    }
    const finding = { file: 'a.ts', line: 5, severity: 'high', category: 'bug', summary: 's', detail: 'd', suggestion: 'x', skill: 'ignored' }
    return (async function* () {
      yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
    })()
  }
  // ...submit run with two skills selected, poll to completed...
  // expect: run.findings length 1; findings[0].skills has both skill names; verifyCalls === 1;
  //         findings[0].verdict === 'confirmed'
})

it('skips verification when verify:false — no verifier agent calls, all confirmed', async () => {
  // submit with { verify: false }; assert no prompt matching /adversarially verifying/ was sent,
  // findings all verdict:'confirmed', run.verify === false
})

it('sorts unverified findings after confirmed', async () => {
  // verify prompt returns unverified for one finding, confirmed for another (dispatch on finding summary in prompt);
  // assert run.findings order: confirmed first
})
```

Fill these in against the existing test's harness (reuse its `tempConfigWithSkills`, `fakeAgentPerSkill` pattern, `app.inject`, and the poll-until-completed helper — dispatch the verify branch by matching the verify prompt's distinctive text `adversarially verifying`). Keep them concrete: assert exact `run.findings.length`, `skills`, `verdict`, and `verifyCalls`.

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd server && npx vitest run test/runPipeline.test.ts`
Expected: FAIL — dedup/verify not wired; `verify` not on run.

- [ ] **Step 3: Wire executeRun**

`server/src/app.ts` — add imports:

```ts
import { dedupeFindings } from './review/dedup.js'
import { verifyFinding } from './review/verify.js'
```

Change `executeRun`'s signature ctx to carry `verify` (it already receives `body`; add `verify` to the body type):

```ts
    ctx: { pr: PrRef; meta: PrMeta; diff: string; body: { skills: string[]; focus?: string; verify?: boolean } },
```

Replace the block after the fan-out (currently `run.findings = outcomes.flatMap(...)` … through the `allFailed` computation) with:

```ts
      const merged = outcomes.flatMap((o) => o.findings)
      run.skillResults = outcomes.map((o) => o.result)
      const allFailed = outcomes.every((o) => o.result.status === 'failed')

      let findings = dedupeFindings(merged)
      const doVerify = ctx.body.verify !== false
      run.verify = doVerify
      if (doVerify && findings.length > 0 && !allFailed) {
        emit({ kind: 'status', text: `Verifying ${findings.length} findings…`, at: new Date().toISOString() })
        await Promise.all(
          findings.map((f) =>
            verifyFinding(f, { meta: ctx.meta, diff: ctx.diff, cwd, model: c.model }, emit, agentQuery).then((v) => {
              f.verdict = v.verdict
              f.verifierReason = v.reason
            }),
          ),
        )
      }
      const RANK: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 }
      findings.sort((a, b) => {
        if (a.verdict !== b.verdict) return a.verdict === 'confirmed' ? -1 : 1
        return RANK[b.severity] - RANK[a.severity]
      })
      run.findings = findings

      if (allFailed) {
        run.status = 'failed'
        run.error = `All ${outcomes.length} skill reviews failed`
      } else {
        run.status = 'completed'
      }
```

- [ ] **Step 4: Accept `verify` on run creation**

In `POST /api/runs`, the body type is `{ url: string; skills: string[]; focus?: string; force?: boolean }`. Add `verify?: boolean`. Where the run is created (`store().create({ pr, prTitle, skills, focus, status: 'queued' })`), add `verify: body.verify !== false`. And pass the body through to `executeRun` (it already passes `body`) — the `verify` field rides along.

Note: `RunRecord.verify` is required (Task 1), and `RunStore.create`'s `Omit` excludes the auto-init fields but NOT `verify`, so `create({ ..., verify: ... })` is required and type-checked.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: PASS (all suites, incl. the 3 new pipeline tests), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server && git commit -m "feat: wire dedup + verification into the review run, verify toggle"
```

---

### Task 5: Web — verify toggle, findings shape, verification summary

**Files:**
- Modify: `web/src/types.ts` (mirror Finding + RunRecord.verify)
- Modify: `web/src/api.ts` (createRun `verify`)
- Modify: `web/src/pages/NewReview.tsx` (Verify checkbox, default on, persisted)
- Modify: `web/src/components/FindingCard.tsx` (skills join, unverified badge + reason)
- Modify: `web/src/pages/RunView.tsx` (verification summary line)
- Test: `web/test/` (existing suite must stay green; add a small render-helper test if a pure helper is introduced)

**Interfaces:**
- Consumes: server `Finding`/`RunRecord` shapes (Task 1), `POST /api/runs` `verify` (Task 4).
- Produces: UI reflecting verdicts; `createRun({..., verify})`.

- [ ] **Step 1: Mirror types**

`web/src/types.ts` — update `Finding` to match the server exactly (`skills: string[]`, `verdict: 'confirmed' | 'unverified'`, `verifierReason?: string`; remove `skill`) and add `verify: boolean` to `RunRecord`.

- [ ] **Step 2: api.ts**

`web/src/api.ts` — add `verify?: boolean` to the `createRun` input type and include it in the POST body (it's spread into the JSON already if the input object is passed through; confirm the body includes `verify`).

- [ ] **Step 3: NewReview verify checkbox**

`web/src/pages/NewReview.tsx` — add near the focus textarea a checkbox (use the kit `Checkbox`):

```tsx
// state
const VERIFY_KEY = 'pr-reviewer.verify'
const [verify, setVerify] = useState<boolean>(
  () => JSON.parse(localStorage.getItem(VERIFY_KEY) ?? 'true'),
)
// in the createRun call, add: verify
const res = await createRun({ url, skills: [...selected], focus: focus || undefined, verify, force })
// persist on toggle:
// onCheckedChange={(v) => { const nv = v === true; setVerify(nv); localStorage.setItem(VERIFY_KEY, JSON.stringify(nv)) }}
```

Render a labeled checkbox: "Verify findings (double-check each with a second agent)". Default checked.

- [ ] **Step 4: FindingCard**

`web/src/components/FindingCard.tsx` — change the caption line and add the unverified badge. Replace the `{finding.category} · {finding.skill}` span and add, after the summary `<p>`:

```tsx
            <span className="text-muted-foreground text-xs">
              {finding.category} · {finding.skills.join(', ')}
            </span>
            {finding.verdict === 'unverified' && (
              <span className="bg-muted-200 text-muted-foreground rounded px-1.5 py-0.5 text-xs">
                unverified
              </span>
            )}
```

And under the summary, when unverified with a reason:

```tsx
          {finding.verdict === 'unverified' && finding.verifierReason && (
            <p className="text-muted-foreground text-xs italic">{finding.verifierReason}</p>
          )}
```

(Use only theme tokens — `bg-muted-200`, `text-muted-foreground` — no hardcoded hex. Confirm `bg-muted-200` exists in `web/src/index.css`; if not, use `bg-muted` / the nearest existing muted token.)

- [ ] **Step 5: RunView verification summary**

`web/src/pages/RunView.tsx` — near the existing skill-results chips, for a completed run add a line:

```tsx
{run.status === 'completed' && (
  run.verify
    ? <p className="text-muted-foreground text-sm">
        {run.findings.length} findings · {run.findings.filter((f) => f.verdict === 'confirmed').length} confirmed · {run.findings.filter((f) => f.verdict === 'unverified').length} unverified
      </p>
    : <p className="text-muted-foreground text-sm">{run.findings.length} findings · verification skipped</p>
)}
```

Findings already arrive sorted (confirmed first) from the server — render them in order. Selecting unverified findings for posting stays allowed.

- [ ] **Step 6: Run web tests + build**

Run: `cd web && npx vitest run && npm run build`
Expected: PASS. Update any web test whose fixture used `finding.skill` to `skills: [...]` + `verdict: 'confirmed'`. Build clean.

- [ ] **Step 7: Commit**

```bash
git add web && git commit -m "feat: verify toggle, per-skill credits, unverified labels in review UI"
```

---

### Task 6: Docs — README + smoke note

**Files:**
- Modify: `README.md`
- Modify: `scripts/smoke.md`

- [ ] **Step 1: Update README**

Add a short "Review quality" paragraph: findings are deduplicated across skills and each is adversarially verified by a second agent (toggle on the New Review screen, default on); unverified findings are shown but labeled. Note the cost implication (one extra subagent per deduped finding when on).

- [ ] **Step 2: Update smoke.md**

Add a step: run a review with Verify on, confirm the report shows the "N confirmed · N unverified" line and that unverified findings carry the badge + reason; run once with Verify off and confirm the "verification skipped" line and that all findings render without badges.

- [ ] **Step 3: Commit**

```bash
git add README.md scripts/smoke.md
git commit -m "docs: document dedup + verification and the verify toggle"
```
