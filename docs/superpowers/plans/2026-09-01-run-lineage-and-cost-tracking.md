# Run Lineage & Cost Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show real token/cost totals on a completed run (exact for Claude-SDK sessions, token-only for OpenAI-compatible, unavailable for CLI), and link a run created via "Retry run"/"Retry failed skills" back to its parent so the UI can show what changed.

**Architecture:** Usage data flows through the existing event pipeline (`AgentMessage.result.usage` → a new `kind: 'usage'` `RunEvent` → accumulated on `RunRecord.usage` by `app.ts`'s central `emit()`) rather than changing any function's return type. Lineage rides on one new `RunRecord.parentRunId` field set at creation time; the child run's page fetches its parent through the existing `getRun()` and diffs client-side.

**Tech Stack:** TypeScript, Vitest, Fastify (server); React (web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-run-lineage-and-cost-tracking-design.md`

## Global Constraints

- `costUsd` is only ever populated from Claude-SDK sessions; OpenAI-compatible sessions report token counts with no cost; CLI sessions report nothing.
- `RunRecord.usage` stays entirely absent when no session in the run reported usage — never a fabricated zero.
- Lineage links are created **only** by the explicit "Retry run"/"Retry failed skills" buttons — no auto-linking by PR identity.
- A "Retry failed skills" child's findings are only ever compared against the parent's findings that share a retried skill — never against skills that weren't re-run.
- Every new field is optional; an old run recorded before this feature renders exactly as it does today.

---

### Task 1: Usage extraction on the `claude` and `openai` adapters

**Files:**
- Modify: `server/src/review/runner.ts` (`AgentMessage` type)
- Modify: `server/src/models/claude.ts`
- Modify: `server/src/models/openai.ts`
- Modify: `server/test/runner.test.ts` (new `describe('claudeQuery usage', ...)` block)
- Modify: `server/test/openaiModel.test.ts`
- Modify: `server/test/cliModel.test.ts` (one-line regression guard)

**Interfaces:**
- Produces: `AgentMessage`'s `result` variant gains `usage?: { inputTokens: number; outputTokens: number; costUsd?: number }`. This is the contract Task 2 consumes.

- [ ] **Step 1: Extend the `AgentMessage` type**

In `server/src/review/runner.ts`, change:

```ts
export type AgentMessage =
  | { type: 'assistant'; text?: string; tool?: string }
  | { type: 'result'; ok: boolean; text: string }
```

to:

```ts
export type AgentMessage =
  | { type: 'assistant'; text?: string; tool?: string }
  | {
      type: 'result'
      ok: boolean
      text: string
      usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
    }
```

- [ ] **Step 2: Write the failing test for `claudeQuery`**

Add to `server/test/runner.test.ts`, near the top (after the existing imports) add:

```ts
import { vi } from 'vitest'
```

Then add this new `describe` block after the existing `describe('buildQueryOptions', ...)` block:

```ts
describe('claudeQuery usage', () => {
  it('extracts usage and cost from a successful SDK result', async () => {
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: () =>
        (async function* () {
          yield {
            type: 'result',
            subtype: 'success',
            result: 'done',
            total_cost_usd: 0.05,
            usage: { input_tokens: 500, output_tokens: 80 },
          }
        })(),
    }))
    const { claudeQuery } = await import('../src/models/claude.js')
    const q = claudeQuery({ id: 'c', label: 'Claude', kind: 'claude', model: 'claude-sonnet-5' })
    const events: any[] = []
    for await (const m of q('prompt', { cwd: '/tmp' })) events.push(m)
    const result = events.find((e) => e.type === 'result')
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 80, costUsd: 0.05 })
    vi.doUnmock('@anthropic-ai/claude-agent-sdk')
  })

  it('extracts usage and cost from a failed SDK result — a failed session still spent tokens', async () => {
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: () =>
        (async function* () {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            errors: ['boom'],
            total_cost_usd: 0.02,
            usage: { input_tokens: 300, output_tokens: 10 },
          }
        })(),
    }))
    const { claudeQuery } = await import('../src/models/claude.js')
    const q = claudeQuery({ id: 'c', label: 'Claude', kind: 'claude', model: 'claude-sonnet-5' })
    const events: any[] = []
    for await (const m of q('prompt', { cwd: '/tmp' })) events.push(m)
    const result = events.find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 10, costUsd: 0.02 })
    vi.doUnmock('@anthropic-ai/claude-agent-sdk')
  })
})
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `cd server && npx vitest run test/runner.test.ts -t "claudeQuery usage"`
Expected: FAIL — `result.usage` is `undefined` (the field doesn't exist on `claudeQuery`'s output yet).

- [ ] **Step 4: Implement usage extraction in `claude.ts`**

In `server/src/models/claude.ts`, change the `result` handling:

```ts
      if (msg.type === 'result') {
        // SDKResultMessage is a discriminated union on `subtype`: only the 'success'
        // variant carries `result`; error variants carry `errors: string[]` instead
        // (there is no shared `.result` field to fall back on).
        yield {
          type: 'result',
          ok: msg.subtype === 'success',
          text: msg.subtype === 'success' ? msg.result : msg.errors.join('; ') || 'agent failed',
        }
      }
```

to:

```ts
      if (msg.type === 'result') {
        // SDKResultMessage is a discriminated union on `subtype`: only the 'success'
        // variant carries `result`; error variants carry `errors: string[]` instead
        // (there is no shared `.result` field to fall back on). Both variants carry
        // `usage`/`total_cost_usd` — a failed session still spent real tokens.
        yield {
          type: 'result',
          ok: msg.subtype === 'success',
          text: msg.subtype === 'success' ? msg.result : msg.errors.join('; ') || 'agent failed',
          usage: {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            costUsd: msg.total_cost_usd,
          },
        }
      }
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd server && npx vitest run test/runner.test.ts -t "claudeQuery usage"`
Expected: PASS, both new tests.

- [ ] **Step 6: Write the failing test for `openaiQuery`**

Add to `server/test/openaiModel.test.ts`, inside the existing `describe('openaiQuery', ...)` block, after the first test:

```ts
  it('accumulates prompt/completion tokens across a multi-iteration tool-calling loop', async () => {
    const { fn } = fakeFetch([
      { ...msg(null, [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]), usage: { prompt_tokens: 100, completion_tokens: 20 } },
      { ...msg('```json\n[]\n```'), usage: { prompt_tokens: 150, completion_tokens: 30 } },
    ])
    const result = (await collect(openaiQuery(profile, fn), 'review it', cwd)).find((e) => e.type === 'result')
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 50 })
  })
```

- [ ] **Step 7: Run the test and verify it fails**

Run: `cd server && npx vitest run test/openaiModel.test.ts -t "accumulates prompt/completion tokens"`
Expected: FAIL — `result.usage` is `undefined`.

- [ ] **Step 8: Implement usage accumulation in `openai.ts`**

In `server/src/models/openai.ts`, add accumulator variables before the loop and update them after each successful parse, then attach the total to every `result` yield. The full updated function:

```ts
export function openaiQuery(
  profile: Extract<ModelProfile, { kind: 'openai' }>,
  fetchFn: typeof fetch = fetch,
): AgentQuery {
  return async function* (prompt, opts): AsyncGenerator<AgentMessage> {
    const messages: any[] = [{ role: 'user', content: prompt }]
    let lastText = ''
    let inputTokens = 0
    let outputTokens = 0
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let res: Response
      try {
        res = await fetchFn(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
          body: JSON.stringify({ model: profile.model, messages, tools: TOOL_DEFS }),
        })
      } catch (err: any) {
        yield { type: 'result', ok: false, text: `API request failed: ${err.message}`, usage: { inputTokens, outputTokens } }
        return
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300)
        yield { type: 'result', ok: false, text: `API error ${res.status}: ${body}`, usage: { inputTokens, outputTokens } }
        return
      }
      const data: any = await res.json()
      if (data.usage) {
        inputTokens += data.usage.prompt_tokens ?? 0
        outputTokens += data.usage.completion_tokens ?? 0
      }
      const message = data.choices?.[0]?.message
      if (!message) {
        yield { type: 'result', ok: false, text: 'API returned no message', usage: { inputTokens, outputTokens } }
        return
      }
      messages.push(message)
      if (typeof message.content === 'string' && message.content !== '') {
        lastText = message.content
        yield { type: 'assistant', text: message.content }
      }
      const toolCalls: any[] = message.tool_calls ?? []
      if (toolCalls.length === 0) {
        yield { type: 'result', ok: true, text: lastText, usage: { inputTokens, outputTokens } }
        return
      }
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function?.arguments ?? '{}')
        } catch {
          // malformed arguments: run with empty args so the tool reports the problem back
        }
        const name = call.function?.name ?? ''
        yield { type: 'assistant', tool: `${name} ${JSON.stringify(args).slice(0, 120)}` }
        const result = runTool(opts.cwd, name, args)
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.content })
      }
    }
    yield { type: 'result', ok: true, text: lastText, usage: { inputTokens, outputTokens } }
  }
}
```

- [ ] **Step 9: Run the full openaiModel test file and verify it passes**

Run: `cd server && npx vitest run test/openaiModel.test.ts`
Expected: PASS, all tests including the new one. The pre-existing tests use `fakeFetch` responses with no `usage` key, so `data.usage` is `undefined` there and the `if (data.usage)` guard keeps `inputTokens`/`outputTokens` at `0` — their assertions (which don't check `.usage`) are unaffected.

- [ ] **Step 10: Add a one-line regression guard to `cliModel.test.ts`**

In `server/test/cliModel.test.ts`, in the first test (`'substitutes {prompt} and {cwd} into args...'`), add one line after the existing assertions:

```ts
    expect(result.text.trim()).toBe('hello|/tmp')
    expect(result.usage).toBeUndefined()
```

- [ ] **Step 11: Run the full server test suite and typecheck**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 12: Commit**

```bash
git add server/src/review/runner.ts server/src/models/claude.ts server/src/models/openai.ts server/test/runner.test.ts server/test/openaiModel.test.ts server/test/cliModel.test.ts
git commit -m "feat: extract token usage and cost from claude/openai agent results"
```

---

### Task 2: Emit `usage` run events from the turn-runners

**Files:**
- Modify: `server/src/types.ts` (`RunEvent`)
- Modify: `server/src/review/runner.ts` (`runOnce`)
- Modify: `server/src/review/verify.ts` (`runVerifyTurn`)
- Modify: `server/test/runner.test.ts`
- Modify: `server/test/verify.test.ts`

**Interfaces:**
- Consumes: `AgentMessage.result.usage` from Task 1.
- Produces: a `RunEvent` with `kind: 'usage'` (and `inputTokens`/`outputTokens`/`costUsd?`) whenever a turn's result carries usage. Task 3 consumes this via `app.ts`'s `emit()`.

- [ ] **Step 1: Extend the `RunEvent` type**

In `server/src/types.ts`, change:

```ts
export interface RunEvent {
  kind: 'status' | 'text' | 'tool' | 'error'
  text: string
  at: string
  /** Which per-skill subagent produced this event. Absent for the shared prep phase
   * (checkout) events, which run before the fan-out and aren't attributable to any skill. */
  skill?: string
}
```

to:

```ts
export interface RunEvent {
  kind: 'status' | 'text' | 'tool' | 'error' | 'usage'
  text: string
  at: string
  /** Which per-skill subagent produced this event. Absent for the shared prep phase
   * (checkout) events, which run before the fan-out and aren't attributable to any skill. */
  skill?: string
  /** Set only on kind:'usage' events. */
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}
```

- [ ] **Step 2: Write the failing test for `runOnce`'s usage emission**

Add to `server/test/runner.test.ts`, inside the existing `describe('runReview', ...)` block:

```ts
  it('emits a usage event when the agent result carries usage', async () => {
    const events: RunEvent[] = []
    const agent: AgentQuery = async function* () {
      yield { type: 'result', ok: true, text: goodJson, usage: { inputTokens: 500, outputTokens: 80, costUsd: 0.05 } }
    }
    await runReview(input(agent), (e) => events.push(e))
    const usageEvent = events.find((e) => e.kind === 'usage')
    expect(usageEvent).toBeDefined()
    expect(usageEvent).toMatchObject({ inputTokens: 500, outputTokens: 80, costUsd: 0.05 })
  })

  it('includes a reformat retry\'s usage as its own event, not merged away', async () => {
    const events: RunEvent[] = []
    const main: AgentQuery = async function* () {
      yield { type: 'result', ok: true, text: 'no json here', usage: { inputTokens: 100, outputTokens: 10 } }
    }
    const cheap: AgentQuery = async function* () {
      yield { type: 'result', ok: true, text: goodJson, usage: { inputTokens: 50, outputTokens: 5 } }
    }
    await runReview(input(main, cheap), (e) => events.push(e))
    const usageEvents = events.filter((e) => e.kind === 'usage')
    expect(usageEvents).toHaveLength(2)
    expect(usageEvents[0]).toMatchObject({ inputTokens: 100, outputTokens: 10 })
    expect(usageEvents[1]).toMatchObject({ inputTokens: 50, outputTokens: 5 })
  })
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `cd server && npx vitest run test/runner.test.ts -t "usage event"`
Expected: FAIL — no event with `kind: 'usage'` is ever emitted.

- [ ] **Step 4: Emit the usage event in `runOnce`**

In `server/src/review/runner.ts`, change:

```ts
async function runOnce(
  prompt: string,
  cwd: string,
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery,
): Promise<string> {
  let resultText: string | undefined
  for await (const msg of agentQuery(prompt, { cwd })) {
    const at = new Date().toISOString()
    if (msg.type === 'assistant') {
      if (msg.text) onEvent({ kind: 'text', text: msg.text, at })
      if (msg.tool) onEvent({ kind: 'tool', text: msg.tool, at })
    } else {
      if (!msg.ok) throw new Error(`Agent run failed: ${msg.text}`)
      resultText = msg.text
    }
  }
  if (resultText === undefined) throw new Error('Agent run produced no result message.')
  return resultText
}
```

to:

```ts
async function runOnce(
  prompt: string,
  cwd: string,
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery,
): Promise<string> {
  let resultText: string | undefined
  for await (const msg of agentQuery(prompt, { cwd })) {
    const at = new Date().toISOString()
    if (msg.type === 'assistant') {
      if (msg.text) onEvent({ kind: 'text', text: msg.text, at })
      if (msg.tool) onEvent({ kind: 'tool', text: msg.tool, at })
    } else {
      if (msg.usage) {
        const { inputTokens, outputTokens, costUsd } = msg.usage
        const text = `${(inputTokens + outputTokens).toLocaleString()} tokens${costUsd !== undefined ? ` · $${costUsd.toFixed(2)}` : ''}`
        onEvent({ kind: 'usage', text, at, inputTokens, outputTokens, costUsd })
      }
      if (!msg.ok) throw new Error(`Agent run failed: ${msg.text}`)
      resultText = msg.text
    }
  }
  if (resultText === undefined) throw new Error('Agent run produced no result message.')
  return resultText
}
```

Note the usage event is emitted **before** the `!msg.ok` throw — a failed session's usage must still reach the caller even though `runOnce` then throws.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd server && npx vitest run test/runner.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Write the failing test for `verifyFindingsBatch`'s usage emission**

Add to `server/test/verify.test.ts`, inside the existing `describe('verifyFindingsBatch', ...)` block:

```ts
  it('emits a usage event carrying the verify session\'s tokens and cost', async () => {
    const events: any[] = []
    const agent: AgentQuery = async function* (prompt) {
      const items = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)![1]) as { index: number }[]
      yield {
        type: 'result' as const,
        ok: true,
        text: '```json\n' + JSON.stringify(items.map((it) => ({ index: it.index, verdict: 'confirmed' }))) + '\n```',
        usage: { inputTokens: 200, outputTokens: 15, costUsd: 0.01 },
      }
    }
    await verifyFindingsBatch([mkFinding(0)], { meta, cwd: '/tmp' }, (e) => events.push(e), agent)
    const usageEvent = events.find((e) => e.kind === 'usage')
    expect(usageEvent).toMatchObject({ inputTokens: 200, outputTokens: 15, costUsd: 0.01, skill: 'verify' })
  })
```

- [ ] **Step 7: Run the test and verify it fails**

Run: `cd server && npx vitest run test/verify.test.ts -t "emits a usage event"`
Expected: FAIL — no `kind: 'usage'` event is emitted.

- [ ] **Step 8: Emit the usage event in `runVerifyTurn`**

In `server/src/review/verify.ts`, change:

```ts
async function runVerifyTurn(
  prompt: string,
  cwd: string,
  emit: (e: RunEvent) => void,
  agentQuery: AgentQuery,
): Promise<string> {
  let resultText: string | undefined
  for await (const msg of agentQuery(prompt, { cwd })) {
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
```

to:

```ts
async function runVerifyTurn(
  prompt: string,
  cwd: string,
  emit: (e: RunEvent) => void,
  agentQuery: AgentQuery,
): Promise<string> {
  let resultText: string | undefined
  for await (const msg of agentQuery(prompt, { cwd })) {
    const at = new Date().toISOString()
    if (msg.type === 'assistant') {
      if (msg.text) emit({ kind: 'text', text: msg.text, at })
      if (msg.tool) emit({ kind: 'tool', text: msg.tool, at })
    } else {
      if (msg.usage) {
        const { inputTokens, outputTokens, costUsd } = msg.usage
        const text = `${(inputTokens + outputTokens).toLocaleString()} tokens${costUsd !== undefined ? ` · $${costUsd.toFixed(2)}` : ''}`
        emit({ kind: 'usage', text, at, inputTokens, outputTokens, costUsd })
      }
      if (!msg.ok) throw new Error(msg.text)
      resultText = msg.text
    }
  }
  if (resultText === undefined) throw new Error('Agent run produced no result message.')
  return resultText
}
```

`emit`'s existing `skill: 'verify'` stamping (in `verifyFindingsBatch`'s `const emit = (e: RunEvent) => onEvent({ ...e, skill: 'verify' })`) applies to this event automatically, same as any other kind — no separate change needed for the `skill: 'verify'` assertion in the new test.

- [ ] **Step 9: Run the full server test suite and typecheck**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 10: Commit**

```bash
git add server/src/types.ts server/src/review/runner.ts server/src/review/verify.ts server/test/runner.test.ts server/test/verify.test.ts
git commit -m "feat: emit usage run-events from review and verify turns"
```

---

### Task 3: Accumulate usage onto `RunRecord`

**Files:**
- Modify: `server/src/types.ts` (`RunRecord`)
- Modify: `server/src/app.ts` (`emit`)
- Modify: `web/src/types.ts` (`RunEvent`, `RunRecord`)
- Modify: `server/test/runPipeline.test.ts`

**Interfaces:**
- Consumes: `kind: 'usage'` `RunEvent`s from Task 2.
- Produces: `RunRecord.usage?: { inputTokens: number; outputTokens: number; costUsd?: number }`. Task 6 (UI) consumes this.

- [ ] **Step 1: Add `usage` to the server `RunRecord` type**

In `server/src/types.ts`, add to the `RunRecord` interface (after `skillResults: SkillRunResult[]`):

```ts
  skillResults: SkillRunResult[]
  /** Accumulated token/cost totals across every session in this run. Absent when no
   * session reported usage (e.g. an all-CLI-profile run) — never a fabricated zero. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
}
```

- [ ] **Step 2: Mirror the fields on the web `Finding`/`RunEvent`/`RunRecord` types**

In `web/src/types.ts`:

```ts
export interface RunEvent {
  kind: 'status' | 'text' | 'tool' | 'error' | 'usage'
  text: string
  at: string
  /** Which per-skill subagent produced this event. Absent for the shared prep phase
   * (checkout) events, which run before the fan-out and aren't attributable to any skill. */
  skill?: string
  /** Set only on kind:'usage' events. */
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}
```

and, on `RunRecord` (after `skillResults: SkillRunResult[]`):

```ts
  skillResults: SkillRunResult[]
  /** Accumulated token/cost totals across every session in this run. Absent when no
   * session reported usage (e.g. an all-CLI-profile run) — never a fabricated zero. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
}
```

- [ ] **Step 3: Write the failing integration test**

In `server/test/runPipeline.test.ts`, add a new test inside `describe('run pipeline integration', ...)`, after the "attaches diff context..." test:

```ts
  it('accumulates usage from review and verify sessions onto the run record', async () => {
    const path = tempConfig()
    const diff = '+line1\n+line2\n'
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
    const agent: AgentQuery = async function* (prompt) {
      if (/adversarially verifying/.test(prompt)) {
        const items = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)![1]) as { index: number }[]
        yield {
          type: 'result' as const,
          ok: true,
          text: '```json\n' + JSON.stringify(items.map((it) => ({ index: it.index, verdict: 'confirmed' }))) + '\n```',
          usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
        }
        return
      }
      yield {
        type: 'result' as const,
        ok: true,
        text: '```json\n' + JSON.stringify([finding]) + '\n```',
        usage: { inputTokens: 500, outputTokens: 80, costUsd: 0.05 },
      }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [] },
    })
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    expect(run.usage).toEqual({ inputTokens: 600, outputTokens: 100, costUsd: 0.06 })
  })

  it('reports a partial total when only some sessions in the run measure usage', async () => {
    // Mirrors a CLI-profile review paired with a Claude-SDK verify pass: the review
    // session reports no usage at all (like cliQuery never does), only verify does.
    const path = tempConfig()
    const diff = '+line1\n+line2\n'
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
    const agent: AgentQuery = async function* (prompt) {
      if (/adversarially verifying/.test(prompt)) {
        const items = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)![1]) as { index: number }[]
        yield {
          type: 'result' as const,
          ok: true,
          text: '```json\n' + JSON.stringify(items.map((it) => ({ index: it.index, verdict: 'confirmed' }))) + '\n```',
          usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
        }
        return
      }
      // No `usage` field at all — the review session reports nothing, as a CLI adapter would.
      yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [] },
    })
    const { id } = createRes.json()
    const run = await pollRun(app, id)
    expect(run.status).toBe('completed')
    // Only the verify session's numbers show up — never a fabricated figure for the
    // review session that reported nothing.
    expect(run.usage).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 })
  })
```

- [ ] **Step 4: Run the tests and verify they fail**

Run: `cd server && npx vitest run test/runPipeline.test.ts -t "usage"`
Expected: FAIL — both new tests fail; `run.usage` is `undefined` in each.

- [ ] **Step 5: Accumulate usage in `app.ts`'s `emit`**

Find the `emit` function inside `executeRun` (`server/src/app.ts`):

```ts
      const emit = (e: RunEvent) => {
        run!.transcript.push(e)
        s!.save(run!)
        events.emit(runId, e)
      }
```

Change it to:

```ts
      const emit = (e: RunEvent) => {
        run!.transcript.push(e)
        if (e.kind === 'usage') {
          run!.usage ??= { inputTokens: 0, outputTokens: 0 }
          run!.usage.inputTokens += e.inputTokens ?? 0
          run!.usage.outputTokens += e.outputTokens ?? 0
          if (e.costUsd !== undefined) run!.usage.costUsd = (run!.usage.costUsd ?? 0) + e.costUsd
        }
        s!.save(run!)
        events.emit(runId, e)
      }
```

- [ ] **Step 6: Run the full server test suite and typecheck**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS. The pre-existing "drives POST /api/runs..." and "attaches diff context..." tests use `fakeAgent`, whose results never carry `usage` — no `kind: 'usage'` event ever fires for them, so `run!.usage` stays untouched (`undefined`), and neither test asserts on `.usage`, so both remain green.

- [ ] **Step 7: Typecheck the web package too**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (the type-only changes in `web/src/types.ts` compile cleanly with no consumers yet).

- [ ] **Step 8: Commit**

```bash
git add server/src/types.ts server/src/app.ts web/src/types.ts server/test/runPipeline.test.ts
git commit -m "feat: accumulate usage events onto the run record"
```

---

### Task 4: `parentRunId` — create, store, wire from Retry

**Files:**
- Modify: `server/src/types.ts` (`RunRecord`)
- Modify: `server/src/app.ts` (`POST /api/runs` body + `store().create(...)`)
- Modify: `web/src/types.ts` (`RunRecord`)
- Modify: `web/src/api.ts` (`createRun` input type)
- Modify: `web/src/pages/RunView.tsx` (`retry`, `retryFailedSkills`)
- Modify: `server/test/runPipeline.test.ts`

**Interfaces:**
- Produces: `RunRecord.parentRunId?: string`, returned by `GET /api/runs/:id`. Task 7 (UI) consumes this.

- [ ] **Step 1: Add `parentRunId` to the server `RunRecord` type**

In `server/src/types.ts`, add to `RunRecord` (after `id: string`):

```ts
export interface RunRecord {
  id: string
  /** The run this one was created from via "Retry run"/"Retry failed skills". Absent for
   * a run started fresh from New Review. Not validated against an existing run — a stale
   * or missing parent is indistinguishable from having none at all. */
  parentRunId?: string
  pr: PrRef
```

- [ ] **Step 2: Write the failing test**

Add to `server/test/runPipeline.test.ts`, after the "accumulates usage..." test:

```ts
  it('persists parentRunId when provided on create', async () => {
    const path = tempConfig()
    const diff = '+line1\n'
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: fakeAgent([]),
    })
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], parentRunId: 'parent-123' },
    })
    const { id } = createRes.json()
    const getRes = await app.inject({ method: 'GET', url: `/api/runs/${id}` })
    expect(getRes.json().parentRunId).toBe('parent-123')
  })
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `cd server && npx vitest run test/runPipeline.test.ts -t "persists parentRunId"`
Expected: FAIL — `parentRunId` is `undefined` on the fetched run.

- [ ] **Step 4: Accept and store `parentRunId` in `app.ts`**

In `server/src/app.ts`'s `POST /api/runs` handler, add `parentRunId` to the body type:

```ts
    const body = req.body as {
      url: string
      skills: string[]
      focus?: string
      force?: boolean
      verify?: boolean
      depth?: Depth
      profile?: string
      autoSubmit?: AutoSubmit
      parentRunId?: string
    }
```

and pass it through to `store().create(...)`:

```ts
    const run = store().create({
      pr,
      prTitle: meta.title,
      skills: body.skills,
      focus: body.focus,
      verify: body.verify !== false,
      depth,
      reviewProfile: reviewProfileId,
      autoSubmit: body.autoSubmit,
      parentRunId: body.parentRunId,
      status: 'queued',
    })
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `cd server && npx vitest run test/runPipeline.test.ts -t "persists parentRunId"`
Expected: PASS.

- [ ] **Step 6: Mirror `parentRunId` on the web `RunRecord` type**

In `web/src/types.ts`, add to `RunRecord` (after `id: string`):

```ts
export interface RunRecord {
  id: string
  /** The run this one was created from via "Retry run"/"Retry failed skills". Absent for
   * a run started fresh from New Review. */
  parentRunId?: string
  pr: PrRef
```

- [ ] **Step 7: Add `parentRunId` to `createRun`'s input type**

In `web/src/api.ts`, add to `createRun`'s `input` parameter type:

```ts
export async function createRun(input: {
  url: string
  skills: string[]
  focus?: string
  verify?: boolean
  force?: boolean
  depth?: 'thorough' | 'balanced' | 'economy'
  profile?: string
  autoSubmit?: AutoSubmit
  parentRunId?: string
}): Promise<{ id?: string; error?: string; diffLines?: number; status: number }> {
```

- [ ] **Step 8: Pass `parentRunId` from `RunView.tsx`'s retry actions**

In `web/src/pages/RunView.tsx`, change `retry()`:

```ts
  async function retry() {
    if (!run) return
    const res = await createRun({
      url: prUrl(run),
      skills: run.skills,
      focus: run.focus,
      verify: run.verify,
      depth: run.depth,
      profile: run.reviewProfile,
      force: true,
      parentRunId: run.id,
    })
    if (res.id) navigate(`/runs/${res.id}`)
  }
```

and `retryFailedSkills()`:

```ts
  async function retryFailedSkills() {
    if (!run) return
    const failedNames = failedSkillNames(run)
    if (failedNames.length === 0) return
    const res = await createRun({
      url: prUrl(run),
      skills: failedNames,
      focus: run.focus,
      verify: run.verify,
      depth: run.depth,
      profile: run.reviewProfile,
      force: true,
      parentRunId: run.id,
    })
    if (res.id) navigate(`/runs/${res.id}`)
  }
```

- [ ] **Step 9: Run the full server test suite, web typecheck, and build**

Run: `cd server && npm test && npx tsc --noEmit`
Run: `cd web && npm run build`
Expected: PASS, no errors.

- [ ] **Step 10: Commit**

```bash
git add server/src/types.ts server/src/app.ts web/src/types.ts web/src/api.ts web/src/pages/RunView.tsx server/test/runPipeline.test.ts
git commit -m "feat: link a retry run to its parent via parentRunId"
```

---

### Task 5: Findings diff (`web/src/lib/lineage.ts`)

**Files:**
- Create: `web/src/lib/lineage.ts`
- Test: `web/test/lineage.test.ts`

**Interfaces:**
- Consumes: `Finding` from `web/src/types.js` (`file`, `category`, `summary`, `skills`).
- Produces:
  ```ts
  export interface FindingDelta {
    newFindings: Finding[]
    stillOpen: Finding[]
    resolved: Finding[]
  }
  export function diffFindings(parentFindings: Finding[], childFindings: Finding[]): FindingDelta
  export function scopeToRetriedSkills(parentFindings: Finding[], childSkills: string[]): Finding[]
  ```
  Task 7 consumes both — `scopeToRetriedSkills` must be called on the parent's findings before they're passed into `diffFindings`.

- [ ] **Step 1: Write the failing tests**

Create `web/test/lineage.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { diffFindings, scopeToRetriedSkills } from '../src/lib/lineage.js'
import type { Finding } from '../src/types.js'

const f = (overrides: Partial<Finding> = {}): Finding => ({
  file: 'a.ts',
  line: 1,
  severity: 'low',
  category: 'style',
  summary: 'summary',
  detail: 'd',
  suggestion: 'x',
  skills: ['sec'],
  verdict: 'confirmed',
  ...overrides,
})

describe('diffFindings', () => {
  it('classifies a finding present in both as still open', () => {
    const parent = [f({ summary: 'Same issue' })]
    const child = [f({ summary: 'Same issue' })]
    const delta = diffFindings(parent, child)
    expect(delta.stillOpen).toHaveLength(1)
    expect(delta.newFindings).toHaveLength(0)
    expect(delta.resolved).toHaveLength(0)
  })

  it('classifies a finding only in the child as new', () => {
    const parent: Finding[] = []
    const child = [f({ summary: 'Fresh issue' })]
    const delta = diffFindings(parent, child)
    expect(delta.newFindings).toEqual(child)
    expect(delta.stillOpen).toHaveLength(0)
    expect(delta.resolved).toHaveLength(0)
  })

  it('classifies a finding only in the parent as resolved', () => {
    const parent = [f({ summary: 'Fixed now' })]
    const child: Finding[] = []
    const delta = diffFindings(parent, child)
    expect(delta.resolved).toEqual(parent)
    expect(delta.newFindings).toHaveLength(0)
    expect(delta.stillOpen).toHaveLength(0)
  })

  it('matches on file + category + normalized summary, ignoring case and extra whitespace', () => {
    const parent = [f({ file: 'a.ts', category: 'bug', summary: '  Null   check  missing ' })]
    const child = [f({ file: 'a.ts', category: 'bug', summary: 'null check missing' })]
    const delta = diffFindings(parent, child)
    expect(delta.stillOpen).toHaveLength(1)
  })

  it('treats a different file or category as a different finding, even with the same summary', () => {
    const parent = [f({ file: 'a.ts', category: 'bug', summary: 'Same text' })]
    const child = [f({ file: 'b.ts', category: 'bug', summary: 'Same text' })]
    const delta = diffFindings(parent, child)
    expect(delta.newFindings).toHaveLength(1)
    expect(delta.resolved).toHaveLength(1)
  })
})

describe('scopeToRetriedSkills', () => {
  it('keeps a parent finding whose skills overlap the retried set', () => {
    const parent = [f({ skills: ['sec', 'perf'] })]
    expect(scopeToRetriedSkills(parent, ['perf'])).toEqual(parent)
  })

  it('drops a parent finding whose skills do not overlap the retried set', () => {
    const parent = [f({ skills: ['perf'] })]
    expect(scopeToRetriedSkills(parent, ['sec'])).toEqual([])
  })

  it('is a no-op when the child retried every skill the parent finding has', () => {
    const parent = [f({ skills: ['sec'] }), f({ skills: ['perf'], file: 'b.ts' })]
    expect(scopeToRetriedSkills(parent, ['sec', 'perf'])).toEqual(parent)
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd web && npx vitest run test/lineage.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/lineage.js'`.

- [ ] **Step 3: Implement `lineage.ts`**

Create `web/src/lib/lineage.ts`:

```ts
import type { Finding } from '../types.js'

function findingKey(f: Finding): string {
  return `${f.file}|${f.category}|${f.summary.toLowerCase().replace(/\s+/g, ' ').trim()}`
}

export interface FindingDelta {
  newFindings: Finding[]
  stillOpen: Finding[]
  resolved: Finding[]
}

/** Diffs a child run's findings against its parent's, using the same identity rule
 * review/fingerprint.ts uses server-side for comment idempotency — file + category +
 * normalized summary — as a plain string key instead of a hash, since this only needs Set
 * membership. Call scopeToRetriedSkills on the parent findings first when the child came
 * from "Retry failed skills", so a skill that wasn't re-run is never counted as resolved. */
export function diffFindings(parentFindings: Finding[], childFindings: Finding[]): FindingDelta {
  const parentKeys = new Set(parentFindings.map(findingKey))
  const childKeys = new Set(childFindings.map(findingKey))
  return {
    newFindings: childFindings.filter((f) => !parentKeys.has(findingKey(f))),
    stillOpen: childFindings.filter((f) => parentKeys.has(findingKey(f))),
    resolved: parentFindings.filter((f) => !childKeys.has(findingKey(f))),
  }
}

/** Scopes a parent run's findings down to only those sharing at least one skill with the
 * child run's skill list. Required before diffFindings when the child came from "Retry
 * failed skills", which only re-runs a subset of skills — without this filter, every
 * untouched skill's findings would wrongly show up as "resolved" just because the child
 * never re-evaluated them. A full retry keeps the same skills as its parent, so this is a
 * no-op there. */
export function scopeToRetriedSkills(parentFindings: Finding[], childSkills: string[]): Finding[] {
  const retried = new Set(childSkills)
  return parentFindings.filter((f) => f.skills.some((s) => retried.has(s)))
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run test/lineage.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Run the full web test suite and typecheck**

Run: `cd web && npm test && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/lineage.ts web/test/lineage.test.ts
git commit -m "feat: diff a run's findings against its parent's"
```

---

### Task 6: Show usage totals on `RunView`

**Files:**
- Modify: `web/src/pages/RunView.tsx`

**Interfaces:**
- Consumes: `RunRecord.usage` from Task 3.

No new unit tests — presentational only, following the same convention as `FindingCard.tsx`'s prior UI-only changes (no `@testing-library/react` in this repo; verification is typecheck + build + full test suite).

- [ ] **Step 1: Add the usage badge**

In `web/src/pages/RunView.tsx`, in the badges row (inside the `<div className="flex flex-wrap items-center gap-1.5">` block), add a new badge right after the existing verify badge and before the `run.skills.map(...)` line:

```tsx
          <Badge variant={run.verify ? 'accent' : 'muted'} size="xs">
            {run.verify ? 'verified' : 'unverified run'}
          </Badge>
          {run.usage ? (
            <Badge variant="muted" size="xs">
              {(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tokens
              {run.usage.costUsd !== undefined && ` · $${run.usage.costUsd.toFixed(2)}`}
            </Badge>
          ) : (
            run.status === 'completed' && (
              <Badge variant="muted" size="xs">
                cost unavailable
              </Badge>
            )
          )}
          {run.skills.map((s) => (
```

Note the `run.status === 'completed'` guard on the "cost unavailable" badge — a still-running run simply hasn't accumulated usage yet, which isn't the same as it never being available; showing "cost unavailable" only once the run is done avoids a misleading flash during a run that's actually about to report usage.

- [ ] **Step 2: Run the full web test suite, typecheck, and build**

Run: `cd web && npm test && npm run build`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/RunView.tsx
git commit -m "feat(ui): show token/cost totals on the run page"
```

---

### Task 7: Show lineage on `RunView`

**Files:**
- Modify: `web/src/pages/RunView.tsx`
- Modify: `web/src/components/FindingCard.tsx`

**Interfaces:**
- Consumes: `RunRecord.parentRunId` (Task 4), `diffFindings`/`scopeToRetriedSkills` (Task 5).

No new unit tests — presentational only, same rationale as Task 6.

- [ ] **Step 1: Add a `isNew` prop to `FindingCard`**

In `web/src/components/FindingCard.tsx`, add `isNew` to the props:

```tsx
export function FindingCard({
  finding,
  index,
  checked,
  onToggle,
  isNew,
}: {
  finding: Finding
  index: number
  checked: boolean
  onToggle: (index: number) => void
  isNew?: boolean
}) {
```

and render a small badge next to the existing "unverified" badge — insert right before the `{finding.verdict === 'unverified' && (...)}` block:

```tsx
            {isNew && (
              <span className="bg-primary-15 text-primary rounded px-1.5 py-0.5 text-xs">new</span>
            )}
            {finding.verdict === 'unverified' && (
```

- [ ] **Step 2: Fetch the parent run in `RunView.tsx`**

Add a new piece of state and a fetch effect. Near the existing state declarations:

```ts
  const [parentRun, setParentRun] = useState<RunRecord | null>(null)
```

Add a new effect, after the existing run-loading effect:

```ts
  useEffect(() => {
    if (!run?.parentRunId) {
      setParentRun(null)
      return
    }
    let cancelled = false
    getRun(run.parentRunId)
      .then((p) => {
        if (!cancelled) setParentRun(p)
      })
      .catch(() => {
        // Parent deleted or unreachable — no lineage UI, rest of the page is unaffected.
        if (!cancelled) setParentRun(null)
      })
    return () => {
      cancelled = true
    }
  }, [run?.parentRunId])
```

- [ ] **Step 3: Compute the delta**

Add the import:

```ts
import { diffFindings, scopeToRetriedSkills } from '@/lib/lineage'
```

After the existing `const { confirmed, unverified } = partitionFindingsByVerdict(run.findings)` line, add:

```ts
  const delta =
    parentRun && run.status === 'completed'
      ? diffFindings(scopeToRetriedSkills(parentRun.findings, run.skills), run.findings)
      : null
  const newFindingKeys = new Set(
    (delta?.newFindings ?? []).map((f) => `${f.file}|${f.category}|${f.summary}`),
  )
```

- [ ] **Step 4: Render the summary line and resolved section**

Insert this block right after the `run.status === 'completed' && run.verify && (...)` confirmed/unverified count paragraph, inside `Tabs.Content value="findings"`:

```tsx
            {delta && (delta.newFindings.length > 0 || delta.resolved.length > 0 || delta.stillOpen.length > 0) && (
              <p className="text-muted-foreground text-sm">
                Compared to the previous run: {delta.newFindings.length} new · {delta.resolved.length} resolved ·{' '}
                {delta.stillOpen.length} still open
              </p>
            )}

            {delta && delta.resolved.length > 0 && (
              <Collapsible>
                <Collapsible.Trigger className="text-muted-foreground hover:text-foreground w-fit text-sm">
                  Resolved since last run ({delta.resolved.length})
                </Collapsible.Trigger>
                <Collapsible.Content>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {delta.resolved.map((f, i) => (
                      <li key={i} className="text-muted-foreground flex items-center gap-2 text-sm">
                        <span className="bg-code-surface text-code-foreground font-family-mono rounded px-1.5 py-0.5 text-xs">
                          {f.file}:{f.line}
                        </span>
                        {f.summary}
                      </li>
                    ))}
                  </ul>
                </Collapsible.Content>
              </Collapsible>
            )}
```

Add the `Collapsible` import:

```ts
import { Collapsible } from '@/components/ui/collapsible'
```

- [ ] **Step 5: Pass `isNew` down to `FindingCard`**

In the findings-rendering block, change the `FindingCard` usage to pass `isNew`:

```tsx
                        return (
                          <FindingCard
                            key={index}
                            finding={finding}
                            index={index}
                            checked={checked.has(index)}
                            onToggle={toggleFinding}
                            isNew={newFindingKeys.has(`${finding.file}|${finding.category}|${finding.summary}`)}
                          />
                        )
```

- [ ] **Step 6: Run the full web test suite, typecheck, and build**

Run: `cd web && npm test && npm run build`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/RunView.tsx web/src/components/FindingCard.tsx
git commit -m "feat(ui): show new/resolved/still-open findings compared to the parent run"
```
