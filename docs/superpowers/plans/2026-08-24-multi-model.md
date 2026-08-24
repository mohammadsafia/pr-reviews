# Multi-Model Review Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each run pick its review model from user-managed profiles (Claude SDK, agentic CLIs like Codex, OpenAI-compatible APIs like Kimi), and add an opt-in auto-submit that posts filtered findings to the PR on completion.

**Architecture:** A `modelProfiles` config registry with three adapter kinds, each producing the existing `AgentQuery` iterable via `queryFor(profile)`. The runner/verifier stop knowing model names — they receive resolved `AgentQuery` values from `executeRun`. Auto-submit reuses the extracted comment-posting loop with fingerprint idempotency, fail-closed when existing comments can't be read.

**Tech Stack:** Node 20 + TypeScript ESM (`.js` import suffixes), Fastify, zod, plain `fetch` for the openai adapter (no new dependencies), vitest; React + Vite web.

**Spec:** `docs/superpowers/specs/2026-08-24-multi-model-design.md`

## Global Constraints

- ESM everywhere: relative imports end in `.js`. No new npm dependencies.
- Default profiles: exactly `claude-sonnet` (model `claude-sonnet-5`) and `claude-haiku` (model `claude-haiku-4-5-20251001`); `reviewProfile` default `claude-sonnet`, `verifyProfile` default `claude-haiku`.
- CLI adapter: `{prompt}`/`{cwd}` placeholder substitution in args; prompt via stdin when no arg contains `{prompt}`; default `timeoutMs` 900000 (15 min); non-zero exit → failure with stderr tail.
- openai adapter: tools `read_file`/`grep`/`list_files` executed locally, paths confined to the worktree (`relative()` guard), reads capped at 2000 lines / 50KB, loop ceiling 40 iterations; API keys masked as `***` through the config API and never echoed in errors.
- Auto-submit thresholds: `high` → {high}, `medium` → {high, medium}, `all` → all severities. Fires only on `completed` runs; dedupe-read failure posts NOTHING (fail-closed); posting failures never change run status.
- The `deps.agentQuery` test seam overrides BOTH review and verify queries (existing tests must keep passing unchanged); `deps.queryFactory` is the per-profile routing seam.
- Server tests: `cd server && npx vitest run test/<file>` (never from the repo root). Web: `cd web && npx vitest run`. Full: `npm test` at repo root.
- Commit after every task; `git add` only files the task touched.
- Codex collaboration: Tasks 4 and 9 contain a step to invoke the `codex-delegate` skill if it is available in the session; if unavailable, note that and proceed.

---

## Phase 1 — Profiles, claude & cli adapters, orchestration, UI

### Task 1: Profile schema, migration, and resolver

**Files:**
- Create: `server/src/models/profiles.ts`
- Modify: `server/src/config.ts`
- Test: `server/test/profiles.test.ts`, `server/test/config.test.ts`

**Interfaces:**
- Produces (everything later tasks import from `../models/profiles.js` / config):
  - `ModelProfileSchema` (zod discriminated union on `kind`), `type ModelProfile`
  - `DEFAULT_PROFILES: ModelProfile[]` (the two claude defaults)
  - `profileById(cfg: { modelProfiles: ModelProfile[] }, id: string | undefined): ModelProfile` — never throws; unknown/undefined id → first `claude`-kind profile, else first profile, else the built-in `claude-sonnet` default.
  - `Config.modelProfiles: ModelProfile[]`, `Config.reviewProfile: string`, `Config.verifyProfile: string`; legacy `model`/`verifyModel` stay in the schema.

- [ ] **Step 1: Write the failing tests** — create `server/test/profiles.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_PROFILES, ModelProfileSchema, profileById, type ModelProfile } from '../src/models/profiles.js'

const cli: ModelProfile = { id: 'codex', label: 'Codex', kind: 'cli', command: 'codex', args: ['exec', '--cd', '{cwd}', '-'] }
const openai: ModelProfile = { id: 'kimi', label: 'Kimi', kind: 'openai', baseUrl: 'https://api.moonshot.ai/v1', apiKey: 'k', model: 'kimi-k2' }

describe('ModelProfileSchema', () => {
  it('accepts all three kinds', () => {
    expect(ModelProfileSchema.safeParse(DEFAULT_PROFILES[0]).success).toBe(true)
    expect(ModelProfileSchema.safeParse(cli).success).toBe(true)
    expect(ModelProfileSchema.safeParse(openai).success).toBe(true)
  })
  it('rejects an unknown kind and missing kind-specific fields', () => {
    expect(ModelProfileSchema.safeParse({ id: 'x', label: 'x', kind: 'magic' }).success).toBe(false)
    expect(ModelProfileSchema.safeParse({ id: 'x', label: 'x', kind: 'openai', model: 'm' }).success).toBe(false)
  })
})

describe('profileById', () => {
  const cfg = { modelProfiles: [cli, ...DEFAULT_PROFILES, openai] }
  it('finds a profile by id', () => {
    expect(profileById(cfg, 'kimi')).toBe(openai)
  })
  it('falls back to the first claude profile for unknown or undefined ids', () => {
    expect(profileById(cfg, 'deleted-one').id).toBe('claude-sonnet')
    expect(profileById(cfg, undefined).id).toBe('claude-sonnet')
  })
  it('falls back to the first profile when no claude profile exists', () => {
    expect(profileById({ modelProfiles: [cli, openai] }, 'nope')).toBe(cli)
  })
  it('falls back to the built-in default when the list is empty', () => {
    expect(profileById({ modelProfiles: [] }, 'nope').id).toBe('claude-sonnet')
  })
})
```

Append to `server/test/config.test.ts` (inside the top-level describe):

```ts
  describe('model profiles', () => {
    it('defaults modelProfiles, reviewProfile, and verifyProfile', () => {
      const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
      const path = join(dir, 'config.json')
      writeFileSync(path, JSON.stringify({}))
      const cfg = loadConfig(path)
      expect(cfg.modelProfiles.map((p) => p.id)).toEqual(['claude-sonnet', 'claude-haiku'])
      expect(cfg.reviewProfile).toBe('claude-sonnet')
      expect(cfg.verifyProfile).toBe('claude-haiku')
    })

    it('migrates legacy model/verifyModel strings into synthesized profiles', () => {
      const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
      const path = join(dir, 'config.json')
      writeFileSync(path, JSON.stringify({ model: 'claude-opus-4-8', verifyModel: 'claude-sonnet-5' }))
      const cfg = loadConfig(path)
      const review = cfg.modelProfiles.find((p) => p.id === cfg.reviewProfile)!
      const verify = cfg.modelProfiles.find((p) => p.id === cfg.verifyProfile)!
      expect(review.kind).toBe('claude')
      expect((review as any).model).toBe('claude-opus-4-8')
      expect((verify as any).model).toBe('claude-sonnet-5')
    })

    it('does NOT migrate when modelProfiles is explicitly stored', () => {
      const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
      const path = join(dir, 'config.json')
      writeFileSync(
        path,
        JSON.stringify({
          model: 'claude-opus-4-8',
          modelProfiles: [{ id: 'mine', label: 'Mine', kind: 'claude', model: 'claude-sonnet-5' }],
          reviewProfile: 'mine',
        }),
      )
      const cfg = loadConfig(path)
      expect(cfg.modelProfiles.map((p) => p.id)).toEqual(['mine'])
      expect(cfg.reviewProfile).toBe('mine')
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/profiles.test.ts test/config.test.ts`
Expected: FAIL — module and fields missing.

- [ ] **Step 3: Implement** — create `server/src/models/profiles.ts`:

```ts
import { z } from 'zod'

export const ModelProfileSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1), label: z.string().min(1), kind: z.literal('claude'), model: z.string().min(1) }),
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.literal('cli'),
    command: z.string().min(1),
    args: z.array(z.string()),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.literal('openai'),
    baseUrl: z.string().min(1),
    apiKey: z.string(),
    model: z.string().min(1),
  }),
])

export type ModelProfile = z.infer<typeof ModelProfileSchema>

export const DEFAULT_PROFILES: ModelProfile[] = [
  { id: 'claude-sonnet', label: 'Claude Sonnet', kind: 'claude', model: 'claude-sonnet-5' },
  { id: 'claude-haiku', label: 'Claude Haiku', kind: 'claude', model: 'claude-haiku-4-5-20251001' },
]

/** Resolves a profile reference. Never throws: unknown/undefined ids fall back to the
 * first claude-kind profile, else the first profile, else the built-in default — a
 * dangling reference (deleted profile) must degrade, not crash a queued run. */
export function profileById(cfg: { modelProfiles: ModelProfile[] }, id: string | undefined): ModelProfile {
  const list = cfg.modelProfiles
  const found = id !== undefined ? list.find((p) => p.id === id) : undefined
  return found ?? list.find((p) => p.kind === 'claude') ?? list[0] ?? DEFAULT_PROFILES[0]
}
```

In `server/src/config.ts`: import `DEFAULT_PROFILES, ModelProfileSchema, type ModelProfile` from `./models/profiles.js`; add to `ConfigSchema` after `maxConcurrentRuns`:

```ts
  modelProfiles: z.array(ModelProfileSchema).default(DEFAULT_PROFILES),
  reviewProfile: z.string().default('claude-sonnet'),
  verifyProfile: z.string().default('claude-haiku'),
```

Add the migration helper and call it from BOTH return paths of `loadConfig` (the `parsed.success` return and the degraded-merge return), passing the raw object:

```ts
/** Legacy model/verifyModel strings predate profiles. When no modelProfiles were stored
 * but the legacy fields were customized, synthesize claude profiles from them so tuned
 * settings never silently reset to defaults. */
function migrateLegacyModels(cfg: Config, raw: Record<string, unknown>): Config {
  if (raw.modelProfiles !== undefined) return cfg
  const out: Config = { ...cfg, modelProfiles: [...cfg.modelProfiles] }
  if (typeof raw.model === 'string' && raw.model !== 'claude-sonnet-5') {
    out.modelProfiles = [
      { id: 'legacy-model', label: `Claude (${raw.model})`, kind: 'claude', model: raw.model } as ModelProfile,
      ...out.modelProfiles,
    ]
    out.reviewProfile = 'legacy-model'
  }
  if (typeof raw.verifyModel === 'string' && raw.verifyModel !== 'claude-haiku-4-5-20251001') {
    out.modelProfiles = [
      ...out.modelProfiles,
      { id: 'legacy-verify', label: `Claude verify (${raw.verifyModel})`, kind: 'claude', model: raw.verifyModel } as ModelProfile,
    ]
    out.verifyProfile = 'legacy-verify'
  }
  return out
}
```

In `loadConfig`, capture `const rawForMigration = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>` right after parsing the file, and wrap both returns: `return migrateLegacyModels(parsed.data, rawForMigration)` / `return migrateLegacyModels(merged, rawForMigration)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/profiles.test.ts test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/models/profiles.ts server/src/config.ts server/test/profiles.test.ts server/test/config.test.ts
git commit -m "feat: model profile registry with legacy model migration"
```

---

### Task 2: API-key masking through the config API

**Files:**
- Modify: `server/src/app.ts` (the `GET /api/config` and `PUT /api/config` routes)
- Test: `server/test/app.test.ts`

**Interfaces:**
- Consumes: `Config.modelProfiles` (Task 1).
- Produces: GET masks every openai profile's `apiKey` as `***` (empty keys stay empty); PUT restores the stored key for any openai profile (matched by `id`) whose incoming `apiKey` is `***`.

- [ ] **Step 1: Write the failing test** — append to `server/test/app.test.ts`, following the file's existing pattern for config-route tests (temp config path + `app.inject`):

```ts
describe('model profile apiKey masking', () => {
  it('masks openai apiKeys on GET and restores them on masked PUT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-app-'))
    const path = join(dir, 'config.json')
    const cfg = loadConfig(path)
    cfg.modelProfiles = [
      ...cfg.modelProfiles,
      { id: 'kimi', label: 'Kimi', kind: 'openai', baseUrl: 'https://api.moonshot.ai/v1', apiKey: 'sk-secret', model: 'kimi-k2' },
    ]
    saveConfig(cfg, path)
    const app = buildApp({ configPath: path })

    const got = (await app.inject({ method: 'GET', url: '/api/config' })).json()
    const kimi = got.modelProfiles.find((p: any) => p.id === 'kimi')
    expect(kimi.apiKey).toBe('***')

    // PUT the masked config back with an unrelated change — the stored key must survive
    got.diffWarnLines = 1234
    const put = await app.inject({ method: 'PUT', url: '/api/config', payload: got })
    expect(put.statusCode).toBe(200)
    const stored = loadConfig(path)
    const storedKimi = stored.modelProfiles.find((p) => p.id === 'kimi') as any
    expect(storedKimi.apiKey).toBe('sk-secret')
    expect(stored.diffWarnLines).toBe(1234)
  })
})
```

(Add any missing imports the file lacks: `mkdtempSync`/`tmpdir`/`join`, `loadConfig`/`saveConfig`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/app.test.ts`
Expected: FAIL — GET returns the raw key.

- [ ] **Step 3: Implement** — in `server/src/app.ts`, extend `GET /api/config`'s return:

```ts
    return {
      ...c,
      bitbucketToken: c.bitbucketToken ? MASK : '',
      githubToken: c.githubToken ? MASK : '',
      modelProfiles: c.modelProfiles.map((p) =>
        p.kind === 'openai' ? { ...p, apiKey: p.apiKey ? MASK : '' } : p,
      ),
    }
```

In `PUT /api/config`, after the existing token-restore lines and before `ConfigSchema.safeParse`:

```ts
      if (Array.isArray(incoming.modelProfiles)) {
        incoming.modelProfiles = incoming.modelProfiles.map((p: any) => {
          if (p?.kind !== 'openai' || p.apiKey !== MASK) return p
          const stored = current.modelProfiles.find((sp) => sp.id === p.id)
          return { ...p, apiKey: stored?.kind === 'openai' ? stored.apiKey : '' }
        })
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/test/app.test.ts
git commit -m "feat: mask openai profile apiKeys through the config API"
```

---

### Task 3: Claude adapter extraction & AgentQuery refactor

**Files:**
- Create: `server/src/models/claude.ts`, `server/src/models/resolve.ts`
- Modify: `server/src/review/runner.ts`, `server/src/review/verify.ts`, `server/src/app.ts`
- Test: `server/test/runner.test.ts`, `server/test/verify.test.ts` (call-site updates), `server/test/resolve.test.ts`

**Interfaces:**
- Consumes: `ModelProfile` (Task 1).
- Produces:
  - `AgentQuery` becomes `(prompt: string, opts: { cwd: string }) => AsyncIterable<AgentMessage>` — the `model` field is GONE from opts; adapters close over their profile.
  - `claudeQuery(profile: Extract<ModelProfile, { kind: 'claude' }>): AgentQuery` in `models/claude.ts` (today's `sdkQuery` + `buildQueryOptions`, moved).
  - `queryFor(profile: ModelProfile): AgentQuery` in `models/resolve.ts` — `claude` → `claudeQuery`; `cli`/`openai` → throws `Error('model kind not yet supported: <kind>')` (Tasks 4 and 9 replace these).
  - `runReview(input: { meta; skills; focus?; cwd; query: AgentQuery; reformatQuery: AgentQuery }, onEvent): Promise<Finding[]>` — `model`/`reformatModel` strings and the `agentQuery` param are GONE.
  - `verifyFindingsBatch(findings, ctx: { meta: PrMeta; cwd: string }, onEvent, query: AgentQuery): Promise<Verdict[]>` — `model` gone; no default query.
  - `sdkQuery` is deleted from `runner.ts`; `buildQueryOptions` moves to `claude.ts` (export kept, tests retarget).

- [ ] **Step 1: Update the tests.**

**(a)** Create `server/test/resolve.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { queryFor } from '../src/models/resolve.js'

describe('queryFor', () => {
  it('returns a function for claude profiles', () => {
    const q = queryFor({ id: 'c', label: 'C', kind: 'claude', model: 'claude-sonnet-5' })
    expect(typeof q).toBe('function')
  })
  it('throws for kinds not yet wired', () => {
    expect(() => queryFor({ id: 'k', label: 'K', kind: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'm' })).toThrow(/not yet supported/)
  })
})
```

**(b)** In `server/test/runner.test.ts`: change the `buildQueryOptions` import to `from '../src/models/claude.js'`. Update `runReview` call sites — the input loses `model`/`reformatModel` and gains `query`/`reformatQuery`; the third argument disappears. The shared fixture becomes:

```ts
const input = (query: AgentQuery, reformatQuery: AgentQuery = query) => ({
  meta, skills: [], cwd: '/tmp', query, reformatQuery,
})
```

Existing tests become e.g. `runReview(input(fakeAgent(goodJson)), (e) => events.push(e))`. The "reformat retry on reformatModel" test now proves routing by passing two DISTINCT fakes and asserting each was called:

```ts
  it('runs the reformat retry on reformatQuery, not the main query', async () => {
    const calls: string[] = []
    const main: AgentQuery = async function* () {
      calls.push('main')
      yield { type: 'result', ok: true, text: 'no json here' }
    }
    const cheap: AgentQuery = async function* () {
      calls.push('cheap')
      yield { type: 'result', ok: true, text: goodJson }
    }
    const out = await runReview({ meta, skills: [], cwd: '/tmp', query: main, reformatQuery: cheap }, () => {})
    expect(out).toHaveLength(1)
    expect(calls).toEqual(['main', 'cheap'])
  })
```

The "derives validSkills" test passes its fake as `query`/`reformatQuery` via `input(agent)`.

**(c)** In `server/test/verify.test.ts`: every `verifyFindingsBatch(findings, { meta, cwd: '/tmp', model: 'cheap' }, () => {}, agent)` becomes `verifyFindingsBatch(findings, { meta, cwd: '/tmp' }, () => {}, agent)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/resolve.test.ts test/runner.test.ts test/verify.test.ts`
Expected: FAIL — modules/signatures missing.

- [ ] **Step 3: Implement.**

Create `server/src/models/claude.ts` — move `buildQueryOptions` and the body of `sdkQuery` from `runner.ts` verbatim, wrapped as a factory (imports: `query` from `@anthropic-ai/claude-agent-sdk`, `AgentMessage`/`AgentQuery` types from `../review/runner.js`, `ModelProfile` from `./profiles.js`):

```ts
export function claudeQuery(profile: Extract<ModelProfile, { kind: 'claude' }>): AgentQuery {
  return async function* (prompt, opts) {
    const q = query({ prompt, options: buildQueryOptions(opts.cwd, profile.model) })
    // ...the existing sdkQuery for-await body, unchanged...
  }
}
```

Create `server/src/models/resolve.ts`:

```ts
import { claudeQuery } from './claude.js'
import type { ModelProfile } from './profiles.js'
import type { AgentQuery } from '../review/runner.js'

export function queryFor(profile: ModelProfile): AgentQuery {
  switch (profile.kind) {
    case 'claude':
      return claudeQuery(profile)
    default:
      throw new Error(`model kind not yet supported: ${profile.kind}`)
  }
}
```

In `server/src/review/runner.ts`: change `AgentQuery`'s opts to `{ cwd: string }`; delete `sdkQuery` and `buildQueryOptions` (and the SDK import); `runOnce(prompt, cwd, onEvent, q)` takes a cwd string + query; `runReview` becomes:

```ts
export async function runReview(
  input: {
    meta: PrMeta
    skills: { name: string; content: string }[]
    focus?: string
    cwd: string
    query: AgentQuery
    reformatQuery: AgentQuery
  },
  onEvent: (e: RunEvent) => void,
): Promise<Finding[]> {
  const validSkills = input.skills.length > 0 ? input.skills.map((s) => s.name) : ['general']
  const text = await runOnce(buildReviewPrompt(input), input.cwd, onEvent, input.query)
  try {
    return extractFindings(text, validSkills)
  } catch (err) {
    if (!(err instanceof FindingsParseError)) throw err
    onEvent({ kind: 'status', text: 'Output malformed — asking agent to reformat', at: new Date().toISOString() })
    const retryText = await runOnce(REFORMAT_PROMPT + text, input.cwd, onEvent, input.reformatQuery)
    return extractFindings(retryText, validSkills)
  }
}
```

In `server/src/review/verify.ts`: drop the `sdkQuery` import and default; `verifyFindingsBatch(findings, ctx: { meta: PrMeta; cwd: string }, onEvent, query: AgentQuery)`; `opts` for `runVerifyTurn` becomes just the cwd (adjust `runVerifyTurn(prompt, cwd: string, emit, query)`).

In `server/src/app.ts`: replace the `sdkQuery` import with `import { queryFor } from './models/resolve.js'` and `import { profileById } from './models/profiles.js'`; in `buildApp`, `const agentQuery = deps.agentQuery` (may be undefined now). In `executeRun`, before the group fan-out:

```ts
      const reviewQuery = agentQuery ?? queryFor(profileById(c, c.reviewProfile))
      const verifyQuery = agentQuery ?? queryFor(profileById(c, c.verifyProfile))
```

`runReview` call: `{ meta: ctx.meta, skills: …, focus: …, cwd, query: reviewQuery, reformatQuery: verifyQuery }` (drop the trailing `agentQuery` arg). Verify call: `verifyFindingsBatch(findings, { meta: ctx.meta, cwd }, emit, verifyQuery)`.

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npx vitest run`
Expected: PASS — all pipeline fakes ignore opts, so only the signatures above needed updating.

- [ ] **Step 5: Commit**

```bash
git add server/src/models/claude.ts server/src/models/resolve.ts server/src/review/runner.ts server/src/review/verify.ts server/src/app.ts server/test/resolve.test.ts server/test/runner.test.ts server/test/verify.test.ts
git commit -m "refactor: adapters behind AgentQuery — runner/verify take resolved queries"
```

---

### Task 4: CLI adapter

**Files:**
- Create: `server/src/models/cli.ts`
- Modify: `server/src/models/resolve.ts` (wire `cli` kind)
- Test: `server/test/cliModel.test.ts`

**Interfaces:**
- Consumes: `AgentQuery`/`AgentMessage` (Task 3 shape), `ModelProfile`.
- Produces: `cliQuery(profile: Extract<ModelProfile, { kind: 'cli' }>): AgentQuery`. Substitution: `{cwd}` → opts.cwd and `{prompt}` → prompt in each arg; when NO arg contains `{prompt}`, the prompt is written to stdin. Exit 0 → one final `{type:'result', ok:true, text: <full stdout>}` after streaming stdout chunks as `{type:'assistant', text}`; non-zero → `{type:'result', ok:false, text: 'exit <code>: <last 2000 chars of stderr>'}`; timeout (default 900000 ms) kills the process → `ok:false` mentioning timeout.

- [ ] **Step 1: Write the failing tests** — create `server/test/cliModel.test.ts` (fixtures are tiny `node -e` scripts, no real CLIs needed):

```ts
import { describe, it, expect } from 'vitest'
import { cliQuery } from '../src/models/cli.js'
import type { ModelProfile } from '../src/models/profiles.js'

type CliProfile = Extract<ModelProfile, { kind: 'cli' }>
const base: Omit<CliProfile, 'command' | 'args'> = { id: 'fake', label: 'Fake', kind: 'cli' }

async function collect(q: ReturnType<typeof cliQuery>, prompt: string, cwd: string) {
  const events: any[] = []
  for await (const msg of q(prompt, { cwd })) events.push(msg)
  return events
}

describe('cliQuery', () => {
  it('substitutes {prompt} and {cwd} into args and returns stdout as the result', async () => {
    const p: CliProfile = {
      ...base,
      command: 'node',
      args: ['-e', 'console.log(process.argv[1] + "|" + process.argv[2])', '{prompt}', '{cwd}'],
    }
    const events = await collect(cliQuery(p), 'hello', '/tmp')
    const result = events.find((e) => e.type === 'result')
    expect(result.ok).toBe(true)
    expect(result.text.trim()).toBe('hello|/tmp')
  })

  it('feeds the prompt via stdin when no arg contains {prompt}, and streams stdout as assistant events', async () => {
    const p: CliProfile = {
      ...base,
      command: 'node',
      args: ['-e', 'process.stdin.on("data", (d) => process.stdout.write("got:" + d))'],
    }
    const events = await collect(cliQuery(p), 'from-stdin', '/tmp')
    expect(events.some((e) => e.type === 'assistant' && /got:from-stdin/.test(e.text ?? ''))).toBe(true)
    const result = events.find((e) => e.type === 'result')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('got:from-stdin')
  })

  it('reports non-zero exit as a failure carrying the stderr tail', async () => {
    const p: CliProfile = { ...base, command: 'node', args: ['-e', 'console.error("kaboom"); process.exit(3)'] }
    const result = (await collect(cliQuery(p), 'x', '/tmp')).find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('exit 3')
    expect(result.text).toContain('kaboom')
  })

  it('reports a missing command as a failure, not a crash', async () => {
    const p: CliProfile = { ...base, command: '/nonexistent/agent-cli', args: [] }
    const result = (await collect(cliQuery(p), 'x', '/tmp')).find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
  })

  it('kills a hung process at timeoutMs and reports a timeout failure', async () => {
    const p: CliProfile = { ...base, command: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 300 }
    const result = (await collect(cliQuery(p), 'x', '/tmp')).find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/timed out/i)
  }, 10000)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/cliModel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `server/src/models/cli.ts`:

```ts
import { spawn } from 'node:child_process'
import type { AgentMessage, AgentQuery } from '../review/runner.js'
import type { ModelProfile } from './profiles.js'

const DEFAULT_TIMEOUT_MS = 900_000
const STDERR_TAIL = 2000

/** Adapter for agentic CLIs (Codex CLI, Gemini CLI, …). The CLI brings its own harness
 * and login; tool restrictions cannot be injected here — the profile's args must carry
 * them (e.g. codex's --sandbox read-only). */
export function cliQuery(profile: Extract<ModelProfile, { kind: 'cli' }>): AgentQuery {
  return async function* (prompt, opts): AsyncGenerator<AgentMessage> {
    const args = profile.args.map((a) => a.replaceAll('{cwd}', opts.cwd).replaceAll('{prompt}', prompt))
    const viaStdin = !profile.args.some((a) => a.includes('{prompt}'))
    const timeoutMs = profile.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const child = spawn(profile.command, args, { cwd: opts.cwd })
    let stdout = ''
    let stderr = ''
    const pending: AgentMessage[] = []
    let finished: { code: number | null; timedOut: boolean; spawnError?: string } | undefined
    let wake: (() => void) | undefined
    const notify = () => {
      wake?.()
      wake = undefined
    }

    const timer = setTimeout(() => {
      finished = { code: null, timedOut: true }
      child.kill('SIGKILL')
      notify()
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString()
      stdout += text
      pending.push({ type: 'assistant', text })
      notify()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      finished ??= { code: null, timedOut: false, spawnError: err.message }
      notify()
    })
    child.on('close', (code) => {
      finished ??= { code, timedOut: false }
      notify()
    })

    if (viaStdin) {
      child.stdin.write(prompt)
      child.stdin.end()
    } else {
      child.stdin.end()
    }

    try {
      while (true) {
        while (pending.length > 0) yield pending.shift()!
        if (finished) break
        await new Promise<void>((res) => {
          wake = res
        })
      }
      while (pending.length > 0) yield pending.shift()!
      if (finished!.timedOut) {
        yield { type: 'result', ok: false, text: `CLI timed out after ${timeoutMs}ms` }
      } else if (finished!.spawnError !== undefined) {
        yield { type: 'result', ok: false, text: `CLI failed to start: ${finished!.spawnError}` }
      } else if (finished!.code !== 0) {
        yield { type: 'result', ok: false, text: `exit ${finished!.code}: ${stderr.slice(-STDERR_TAIL)}` }
      } else {
        yield { type: 'result', ok: true, text: stdout }
      }
    } finally {
      clearTimeout(timer)
      if (!finished) child.kill('SIGKILL')
    }
  }
}
```

In `server/src/models/resolve.ts`, add `import { cliQuery } from './cli.js'` and a `case 'cli': return cliQuery(profile)` branch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/cliModel.test.ts test/resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Codex validation (collaboration point).** If the `codex-delegate` skill is available in this session, invoke it to validate the documented default Codex profile — `command: codex`, `args: ["exec", "--sandbox", "read-only", "--cd", "{cwd}", "-"]` with prompt on stdin — against real `codex exec` flag behavior, and correct the README example in Task 12 accordingly. If the skill is unavailable, note that in the commit body and proceed.

- [ ] **Step 6: Commit**

```bash
git add server/src/models/cli.ts server/src/models/resolve.ts server/test/cliModel.test.ts
git commit -m "feat: CLI adapter — spawn agentic CLIs as review sessions"
```

---

### Task 5: Per-run profile — API param, routing seam, fallback note

**Files:**
- Modify: `server/src/app.ts`, `server/src/types.ts`
- Test: `server/test/runPipeline.test.ts`

**Interfaces:**
- Consumes: `profileById`/`queryFor` (Tasks 1, 3).
- Produces:
  - `POST /api/runs` accepts `profile?: string`; unknown id → 400 naming it; absent → `config.reviewProfile`. Stored as `RunRecord.reviewProfile?: string` (add to `server/src/types.ts` after `depth`, with a legacy-runs comment).
  - `buildApp` deps gain `queryFactory?: (profile: ModelProfile) => AgentQuery`; resolution order per query: `deps.agentQuery` ?? `factory(profile)` where `factory = deps.queryFactory ?? queryFor`.
  - When a stored `reviewProfile` no longer resolves to itself, a status transcript event notes the substitution.

- [ ] **Step 1: Write the failing tests** — append to `server/test/runPipeline.test.ts` (extend `tempConfig` with an optional mutator or write profiles via `loadConfig`/`saveConfig` as in the maxConcurrentRuns test):

```ts
  it('rejects an unknown profile id with 400', async () => {
    const path = tempConfig()
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      agentQuery: fakeAgent([]),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], profile: 'ghost' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('ghost')
  })

  it('routes review and verify to their profiles via queryFactory and stores reviewProfile', async () => {
    const path = tempConfig()
    const cfgObj = loadConfig(path)
    cfgObj.modelProfiles = [
      ...cfgObj.modelProfiles,
      { id: 'codex', label: 'Codex', kind: 'cli', command: 'noop', args: [] },
    ]
    saveConfig(cfgObj, path)
    const finding = {
      file: 'a.txt', line: 1, severity: 'low', category: 'style',
      summary: 's', detail: 'd', suggestion: 'x', skill: 'general',
    }
    const used: string[] = []
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      queryFactory: (profile) =>
        async function* (prompt: string) {
          used.push(profile.id)
          if (/adversarially verifying/.test(prompt)) {
            yield { type: 'result' as const, ok: true, text: batchVerdicts(prompt) }
            return
          }
          yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
        },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], profile: 'codex' },
    })
    expect(res.statusCode).toBe(202)
    const run = await pollRun(app, res.json().id)
    expect(run.status).toBe('completed')
    expect(run.reviewProfile).toBe('codex')
    expect(used).toContain('codex') // review ran on the chosen profile
    expect(used).toContain('claude-haiku') // verify ran on the verify profile
  })

  it('falls back with a transcript note when the stored profile was deleted before the run started', async () => {
    const path = tempConfig()
    // config only has the claude defaults; simulate a stale reference by pointing reviewProfile at a ghost
    const cfgObj = loadConfig(path)
    cfgObj.reviewProfile = 'deleted-profile'
    saveConfig(cfgObj, path)
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      agentQuery: fakeAgent([]),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [] },
    })
    const run = await pollRun(app, res.json().id)
    expect(run.status).toBe('completed')
    expect(run.transcript.some((e: any) => /deleted-profile.*claude-sonnet/.test(e.text))).toBe(true)
  })
```

(`queryFactory` must be added to the `buildApp` deps type for the second test to compile.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/runPipeline.test.ts`
Expected: FAIL — `profile` ignored, `queryFactory` unknown.

- [ ] **Step 3: Implement** — `server/src/types.ts`: add to `RunRecord` after `depth`:

```ts
  /** Model profile id this run reviewed with. Absent on runs stored before profiles existed. */
  reviewProfile?: string
```

`server/src/app.ts`:

**(a)** deps type gains `queryFactory?: (profile: ModelProfile) => AgentQuery` (import `ModelProfile` type); `const queryFactory = deps.queryFactory ?? queryFor`.

**(b)** In `POST /api/runs`, extend the body type with `profile?: string`; after the depth validation:

```ts
    if (body.profile !== undefined && !c.modelProfiles.some((p) => p.id === body.profile)) {
      return reply.code(400).send({ error: `Unknown model profile: ${body.profile}` })
    }
    const reviewProfileId = body.profile ?? c.reviewProfile
```

add `reviewProfile: reviewProfileId,` to `store().create({...})`.

**(c)** In `executeRun`, replace Task 3's two-line resolution with:

```ts
      const requestedId = run.reviewProfile
      const reviewProfile = profileById(c, requestedId)
      if (requestedId !== undefined && reviewProfile.id !== requestedId) {
        emit({
          kind: 'status',
          text: `Model profile "${requestedId}" no longer exists — using "${reviewProfile.id}" instead.`,
          at: new Date().toISOString(),
        })
      }
      const reviewQuery = agentQuery ?? queryFactory(reviewProfile)
      const verifyQuery = agentQuery ?? queryFactory(profileById(c, c.verifyProfile))
```

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/types.ts server/test/runPipeline.test.ts
git commit -m "feat: per-run model profile with routing seam and deleted-profile fallback"
```

---

### Task 6: Web — profile types, run-model dropdown, run-view badge

**Files:**
- Modify: `web/src/types.ts`, `web/src/api.ts`, `web/src/lib/batch.ts`, `web/src/pages/NewReview.tsx`, `web/src/pages/RunView.tsx`
- Test: `web/test/batch.test.ts` (option pass-through)

**Interfaces:**
- Consumes: server behavior from Task 5.
- Produces: `web/src/types.ts` gains `ModelProfile` (mirror of the server union, plain TS type), `Config.modelProfiles: ModelProfile[]`, `Config.reviewProfile: string`, `Config.verifyProfile: string`, `RunRecord.reviewProfile?: string`. `createRun` input and `submitBatch` opts gain `profile?: string`.

- [ ] **Step 1: Write the failing test** — in `web/test/batch.test.ts`, extend the pass-through test's `opts` and assertion:

```ts
    await submitBatch(['u1'], { ...opts, force: true, profile: 'codex' }, fake as any)
    expect(seen[0]).toEqual({ url: 'u1', skills: ['a'], verify: true, depth: 'balanced', force: true, profile: 'codex' })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run test/batch.test.ts`
Expected: FAIL — `profile` not in the opts type / not forwarded.

- [ ] **Step 3: Implement.**

`web/src/types.ts` — add:

```ts
export type ModelProfile =
  | { id: string; label: string; kind: 'claude'; model: string }
  | { id: string; label: string; kind: 'cli'; command: string; args: string[]; timeoutMs?: number }
  | { id: string; label: string; kind: 'openai'; baseUrl: string; apiKey: string; model: string }
```

to `Config`: `modelProfiles: ModelProfile[]`, `reviewProfile: string`, `verifyProfile: string`. To `RunRecord` after `depth`: `reviewProfile?: string`.

`web/src/api.ts` — `createRun` input gains `profile?: string`. `web/src/lib/batch.ts` — opts gain `profile?: string` (spread already forwards it).

`web/src/pages/NewReview.tsx` — mirror the depth-selector pattern: `const PROFILE_KEY = 'pr-reviewer.profile'`; state `profile: string | null` seeded from localStorage; the existing config-default effect extends to also seed the profile (`setProfile((cur) => cur ?? c.reviewProfile)`) and to store the loaded `c.modelProfiles` in a `profiles` state for the dropdown; `pickProfile` persists. Submit opts gain `profile: profile ?? undefined`. Render below the depth selector:

```tsx
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Review model</h2>
        <div className="flex flex-wrap gap-2">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pickProfile(p.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                profile === p.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted-200 text-muted-foreground hover:border-primary hover:text-primary',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
```

`web/src/pages/RunView.tsx` — next to the depth badge:

```tsx
          {run.reviewProfile && (
            <Badge variant="muted" size="xs">
              {run.reviewProfile}
            </Badge>
          )}
```

and both `retry()`/`retryFailedSkills()` add `profile: run.reviewProfile,` to their `createRun` calls.

- [ ] **Step 4: Typecheck, test, build**

Run: `cd web && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/src/lib/batch.ts web/src/pages/NewReview.tsx web/src/pages/RunView.tsx web/test/batch.test.ts
git commit -m "feat: per-run model selection in the web UI"
```

---

### Task 7: Settings — model profiles management

**Files:**
- Modify: `web/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: `Config.modelProfiles`/`reviewProfile`/`verifyProfile` (Task 6 types), masked-key semantics (Task 2: `***` round-trips safely).

- [ ] **Step 1: Implement** (no component-test rig; typecheck + build + smoke). Replace the "Review engine" card's Model `<select>` block (the `MODELS` constant and the `isKnown` IIFE) with a `ModelProfilesEditor` component rendered in that card above the diff-warn field; delete the `MODELS` constant. The editor (new component in the same file, following `SkillSources`' local-component pattern):

```tsx
const SELECT_CLS =
  'border-muted-200 bg-background hover:not-disabled:border-primary hover:not-disabled:ring-primary hover:not-disabled:ring focus-visible:ring-primary focus-visible:border-primary focus-visible:ring w-full rounded-md border p-3 text-sm shadow-xs outline-none'

const EMPTY_DRAFTS = {
  claude: { id: '', label: '', model: '' },
  cli: { id: '', label: '', command: '' },
  openai: { id: '', label: '', baseUrl: '', apiKey: '', model: '' },
}

function ModelProfilesEditor({ cfg, set }: { cfg: Config; set: (patch: Partial<Config>) => void }) {
  const [kind, setKind] = useState<'claude' | 'cli' | 'openai'>('claude')
  const [draft, setDraft] = useState<Record<string, string>>(EMPTY_DRAFTS.claude)
  const [rowError, setRowError] = useState('')

  const referenced = (id: string) => id === cfg.reviewProfile || id === cfg.verifyProfile

  const remove = (id: string) => {
    if (referenced(id)) {
      setRowError(`"${id}" is the default review or verify model — pick another default first.`)
      return
    }
    setRowError('')
    set({ modelProfiles: cfg.modelProfiles.filter((p) => p.id !== id) })
  }

  const add = () => {
    const id = draft.id.trim()
    if (!id || cfg.modelProfiles.some((p) => p.id === id)) {
      setRowError(id ? `A profile named "${id}" already exists.` : 'Profile id is required.')
      return
    }
    setRowError('')
    const label = draft.label.trim() || id
    const profile: ModelProfile =
      kind === 'claude'
        ? { id, label, kind, model: draft.model.trim() }
        : kind === 'cli'
          ? { id, label, kind, command: draft.command.trim().split(/\s+/)[0], args: draft.command.trim().split(/\s+/).slice(1) }
          : { id, label, kind, baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey, model: draft.model.trim() }
    set({ modelProfiles: [...cfg.modelProfiles, profile] })
    setDraft({ ...EMPTY_DRAFTS[kind] })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {cfg.modelProfiles.map((p) => (
          <div key={p.id} className="border-muted-200 flex items-center gap-2 rounded-md border px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-medium">{p.label}</span>{' '}
              <span className="text-muted-foreground font-family-mono text-xs">
                {p.id} · {p.kind}
                {p.kind === 'claude' ? ` · ${p.model}` : p.kind === 'openai' ? ` · ${p.model}` : ` · ${p.command}`}
              </span>
            </span>
            <Button
              type="button"
              variant="ghost-destructive"
              size="icon-sm"
              aria-label={`Remove profile ${p.id}`}
              onClick={() => remove(p.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {rowError && <p className="text-destructive text-xs">{rowError}</p>}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex flex-col gap-2 sm:w-44 sm:shrink-0">
          <Label htmlFor="review-profile">Default review model</Label>
          <select
            id="review-profile"
            value={cfg.reviewProfile}
            onChange={(e) => set({ reviewProfile: e.target.value })}
            className={SELECT_CLS}
          >
            {cfg.modelProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2 sm:w-44 sm:shrink-0">
          <Label htmlFor="verify-profile">Verify model</Label>
          <select
            id="verify-profile"
            value={cfg.verifyProfile}
            onChange={(e) => set({ verifyProfile: e.target.value })}
            className={SELECT_CLS}
          >
            {cfg.modelProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="border-muted-200 flex flex-col gap-2 border-t pt-4">
        <Label>Add profile</Label>
        <div className="flex gap-2">
          {(['claude', 'cli', 'openai'] as const).map((k) => (
            <Button
              key={k}
              type="button"
              size="sm"
              variant={kind === k ? 'default' : 'outline-muted'}
              onClick={() => {
                setKind(k)
                setDraft({ ...EMPTY_DRAFTS[k] })
              }}
            >
              {k}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input placeholder="id (slug)" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
          <Input placeholder="label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        </div>
        {kind === 'claude' && (
          <Input placeholder="model id, e.g. claude-sonnet-5" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
        )}
        {kind === 'cli' && (
          <>
            <Input
              placeholder='command line, e.g. codex exec --sandbox read-only --cd {cwd} -'
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              {'{cwd}'} is replaced with the checkout path; {'{prompt}'} with the prompt (omitted → prompt on stdin). Include the CLI's own read-only/sandbox flags — the tool cannot inject them.
            </p>
          </>
        )}
        {kind === 'openai' && (
          <div className="flex flex-col gap-2">
            <Input placeholder="base URL, e.g. https://api.moonshot.ai/v1" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
            <Input type="password" placeholder="API key" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
            <Input placeholder="model, e.g. kimi-k2" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          </div>
        )}
        <Button type="button" variant="outline-muted" className="w-fit" onClick={add}>
          Add profile
        </Button>
      </div>
    </div>
  )
}
```

Add `ModelProfile` to the types import. Rename the card title from "Review engine" to "Review models"; keep the diff-warn field below the editor.

- [ ] **Step 2: Typecheck, test, build**

Run: `cd web && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all pass.

- [ ] **Step 3: Manual smoke** — `npm start`: Settings shows the two default profiles, adding a cli profile works, deleting a referenced profile is blocked with the message, saving round-trips, and an openai key shows `***` after reload.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Settings.tsx
git commit -m "feat: model profile management in Settings"
```

---

## Phase 2 — openai adapter

### Task 8: Local tool executors

**Files:**
- Create: `server/src/models/tools.ts`
- Test: `server/test/modelTools.test.ts`

**Interfaces:**
- Produces: `runTool(cwd: string, name: string, args: Record<string, unknown>): { ok: boolean; content: string }` plus `TOOL_DEFS` (the OpenAI function-tool JSON schemas for `read_file`, `grep`, `list_files`). Task 9 calls both. `runTool` NEVER throws — failures return `{ ok: false, content: <message> }` so the model can recover.

- [ ] **Step 1: Write the failing tests** — create `server/test/modelTools.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_DEFS, runTool } from '../src/models/tools.js'

let cwd: string

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'prr-tools-'))
  execFileSync('git', ['init', '-q'], { cwd })
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'a.ts'), 'const needle = 1\nconst hay = 2\n')
  writeFileSync(join(cwd, 'b.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n'))
  execFileSync('git', ['add', '.'], { cwd })
})

describe('TOOL_DEFS', () => {
  it('declares the three tools as OpenAI function tools', () => {
    expect(TOOL_DEFS.map((t: any) => t.function.name).sort()).toEqual(['grep', 'list_files', 'read_file'])
    expect(TOOL_DEFS.every((t: any) => t.type === 'function')).toBe(true)
  })
})

describe('runTool', () => {
  it('read_file returns numbered content and honors offset/limit', () => {
    const r = runTool(cwd, 'read_file', { path: 'src/a.ts' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('needle')
    const window = runTool(cwd, 'read_file', { path: 'b.txt', offset: 100, limit: 2 })
    expect(window.content).toContain('line 100')
    expect(window.content).not.toContain('line 102')
  })

  it('read_file caps output at 2000 lines', () => {
    const r = runTool(cwd, 'read_file', { path: 'b.txt' })
    expect(r.ok).toBe(true)
    expect(r.content).not.toContain('line 2500')
  })

  it('rejects a path escaping the worktree without throwing', () => {
    const r = runTool(cwd, 'read_file', { path: '../../etc/passwd' })
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/outside/i)
  })

  it('grep finds matches and reports no-match cleanly', () => {
    expect(runTool(cwd, 'grep', { pattern: 'needle' }).content).toContain('src/a.ts')
    const none = runTool(cwd, 'grep', { pattern: 'zzz-not-here' })
    expect(none.ok).toBe(true)
    expect(none.content).toMatch(/no matches/i)
  })

  it('list_files lists tracked files, optionally filtered by glob', () => {
    expect(runTool(cwd, 'list_files', {}).content).toContain('src/a.ts')
    expect(runTool(cwd, 'list_files', { glob: '*.txt' }).content).toContain('b.txt')
  })

  it('unknown tool name returns an error result', () => {
    expect(runTool(cwd, 'rm_rf', {}).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/modelTools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `server/src/models/tools.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_LINES = 2000
const MAX_BYTES = 50_000

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the repository. Returns line-numbered content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the repo root' },
          offset: { type: 'number', description: '0-based line to start from' },
          limit: { type: 'number', description: 'Max lines to return' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with git grep. Returns file:line:match lines.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern' },
          glob: { type: 'string', description: 'Optional pathspec, e.g. src/**/*.ts' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List tracked files, optionally filtered by a glob pathspec.',
      parameters: {
        type: 'object',
        properties: { glob: { type: 'string', description: 'Optional pathspec, e.g. *.ts' } },
      },
    },
  },
] as const

function confined(cwd: string, path: string): string | undefined {
  const abs = resolve(cwd, path)
  const rel = relative(resolve(cwd), abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return abs
}

/** Executes one model-requested tool locally, confined to the worktree. Never throws —
 * every failure is an { ok: false } result the model can read and recover from. */
export function runTool(cwd: string, name: string, args: Record<string, unknown>): { ok: boolean; content: string } {
  try {
    if (name === 'read_file') {
      const abs = confined(cwd, String(args.path ?? ''))
      if (!abs) return { ok: false, content: `Path is outside the repository: ${String(args.path)}` }
      if (statSync(abs).size > 5_000_000) return { ok: false, content: 'File too large to read' }
      const lines = readFileSync(abs, 'utf8').split('\n')
      const offset = typeof args.offset === 'number' ? Math.max(0, args.offset) : 0
      const limit = Math.min(typeof args.limit === 'number' ? args.limit : MAX_LINES, MAX_LINES)
      const slice = lines.slice(offset, offset + limit).map((l, i) => `${offset + i}: ${l}`)
      let content = slice.join('\n')
      if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES) + '\n…(truncated)'
      return { ok: true, content }
    }
    if (name === 'grep') {
      const pattern = String(args.pattern ?? '')
      const spec = typeof args.glob === 'string' && args.glob !== '' ? ['--', args.glob] : []
      try {
        const out = execFileSync('git', ['grep', '-n', '-e', pattern, ...spec], { cwd, encoding: 'utf8' })
        return { ok: true, content: out.slice(0, MAX_BYTES) }
      } catch (err: any) {
        if (err.status === 1) return { ok: true, content: '(no matches)' }
        throw err
      }
    }
    if (name === 'list_files') {
      const spec = typeof args.glob === 'string' && args.glob !== '' ? ['--', args.glob] : []
      const out = execFileSync('git', ['ls-files', ...spec], { cwd, encoding: 'utf8' })
      return { ok: true, content: out.slice(0, MAX_BYTES) }
    }
    return { ok: false, content: `Unknown tool: ${name}` }
  } catch (err: any) {
    return { ok: false, content: `Tool failed: ${err.message}` }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/modelTools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/models/tools.ts server/test/modelTools.test.ts
git commit -m "feat: worktree-confined local tool executors for API models"
```

---

### Task 9: openai chat-loop adapter

**Files:**
- Create: `server/src/models/openai.ts`
- Modify: `server/src/models/resolve.ts` (wire `openai` kind)
- Test: `server/test/openaiModel.test.ts`

**Interfaces:**
- Consumes: `TOOL_DEFS`/`runTool` (Task 8), `AgentQuery` (Task 3).
- Produces: `openaiQuery(profile: Extract<ModelProfile, { kind: 'openai' }>, fetchFn?: typeof fetch): AgentQuery` — chat-completions loop against `<baseUrl>/chat/completions`; executes tool calls locally, streams them as `{type:'assistant', tool}` events; ends when the model returns no tool calls or at 40 iterations (last text = result); HTTP errors → `ok:false` with status + body snippet, never the key.

- [ ] **Step 1: Write the failing tests** — create `server/test/openaiModel.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openaiQuery } from '../src/models/openai.js'
import type { ModelProfile } from '../src/models/profiles.js'

const profile: Extract<ModelProfile, { kind: 'openai' }> = {
  id: 'kimi', label: 'Kimi', kind: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'kimi-k2',
}

let cwd: string
beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'prr-oai-'))
  execFileSync('git', ['init', '-q'], { cwd })
  writeFileSync(join(cwd, 'a.ts'), 'const secretBug = 1\n')
  execFileSync('git', ['add', '.'], { cwd })
})

const msg = (content: string | null, tool_calls?: any[]) => ({
  choices: [{ message: { role: 'assistant', content, tool_calls } }],
})

function fakeFetch(responses: any[]) {
  const calls: { url: string; body: any; headers: any }[] = []
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
    const next = responses.shift()
    if (next.status) return new Response(JSON.stringify(next.body ?? {}), { status: next.status })
    return new Response(JSON.stringify(next), { status: 200 })
  }) as typeof fetch
  return { fn, calls }
}

async function collect(q: ReturnType<typeof openaiQuery>, prompt: string, dir: string) {
  const events: any[] = []
  for await (const m of q(prompt, { cwd: dir })) events.push(m)
  return events
}

describe('openaiQuery', () => {
  it('executes a tool call locally, feeds the result back, and returns the final text', async () => {
    const { fn, calls } = fakeFetch([
      msg(null, [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]),
      msg('```json\n[]\n```'),
    ])
    const events = await collect(openaiQuery(profile, fn), 'review it', cwd)
    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions')
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test')
    // second request carries the tool result with the real file content
    const toolMsg = calls[1].body.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('secretBug')
    expect(events.some((e) => e.type === 'assistant' && /read_file/.test(e.tool ?? ''))).toBe(true)
    const result = events.find((e) => e.type === 'result')
    expect(result.ok).toBe(true)
    expect(result.text).toBe('```json\n[]\n```')
  })

  it('maps HTTP errors to a failed result without echoing the key', async () => {
    const { fn } = fakeFetch([{ status: 401, body: { error: 'bad key' } }])
    const result = (await collect(openaiQuery(profile, fn), 'x', cwd)).find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('401')
    expect(result.text).not.toContain('sk-test')
  })

  it('stops at the iteration ceiling and uses the last assistant text', async () => {
    const loop = Array.from({ length: 45 }, () =>
      msg('thinking', [{ id: 't', type: 'function', function: { name: 'list_files', arguments: '{}' } }]),
    )
    const { fn, calls } = fakeFetch(loop)
    const result = (await collect(openaiQuery(profile, fn), 'x', cwd)).find((e) => e.type === 'result')
    expect(calls.length).toBe(40)
    expect(result.ok).toBe(true)
    expect(result.text).toBe('thinking')
  })

  it('answers an out-of-worktree path with a tool error and lets the loop continue', async () => {
    const { fn, calls } = fakeFetch([
      msg(null, [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"../outside"}' } }]),
      msg('done'),
    ])
    const result = (await collect(openaiQuery(profile, fn), 'x', cwd)).find((e) => e.type === 'result')
    const toolMsg = calls[1].body.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toMatch(/outside/i)
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/openaiModel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `server/src/models/openai.ts`:

```ts
import type { AgentMessage, AgentQuery } from '../review/runner.js'
import type { ModelProfile } from './profiles.js'
import { TOOL_DEFS, runTool } from './tools.js'

const MAX_ITERATIONS = 40

/** OpenAI-compatible chat-completions loop (Kimi/Moonshot, OpenAI, DeepSeek…). WE execute
 * the tool calls locally, confined to the worktree — API-only models get the same agentic
 * repo access the SDK/CLI adapters have. */
export function openaiQuery(
  profile: Extract<ModelProfile, { kind: 'openai' }>,
  fetchFn: typeof fetch = fetch,
): AgentQuery {
  return async function* (prompt, opts): AsyncGenerator<AgentMessage> {
    const messages: any[] = [{ role: 'user', content: prompt }]
    let lastText = ''
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let res: Response
      try {
        res = await fetchFn(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
          body: JSON.stringify({ model: profile.model, messages, tools: TOOL_DEFS }),
        })
      } catch (err: any) {
        yield { type: 'result', ok: false, text: `API request failed: ${err.message}` }
        return
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300)
        yield { type: 'result', ok: false, text: `API error ${res.status}: ${body}` }
        return
      }
      const data: any = await res.json()
      const message = data.choices?.[0]?.message
      if (!message) {
        yield { type: 'result', ok: false, text: 'API returned no message' }
        return
      }
      messages.push(message)
      if (typeof message.content === 'string' && message.content !== '') {
        lastText = message.content
        yield { type: 'assistant', text: message.content }
      }
      const toolCalls: any[] = message.tool_calls ?? []
      if (toolCalls.length === 0) {
        yield { type: 'result', ok: true, text: lastText }
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
    yield { type: 'result', ok: true, text: lastText }
  }
}
```

In `server/src/models/resolve.ts`: add `import { openaiQuery } from './openai.js'` and `case 'openai': return openaiQuery(profile)`; delete the `default` throw (the switch is now exhaustive — keep a `default` returning `claudeQuery`-style never-check if TS demands one: `const _exhaustive: never = profile; throw new Error('unreachable')`).

Update `server/test/resolve.test.ts`: the "throws for kinds not yet wired" test becomes "returns a function for every kind":

```ts
  it('returns a function for cli and openai profiles', () => {
    expect(typeof queryFor({ id: 'c', label: 'C', kind: 'cli', command: 'x', args: [] })).toBe('function')
    expect(typeof queryFor({ id: 'k', label: 'K', kind: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'm' })).toBe('function')
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/openaiModel.test.ts test/resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Codex review (collaboration point).** If the `codex-delegate` skill is available, invoke it to review `server/src/models/openai.ts` against the OpenAI function-calling contract (message shapes, `tool_call_id` threading, arguments parsing, finish reasons) and apply any corrections it surfaces (re-running the tests). If unavailable, note that in the commit body and proceed.

- [ ] **Step 6: Commit**

```bash
git add server/src/models/openai.ts server/src/models/resolve.ts server/test/openaiModel.test.ts server/test/resolve.test.ts
git commit -m "feat: OpenAI-compatible chat-loop adapter with local tool execution"
```

---

## Phase 3 — auto-submit

### Task 10: Extract the comment-posting helper

**Files:**
- Create: `server/src/review/post.ts`
- Modify: `server/src/app.ts` (the `/api/runs/:id/comments` route and `readExistingFingerprints` move)
- Test: `server/test/post.test.ts`

**Interfaces:**
- Produces (Task 11 consumes):

```ts
postFindingComments(
  client: PrProviderClient,
  run: RunRecord,
  findingIndexes: number[],
  save: (run: RunRecord) => void,
  opts?: { requireDedupe?: boolean },
): Promise<{
  posted: number[]
  skipped: { index: number; reason: 'already-posted' | 'resolved' }[]
  failed: { index: number; error: string }[]
  dedupeChecked: boolean
}>
```

  Behavior is the current route loop verbatim (fingerprint read → skip → `formatComment` + marker → post → `run.postedCommentIds.push` + `save` → same-batch fingerprint recording → stop on first failure), plus: when `opts.requireDedupe` is true and the comment read failed, return immediately with nothing posted (`dedupeChecked: false`). `readExistingFingerprints` moves into `post.ts` (exported — the post-preview route still uses it; update its import in `app.ts`).

- [ ] **Step 1: Write the failing tests** — create `server/test/post.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { postFindingComments } from '../src/review/post.js'
import { commentMarker, fingerprint } from '../src/review/fingerprint.js'
import type { Finding, PrProviderClient, RunRecord } from '../src/types.js'

const pr = { provider: 'bitbucket' as const, workspace: 'ws', repo: 'r', id: 1 }

const mkFinding = (n: number): Finding => ({
  file: `f${n}.ts`, line: n + 1, severity: 'high', category: 'bug', summary: `finding ${n}`,
  detail: 'd', suggestion: 'x', skills: ['s'], verdict: 'confirmed',
})

function mkRun(findings: Finding[]): RunRecord {
  return {
    id: 'r1', pr, prTitle: 'T', skills: [], verify: true, status: 'completed',
    createdAt: 'now', findings, transcript: [], postedCommentIds: [], skillResults: [],
  } as RunRecord
}

function mkClient(overrides: Partial<PrProviderClient> = {}): { client: PrProviderClient; posted: any[] } {
  const posted: any[] = []
  const client: PrProviderClient = {
    getPullRequest: async () => ({ title: 'T', description: '', sourceBranch: 'f', destinationBranch: 'm', sourceCommit: '' }),
    getDiff: async () => '',
    postInlineComment: async (_pr, c) => {
      posted.push(c)
      return posted.length
    },
    listComments: async () => [],
    cloneUrl: () => '',
    ...overrides,
  }
  return { client, posted }
}

describe('postFindingComments', () => {
  it('posts new findings with the fingerprint marker and records ids', async () => {
    const run = mkRun([mkFinding(0), mkFinding(1)])
    const { client, posted } = mkClient()
    const saves: number[] = []
    const res = await postFindingComments(client, run, [0, 1], () => saves.push(1))
    expect(res.posted).toEqual([1, 2])
    expect(posted[0].text).toContain(commentMarker(fingerprint(pr, run.findings[0])))
    expect(run.postedCommentIds).toEqual([1, 2])
    expect(saves.length).toBe(2)
  })

  it('skips already-posted and resolved findings based on existing comments', async () => {
    const run = mkRun([mkFinding(0), mkFinding(1)])
    const { client, posted } = mkClient({
      listComments: async () => [
        { body: `x ${commentMarker(fingerprint(pr, run.findings[0]))}`, resolved: false },
        { body: `x ${commentMarker(fingerprint(pr, run.findings[1]))}`, resolved: true },
      ],
    })
    const res = await postFindingComments(client, run, [0, 1], () => {})
    expect(posted).toHaveLength(0)
    expect(res.skipped).toEqual([
      { index: 0, reason: 'already-posted' },
      { index: 1, reason: 'resolved' },
    ])
  })

  it('stops at the first posting failure and reports it', async () => {
    const run = mkRun([mkFinding(0), mkFinding(1)])
    const { client } = mkClient({
      postInlineComment: async () => {
        throw new Error('bitbucket down')
      },
    })
    const res = await postFindingComments(client, run, [0, 1], () => {})
    expect(res.posted).toEqual([])
    expect(res.failed).toEqual([{ index: 0, error: 'bitbucket down' }])
  })

  it('with requireDedupe, posts nothing when the comment read fails', async () => {
    const run = mkRun([mkFinding(0)])
    const { client, posted } = mkClient({
      listComments: async () => {
        throw new Error('read failed')
      },
    })
    const res = await postFindingComments(client, run, [0], () => {}, { requireDedupe: true })
    expect(res.dedupeChecked).toBe(false)
    expect(posted).toHaveLength(0)
    expect(res.posted).toEqual([])
  })

  it('without requireDedupe, a failed comment read still posts (manual-dialog behavior)', async () => {
    const run = mkRun([mkFinding(0)])
    const { client, posted } = mkClient({
      listComments: async () => {
        throw new Error('read failed')
      },
    })
    const res = await postFindingComments(client, run, [0], () => {})
    expect(res.dedupeChecked).toBe(false)
    expect(posted).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/post.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `server/src/review/post.ts` by MOVING `readExistingFingerprints` and the route's posting loop from `app.ts` (imports: `formatComment` from `./comment.js`, `commentMarker`/`fingerprint`/`parseFingerprint` from `./fingerprint.js`, types from `../types.js`):

```ts
/** Reads existing PR comments and returns fp→resolved plus whether the read succeeded. */
export async function readExistingFingerprints(
  client: PrProviderClient,
  pr: PrRef,
): Promise<{ fps: Map<string, boolean>; dedupeChecked: boolean }> {
  // ...moved verbatim from app.ts...
}

/** The comment-posting loop shared by the manual route and auto-submit. Idempotent via
 * fingerprints; stops at the first failure. With requireDedupe (auto-submit), a failed
 * comment read posts NOTHING — no human is watching the "couldn't verify" warning. */
export async function postFindingComments(
  client: PrProviderClient,
  run: RunRecord,
  findingIndexes: number[],
  save: (run: RunRecord) => void,
  opts: { requireDedupe?: boolean } = {},
): Promise<{
  posted: number[]
  skipped: { index: number; reason: 'already-posted' | 'resolved' }[]
  failed: { index: number; error: string }[]
  dedupeChecked: boolean
}> {
  const { fps, dedupeChecked } = await readExistingFingerprints(client, run.pr)
  const posted: number[] = []
  const skipped: { index: number; reason: 'already-posted' | 'resolved' }[] = []
  const failed: { index: number; error: string }[] = []
  if (opts.requireDedupe && !dedupeChecked) return { posted, skipped, failed, dedupeChecked }
  for (const i of findingIndexes) {
    const f = run.findings[i]
    if (!f) continue
    const fp = fingerprint(run.pr, f)
    if (fps.has(fp)) {
      skipped.push({ index: i, reason: fps.get(fp) ? 'resolved' : 'already-posted' })
      continue
    }
    const text = `${formatComment(f)}\n\n${commentMarker(fp)}`
    try {
      const commentId = await client.postInlineComment(run.pr, { path: f.file, line: f.line, text })
      posted.push(commentId)
      run.postedCommentIds.push(commentId)
      save(run)
      fps.set(fp, false)
    } catch (err: any) {
      failed.push({ index: i, error: err.message })
      break
    }
  }
  return { posted, skipped, failed, dedupeChecked }
}
```

In `app.ts`: the comments route body becomes

```ts
    const client = clientFactory(run.pr, cfg())
    const result = await postFindingComments(client, run, findingIndexes, (r) => s.save(r))
    return result
```

Update imports (`postFindingComments`, `readExistingFingerprints` from `./review/post.js`; drop the now-unused `formatComment` and `commentMarker` imports from `app.ts` if nothing else uses them — `parseFingerprint` moves with `readExistingFingerprints`; the post-preview route keeps using `readExistingFingerprints` + `fingerprint`).

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npx vitest run`
Expected: PASS — the existing comments-route tests in `app.test.ts` verify the move preserved behavior.

- [ ] **Step 5: Commit**

```bash
git add server/src/review/post.ts server/src/app.ts server/test/post.test.ts
git commit -m "refactor: extract shared comment-posting loop with requireDedupe option"
```

---

### Task 11: Auto-submit orchestration

**Files:**
- Modify: `server/src/app.ts`, `server/src/types.ts`, `server/src/review/post.ts` (add the pure filter)
- Test: `server/test/post.test.ts` (filter), `server/test/runPipeline.test.ts` (end-to-end)

**Interfaces:**
- Produces:
  - `type AutoSubmit = { threshold: 'high' | 'medium' | 'all'; confirmedOnly: boolean }` in `server/src/types.ts`; `RunRecord.autoSubmit?: AutoSubmit` and `RunRecord.autoSubmitResult?: { posted: number; skipped: number; failed: number; dedupeChecked: boolean }`.
  - `autoSubmitIndexes(findings: Finding[], opts: AutoSubmit): number[]` in `review/post.ts` (pure).
  - `POST /api/runs` accepts `autoSubmit?: AutoSubmit` (validated: threshold in the enum, confirmedOnly boolean; else 400).

- [ ] **Step 1: Write the failing tests.** Append to `server/test/post.test.ts`:

```ts
describe('autoSubmitIndexes', () => {
  const f = (severity: Finding['severity'], verdict: Finding['verdict']): Finding => ({
    ...mkFinding(0), severity, verdict,
  })
  const findings = [
    f('high', 'confirmed'),    // 0
    f('medium', 'confirmed'),  // 1
    f('low', 'confirmed'),     // 2
    f('high', 'unverified'),   // 3
    f('info', 'unverified'),   // 4
  ]
  it('threshold high + confirmedOnly → only confirmed highs', () => {
    expect(autoSubmitIndexes(findings, { threshold: 'high', confirmedOnly: true })).toEqual([0])
  })
  it('threshold medium + confirmedOnly → confirmed high and medium', () => {
    expect(autoSubmitIndexes(findings, { threshold: 'medium', confirmedOnly: true })).toEqual([0, 1])
  })
  it('threshold all without confirmedOnly → everything', () => {
    expect(autoSubmitIndexes(findings, { threshold: 'all', confirmedOnly: false })).toEqual([0, 1, 2, 3, 4])
  })
  it('confirmedOnly filters unverified even at threshold all', () => {
    expect(autoSubmitIndexes(findings, { threshold: 'all', confirmedOnly: true })).toEqual([0, 1, 2])
  })
})
```

Append to `server/test/runPipeline.test.ts`:

```ts
  it('auto-submit posts the filtered findings on completion and records the result', async () => {
    const path = tempConfigWithSkills(['skill-a'])
    const high = { file: 'a.txt', line: 1, severity: 'high', category: 'bug', summary: 'bad', detail: 'd', suggestion: 'x', skill: 'skill-a' }
    const low = { file: 'a.txt', line: 2, severity: 'low', category: 'style', summary: 'meh', detail: 'd', suggestion: 'x', skill: 'skill-a' }
    const postedTexts: string[] = []
    const client = {
      ...fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      postInlineComment: async (_pr: any, c: any) => {
        postedTexts.push(c.text)
        return postedTexts.length
      },
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => client,
      agentQuery: fakeAgentPerSkill({ 'skill-a': [high, low] }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        url: 'https://bitbucket.org/ws/repo/pull-requests/1',
        skills: ['skill-a'],
        autoSubmit: { threshold: 'medium', confirmedOnly: true },
      },
    })
    expect(res.statusCode).toBe(202)
    const run = await pollRun(app, res.json().id)
    expect(run.status).toBe('completed')
    expect(postedTexts).toHaveLength(1) // only the high finding passes threshold 'medium'
    expect(postedTexts[0]).toContain('bad')
    expect(run.autoSubmitResult).toEqual({ posted: 1, skipped: 0, failed: 0, dedupeChecked: true })
    expect(run.postedCommentIds).toEqual([1])
    expect(run.transcript.some((e: any) => /auto-posted 1 comment/i.test(e.text))).toBe(true)
  })

  it('auto-submit posts nothing when the existing-comment read fails (fail-closed)', async () => {
    const path = tempConfigWithSkills(['skill-a'])
    const high = { file: 'a.txt', line: 1, severity: 'high', category: 'bug', summary: 'bad', detail: 'd', suggestion: 'x', skill: 'skill-a' }
    const postedTexts: string[] = []
    const client = {
      ...fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      listComments: async () => {
        throw new Error('read failed')
      },
      postInlineComment: async () => {
        postedTexts.push('x')
        return 1
      },
    }
    const app = buildApp({ configPath: path, clientFactory: () => client, agentQuery: fakeAgentPerSkill({ 'skill-a': [high] }) })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        url: 'https://bitbucket.org/ws/repo/pull-requests/1',
        skills: ['skill-a'],
        autoSubmit: { threshold: 'all', confirmedOnly: false },
      },
    })
    const run = await pollRun(app, res.json().id)
    expect(run.status).toBe('completed')
    expect(postedTexts).toHaveLength(0)
    expect(run.autoSubmitResult?.dedupeChecked).toBe(false)
  })

  it('rejects a malformed autoSubmit with 400 and never auto-posts on failed runs', async () => {
    const path = tempConfigWithSkills(['skill-a'])
    const postedTexts: string[] = []
    const client = {
      ...fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      postInlineComment: async () => {
        postedTexts.push('x')
        return 1
      },
    }
    const app = buildApp({ configPath: path, clientFactory: () => client, agentQuery: fakeAgentPerSkill({ 'skill-a': 'fail' }) })
    const bad = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], autoSubmit: { threshold: 'urgent', confirmedOnly: true } },
    })
    expect(bad.statusCode).toBe(400)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        url: 'https://bitbucket.org/ws/repo/pull-requests/1',
        skills: ['skill-a'],
        autoSubmit: { threshold: 'all', confirmedOnly: false },
      },
    })
    const run = await pollRun(app, res.json().id)
    expect(run.status).toBe('failed')
    expect(postedTexts).toHaveLength(0)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/post.test.ts test/runPipeline.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

`server/src/types.ts`:

```ts
export interface AutoSubmit {
  threshold: 'high' | 'medium' | 'all'
  confirmedOnly: boolean
}
```

`RunRecord` gains (after `reviewProfile`):

```ts
  /** Auto-post options for this run; absent = off. */
  autoSubmit?: AutoSubmit
  /** Outcome of the auto-post step, set only when autoSubmit ran. */
  autoSubmitResult?: { posted: number; skipped: number; failed: number; dedupeChecked: boolean }
```

`server/src/review/post.ts`:

```ts
const THRESHOLD_SETS: Record<AutoSubmit['threshold'], Set<string>> = {
  high: new Set(['high']),
  medium: new Set(['high', 'medium']),
  all: new Set(['high', 'medium', 'low', 'info']),
}

/** Indexes of findings eligible for auto-posting under the run's auto-submit options. */
export function autoSubmitIndexes(findings: Finding[], opts: AutoSubmit): number[] {
  return findings
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => THRESHOLD_SETS[opts.threshold].has(f.severity))
    .filter(({ f }) => !opts.confirmedOnly || f.verdict === 'confirmed')
    .map(({ i }) => i)
}
```

`server/src/app.ts`:

**(a)** `POST /api/runs` body gains `autoSubmit?: AutoSubmit`; validation after the profile check:

```ts
    if (body.autoSubmit !== undefined) {
      const ok =
        ['high', 'medium', 'all'].includes(body.autoSubmit?.threshold as string) &&
        typeof body.autoSubmit?.confirmedOnly === 'boolean'
      if (!ok) return reply.code(400).send({ error: 'Invalid autoSubmit options' })
    }
```

and `autoSubmit: body.autoSubmit,` added to `store().create({...})`.

**(b)** In `executeRun`, after `run.status = 'completed'` is assigned (inside the else branch — never on the failed path):

```ts
        if (run.autoSubmit && run.findings.length > 0) {
          const indexes = autoSubmitIndexes(run.findings, run.autoSubmit)
          if (indexes.length > 0) {
            emit({ kind: 'status', text: `Auto-posting ${indexes.length} findings…`, at: new Date().toISOString() })
            try {
              const result = await postFindingComments(client, run, indexes, (r) => s!.save(r), { requireDedupe: true })
              run.autoSubmitResult = {
                posted: result.posted.length,
                skipped: result.skipped.length,
                failed: result.failed.length,
                dedupeChecked: result.dedupeChecked,
              }
              const text = !result.dedupeChecked
                ? 'Auto-post skipped: could not check existing comments — findings left for manual review.'
                : `Auto-posted ${result.posted.length} comment${result.posted.length === 1 ? '' : 's'}.` +
                  (result.skipped.length > 0 ? ` Skipped ${result.skipped.length}.` : '') +
                  (result.failed.length > 0 ? ` Failed ${result.failed.length}.` : '')
              emit({ kind: 'status', text, at: new Date().toISOString() })
            } catch (err: any) {
              emit({ kind: 'error', text: `Auto-post failed: ${err.message}`, at: new Date().toISOString() })
            }
          }
        }
```

(imports: `autoSubmitIndexes` from `./review/post.js`; `AutoSubmit` type from `./types.js`.)

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/types.ts server/src/review/post.ts server/test/post.test.ts server/test/runPipeline.test.ts
git commit -m "feat: auto-submit — post filtered findings on completion, fail-closed on dedupe"
```

---

### Task 12: Web auto-submit UI, docs, green-gate

**Files:**
- Modify: `web/src/types.ts`, `web/src/api.ts`, `web/src/lib/batch.ts`, `web/src/pages/NewReview.tsx`, `web/src/pages/RunView.tsx`, `README.md`
- Test: `web/test/batch.test.ts`

**Interfaces:**
- Consumes: Task 11's `autoSubmit` param and `autoSubmitResult`.

- [ ] **Step 1: Write the failing test** — extend the `submitBatch` pass-through test again:

```ts
    await submitBatch(['u1'], { ...opts, force: true, profile: 'codex', autoSubmit: { threshold: 'medium', confirmedOnly: true } }, fake as any)
    expect(seen[0]).toEqual({
      url: 'u1', skills: ['a'], verify: true, depth: 'balanced', force: true, profile: 'codex',
      autoSubmit: { threshold: 'medium', confirmedOnly: true },
    })
```

Run: `cd web && npx vitest run test/batch.test.ts` — Expected: FAIL (type).

- [ ] **Step 2: Implement.**

`web/src/types.ts`: `export interface AutoSubmit { threshold: 'high' | 'medium' | 'all'; confirmedOnly: boolean }`; `RunRecord` gains `autoSubmit?: AutoSubmit` and `autoSubmitResult?: { posted: number; skipped: number; failed: number; dedupeChecked: boolean }`. `web/src/api.ts` `createRun` input and `web/src/lib/batch.ts` opts gain `autoSubmit?: AutoSubmit` (import the type).

`web/src/pages/NewReview.tsx` — below the verify checkbox (storage keys `pr-reviewer.autoSubmit`, `pr-reviewer.autoSubmitThreshold`, `pr-reviewer.autoSubmitConfirmedOnly`):

```tsx
      <div className="flex flex-col gap-2">
        <label className="flex w-fit items-start gap-2">
          <Checkbox
            checked={autoSubmitOn}
            onCheckedChange={(v) => {
              const nv = v === true
              setAutoSubmitOn(nv)
              localStorage.setItem(AUTO_SUBMIT_KEY, JSON.stringify(nv))
            }}
            className="mt-0.5 shrink-0"
          />
          <span className="text-sm">Auto-post findings to the PR when the run completes</span>
        </label>
        {autoSubmitOn && (
          <div className="flex flex-wrap items-center gap-3 pl-6">
            <select
              aria-label="Auto-post severity threshold"
              value={threshold}
              onChange={(e) => {
                setThreshold(e.target.value as 'high' | 'medium' | 'all')
                localStorage.setItem(AUTO_THRESHOLD_KEY, e.target.value)
              }}
              className="border-muted-200 bg-background rounded-md border p-2 text-xs outline-none"
            >
              <option value="high">High only</option>
              <option value="medium">Medium and up</option>
              <option value="all">All severities</option>
            </select>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={confirmedOnly}
                onCheckedChange={(v) => {
                  const nv = v === true
                  setConfirmedOnly(nv)
                  localStorage.setItem(AUTO_CONFIRMED_KEY, JSON.stringify(nv))
                }}
                className="shrink-0"
              />
              Confirmed findings only
            </label>
            {!verify && confirmedOnly && (
              <p className="text-muted-foreground text-xs">
                Verification is off, so every finding counts as confirmed — this filter has no effect.
              </p>
            )}
          </div>
        )}
      </div>
```

with state seeded from localStorage (`autoSubmitOn` default `false`, `threshold` default `'medium'`, `confirmedOnly` default `true`) and submit opts gaining:

```ts
        autoSubmit: autoSubmitOn ? { threshold, confirmedOnly } : undefined,
```

`web/src/pages/RunView.tsx` — under the findings-count summary line:

```tsx
      {run.autoSubmitResult && (
        <p className="text-muted-foreground text-sm">
          {run.autoSubmitResult.dedupeChecked
            ? `Auto-posted ${run.autoSubmitResult.posted} comment${run.autoSubmitResult.posted === 1 ? '' : 's'}` +
              (run.autoSubmitResult.skipped > 0 ? ` · ${run.autoSubmitResult.skipped} skipped` : '') +
              (run.autoSubmitResult.failed > 0 ? ` · ${run.autoSubmitResult.failed} failed` : '')
            : 'Auto-post skipped — existing comments could not be checked.'}
        </p>
      )}
```

`README.md`: in the "Review Quality" area add a "Model Profiles" subsection — per-run review model chosen from profiles managed in Settings; three kinds (claude / cli / openai) with the documented Codex example `codex exec --sandbox read-only --cd {cwd} -` (prompt on stdin; corrected per Task 4's Codex validation if it changed) and a note that CLI profiles must carry their own sandbox flags; openai kind needs base URL + API key (e.g. Kimi via Moonshot). Add an "Auto-Posting" subsection: opt-in per run, severity threshold + confirmed-only, fingerprint-idempotent, fail-closed when existing comments can't be read. Update the prerequisites line to mention Claude login **or** any configured model profile.

- [ ] **Step 3: Typecheck, full suites, build**

Run: `cd web && npx tsc --noEmit && npx vitest run && npm run build`, then `npm test` at the repo root.
Expected: all pass.

- [ ] **Step 4: Manual smoke** — `npm start`: model pills render on New Review; auto-post controls appear when checked and persist across reload; the verify-off hint shows when verify is unchecked.

- [ ] **Step 5: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/src/lib/batch.ts web/src/pages/NewReview.tsx web/src/pages/RunView.tsx README.md web/test/batch.test.ts
git commit -m "feat: auto-submit options in the UI and multi-model docs"
```
