# PR Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local GUI tool: paste a Bitbucket PR URL, pick review skills, an AI agent reviews the PR against a real checkout, findings render in the browser and can optionally be posted back as inline PR comments.

**Architecture:** One repo, two packages. `server/` is a Fastify + TypeScript backend that parses PR URLs, talks to the Bitbucket Cloud REST 2.0 API, maintains a shallow-clone repo cache, and drives the Claude Agent SDK (read-only tools) to produce a validated JSON findings list, streamed to the browser over SSE and persisted as one JSON file per run. `web/` is a Vite + React SPA with three screens (New Review, Run view, Settings).

**Tech Stack:** Node 20+, TypeScript (strict), Fastify 4, zod, `@anthropic-ai/claude-agent-sdk`, Vitest, Vite + React 18.

**Spec:** `docs/superpowers/specs/2026-07-21-pr-reviewer-design.md`

## Global Constraints

- Node 20+, TypeScript `"strict": true` everywhere.
- Agent gets read-only tools only: `Read`, `Grep`, `Glob`. Never `Write`, `Edit`, or `Bash`.
- Config lives at `~/.pr-reviewer/config.json`, written with file mode `0600`.
- Repo cache root defaults to `~/.pr-reviewer/repos`, runs to `~/.pr-reviewer/runs`.
- One active review run at a time; later submissions queue.
- Comments are never auto-posted; posting requires an explicit user action in the UI.
- Default model: `claude-sonnet-5`. Diff warning threshold default: 8000 changed lines.
- All server tests run with `npm test` (Vitest) inside `server/`.
- Commit after every green test cycle. Commit messages: conventional (`feat:`, `test:`, `chore:`).

---

### Task 1: Server scaffold + PR URL parser

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`
- Create: `server/src/types.ts`, `server/src/bitbucket/parsePrUrl.ts`
- Test: `server/test/parsePrUrl.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `PrRef { workspace: string; repo: string; id: number }`, `parsePrUrl(url: string): PrRef` (throws `Error` with message starting `Invalid PR URL` on bad input). Also the shared types every later task imports from `server/src/types.ts`.

- [ ] **Step 1: Scaffold the package**

`server/package.json`:

```json
{
  "name": "pr-reviewer-server",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.0",
    "fastify": "^4.28.0",
    "@fastify/static": "^7.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^20.14.0"
  }
}
```

`server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
```

`server/src/types.ts`:

```ts
export interface PrRef {
  workspace: string
  repo: string
  id: number
}

export type Severity = 'high' | 'medium' | 'low' | 'info'

export interface Finding {
  file: string
  line: number
  severity: Severity
  category: string
  summary: string
  detail: string
  suggestion: string
  skill: string
}

export type RunStatus = 'running' | 'queued' | 'completed' | 'failed'

export interface RunEvent {
  kind: 'status' | 'text' | 'tool' | 'error'
  text: string
  at: string
}

export interface RunRecord {
  id: string
  pr: PrRef
  prTitle: string
  skills: string[]
  focus?: string
  status: RunStatus
  createdAt: string
  finishedAt?: string
  findings: Finding[]
  transcript: RunEvent[]
  error?: string
  postedCommentIds: number[]
}

export interface SkillInfo {
  name: string
  description: string
  dir: string
  source: string
}

export interface PrMeta {
  title: string
  description: string
  sourceBranch: string
  destinationBranch: string
  sourceCommit: string
}
```

Run: `cd server && npm install`
Expected: installs cleanly.

- [ ] **Step 2: Write the failing test**

`server/test/parsePrUrl.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parsePrUrl } from '../src/bitbucket/parsePrUrl.js'

describe('parsePrUrl', () => {
  it('parses a standard Bitbucket PR URL', () => {
    expect(parsePrUrl('https://bitbucket.org/appswave/rsk/pull-requests/42')).toEqual({
      workspace: 'appswave',
      repo: 'rsk',
      id: 42,
    })
  })

  it('tolerates trailing path segments and whitespace', () => {
    expect(parsePrUrl('  https://bitbucket.org/ws/my-repo/pull-requests/7/diff  ')).toEqual({
      workspace: 'ws',
      repo: 'my-repo',
      id: 7,
    })
  })

  it('rejects non-PR URLs', () => {
    expect(() => parsePrUrl('https://bitbucket.org/ws/repo/src/main')).toThrow(/Invalid PR URL/)
    expect(() => parsePrUrl('https://github.com/a/b/pull/1')).toThrow(/Invalid PR URL/)
    expect(() => parsePrUrl('not a url')).toThrow(/Invalid PR URL/)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run test/parsePrUrl.test.ts`
Expected: FAIL — cannot find module `../src/bitbucket/parsePrUrl.js`

- [ ] **Step 4: Write minimal implementation**

`server/src/bitbucket/parsePrUrl.ts`:

```ts
import type { PrRef } from '../types.js'

const PR_URL_RE = /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/

export function parsePrUrl(url: string): PrRef {
  const m = PR_URL_RE.exec(url.trim())
  if (!m) {
    throw new Error(
      'Invalid PR URL. Expected https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>',
    )
  }
  return { workspace: m[1], repo: m[2], id: Number(m[3]) }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run test/parsePrUrl.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add server
git commit -m "feat: server scaffold and Bitbucket PR URL parser"
```

---

### Task 2: Config module

**Files:**
- Create: `server/src/config.ts`
- Test: `server/test/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Config { bitbucketEmail: string; bitbucketToken: string; skillDirs: string[]; model: string; cacheDir: string; runsDir: string; diffWarnLines: number }`
  - `loadConfig(path?: string): Config` — returns defaults if the file is missing or invalid
  - `saveConfig(cfg: Config, path?: string): void` — creates parent dirs, writes JSON with mode `0600`
  - `DEFAULT_CONFIG_PATH: string` = `~/.pr-reviewer/config.json`

- [ ] **Step 1: Write the failing test**

`server/test/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '../src/config.js'

describe('config', () => {
  it('returns defaults when file is missing', () => {
    const cfg = loadConfig(join(tmpdir(), 'nope', 'config.json'))
    expect(cfg.model).toBe('claude-sonnet-5')
    expect(cfg.diffWarnLines).toBe(8000)
    expect(cfg.bitbucketToken).toBe('')
    expect(cfg.cacheDir.endsWith('/.pr-reviewer/repos')).toBe(true)
  })

  it('round-trips save and load, with 0600 permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
    const path = join(dir, 'deep', 'config.json')
    const cfg = loadConfig(path)
    cfg.bitbucketEmail = 'fe@appswave.io'
    cfg.bitbucketToken = 'secret'
    cfg.skillDirs = ['/tmp/skills']
    saveConfig(cfg, path)
    const loaded = loadConfig(path)
    expect(loaded.bitbucketEmail).toBe('fe@appswave.io')
    expect(loaded.skillDirs).toEqual(['/tmp/skills'])
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('falls back to defaults on corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, '{not json')
    expect(loadConfig(path).model).toBe('claude-sonnet-5')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`

- [ ] **Step 3: Write minimal implementation**

`server/src/config.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const home = homedir()

const ConfigSchema = z.object({
  bitbucketEmail: z.string().default(''),
  bitbucketToken: z.string().default(''),
  skillDirs: z
    .array(z.string())
    .default([join(home, 'Desktop/projects/forge-skills/skills'), join(home, '.claude/skills')]),
  model: z.string().default('claude-sonnet-5'),
  cacheDir: z.string().default(join(home, '.pr-reviewer', 'repos')),
  runsDir: z.string().default(join(home, '.pr-reviewer', 'runs')),
  diffWarnLines: z.number().int().positive().default(8000),
})

export type Config = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG_PATH = join(home, '.pr-reviewer', 'config.json')

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): Config {
  let raw: unknown = {}
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      raw = {}
    }
  }
  const parsed = ConfigSchema.safeParse(raw)
  return parsed.success ? parsed.data : ConfigSchema.parse({})
}

export function saveConfig(cfg: Config, path: string = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/config.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/test/config.test.ts
git commit -m "feat: config load/save with defaults and 0600 permissions"
```

---

### Task 3: Bitbucket API client

**Files:**
- Create: `server/src/bitbucket/client.ts`
- Test: `server/test/bitbucketClient.test.ts`

**Interfaces:**
- Consumes: `PrRef`, `PrMeta` from `types.ts`
- Produces: `class BitbucketClient` with constructor `(email: string, token: string, fetchFn?: typeof fetch)` and methods:
  - `getPullRequest(pr: PrRef): Promise<PrMeta>`
  - `getDiff(pr: PrRef): Promise<string>` (raw unified diff text)
  - `postInlineComment(pr: PrRef, c: { path: string; line: number; text: string }): Promise<number>` (returns created comment id)
  - `cloneUrl(pr: PrRef): string` — HTTPS URL with embedded credentials for git
  - All methods throw `BitbucketAuthError` (exported class) on 401/403 with an actionable message, plain `Error` otherwise.

- [ ] **Step 1: Write the failing test**

`server/test/bitbucketClient.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { BitbucketClient, BitbucketAuthError } from '../src/bitbucket/client.js'

const pr = { workspace: 'ws', repo: 'r', id: 5 }

function fakeFetch(status: number, body: unknown, text = '') {
  return vi.fn(async () =>
    new Response(text || JSON.stringify(body), { status }),
  ) as unknown as typeof fetch
}

describe('BitbucketClient', () => {
  it('maps pull request metadata', async () => {
    const f = fakeFetch(200, {
      title: 'Fix members page',
      description: 'desc',
      source: { branch: { name: 'feat/x' }, commit: { hash: 'abc123' } },
      destination: { branch: { name: 'develop' } },
    })
    const c = new BitbucketClient('e@x.io', 'tok', f)
    const meta = await c.getPullRequest(pr)
    expect(meta).toEqual({
      title: 'Fix members page',
      description: 'desc',
      sourceBranch: 'feat/x',
      destinationBranch: 'develop',
      sourceCommit: 'abc123',
    })
    const url = (f as any).mock.calls[0][0] as string
    expect(url).toBe('https://api.bitbucket.org/2.0/repositories/ws/r/pullrequests/5')
    const auth = (f as any).mock.calls[0][1].headers.Authorization as string
    expect(auth.startsWith('Basic ')).toBe(true)
  })

  it('returns raw diff text', async () => {
    const c = new BitbucketClient('e', 't', fakeFetch(200, null, 'diff --git a/x b/x'))
    expect(await c.getDiff(pr)).toBe('diff --git a/x b/x')
  })

  it('posts an inline comment and returns its id', async () => {
    const f = fakeFetch(201, { id: 99 })
    const c = new BitbucketClient('e', 't', f)
    const id = await c.postInlineComment(pr, { path: 'src/a.ts', line: 12, text: 'hi' })
    expect(id).toBe(99)
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('https://api.bitbucket.org/2.0/repositories/ws/r/pullrequests/5/comments')
    expect(JSON.parse(init.body)).toEqual({
      content: { raw: 'hi' },
      inline: { path: 'src/a.ts', to: 12 },
    })
  })

  it('throws BitbucketAuthError on 401/403', async () => {
    const c = new BitbucketClient('e', 'bad', fakeFetch(401, {}))
    await expect(c.getDiff(pr)).rejects.toBeInstanceOf(BitbucketAuthError)
  })

  it('builds an authenticated clone URL', () => {
    const c = new BitbucketClient('e@x.io', 't0k', fakeFetch(200, {}))
    expect(c.cloneUrl(pr)).toBe('https://e%40x.io:t0k@bitbucket.org/ws/r.git')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/bitbucketClient.test.ts`
Expected: FAIL — cannot find module `../src/bitbucket/client.js`

- [ ] **Step 3: Write minimal implementation**

`server/src/bitbucket/client.ts`:

```ts
import type { PrMeta, PrRef } from '../types.js'

const API = 'https://api.bitbucket.org/2.0'

export class BitbucketAuthError extends Error {
  constructor(status: number) {
    super(
      status === 401
        ? 'Bitbucket rejected your credentials (401). Check your email/API token in Settings.'
        : 'Bitbucket denied access to this repository (403). Your token may lack access to it.',
    )
    this.name = 'BitbucketAuthError'
  }
}

export class BitbucketClient {
  constructor(
    private email: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private prBase(pr: PrRef): string {
    return `${API}/repositories/${pr.workspace}/${pr.repo}/pullrequests/${pr.id}`
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${this.email}:${this.token}`).toString('base64'),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    if (res.status === 401 || res.status === 403) throw new BitbucketAuthError(res.status)
    if (!res.ok) throw new Error(`Bitbucket API error ${res.status} for ${url}`)
    return res
  }

  async getPullRequest(pr: PrRef): Promise<PrMeta> {
    const d = (await (await this.request(this.prBase(pr))).json()) as any
    return {
      title: d.title ?? '',
      description: d.description ?? '',
      sourceBranch: d.source.branch.name,
      destinationBranch: d.destination.branch.name,
      sourceCommit: d.source.commit.hash,
    }
  }

  async getDiff(pr: PrRef): Promise<string> {
    return (await this.request(`${this.prBase(pr)}/diff`)).text()
  }

  async postInlineComment(
    pr: PrRef,
    c: { path: string; line: number; text: string },
  ): Promise<number> {
    const res = await this.request(`${this.prBase(pr)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: { raw: c.text }, inline: { path: c.path, to: c.line } }),
    })
    return ((await res.json()) as any).id as number
  }

  cloneUrl(pr: PrRef): string {
    return `https://${encodeURIComponent(this.email)}:${encodeURIComponent(this.token)}@bitbucket.org/${pr.workspace}/${pr.repo}.git`
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/bitbucketClient.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/bitbucket/client.ts server/test/bitbucketClient.test.ts
git commit -m "feat: Bitbucket Cloud API client (PR meta, diff, inline comments)"
```

---

### Task 4: Skill directory scanner

**Files:**
- Create: `server/src/skills/scanner.ts`
- Test: `server/test/scanner.test.ts`

**Interfaces:**
- Consumes: `SkillInfo` from `types.ts`
- Produces:
  - `scanSkillDirs(dirs: string[]): SkillInfo[]` — for each existing dir, every subdirectory containing `SKILL.md` becomes a skill; missing dirs are skipped silently; `source` is the root dir path; `dir` is the skill's own directory.
  - `readSkillContent(skill: SkillInfo): string` — full `SKILL.md` text.
  - Frontmatter: `name:` and `description:` parsed from the YAML block between leading `---` lines; `name` falls back to the folder name, `description` to `''`.

- [ ] **Step 1: Write the failing test**

`server/test/scanner.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSkillDirs, readSkillContent } from '../src/skills/scanner.js'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'prr-skills-'))
  mkdirSync(join(root, 'review-code'))
  writeFileSync(
    join(root, 'review-code', 'SKILL.md'),
    '---\nname: review-code\ndescription: Review code against standards\n---\n\n# Body here\n',
  )
  mkdirSync(join(root, 'no-frontmatter'))
  writeFileSync(join(root, 'no-frontmatter', 'SKILL.md'), '# Just a body\n')
  mkdirSync(join(root, 'not-a-skill'))
  writeFileSync(join(root, 'not-a-skill', 'README.md'), 'nope')
})

describe('scanSkillDirs', () => {
  it('finds skills with SKILL.md and parses frontmatter', () => {
    const skills = scanSkillDirs([root, '/does/not/exist'])
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['no-frontmatter', 'review-code'])
    const rc = skills.find((s) => s.name === 'review-code')!
    expect(rc.description).toBe('Review code against standards')
    expect(rc.source).toBe(root)
    expect(rc.dir).toBe(join(root, 'review-code'))
  })

  it('reads full skill content', () => {
    const rc = scanSkillDirs([root]).find((s) => s.name === 'review-code')!
    expect(readSkillContent(rc)).toContain('# Body here')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/scanner.test.ts`
Expected: FAIL — cannot find module `../src/skills/scanner.js`

- [ ] **Step 3: Write minimal implementation**

`server/src/skills/scanner.ts`:

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillInfo } from '../types.js'

function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

export function scanSkillDirs(dirs: string[]): SkillInfo[] {
  const skills: SkillInfo[] = []
  for (const root of dirs) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillDir = join(root, entry.name)
      const skillFile = join(skillDir, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const fm = parseFrontmatter(readFileSync(skillFile, 'utf8'))
      skills.push({
        name: fm.name ?? entry.name,
        description: fm.description ?? '',
        dir: skillDir,
        source: root,
      })
    }
  }
  return skills
}

export function readSkillContent(skill: SkillInfo): string {
  return readFileSync(join(skill.dir, 'SKILL.md'), 'utf8')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/scanner.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/skills/scanner.ts server/test/scanner.test.ts
git commit -m "feat: skill directory scanner with frontmatter parsing"
```

---

### Task 5: Repo cache manager

**Files:**
- Create: `server/src/repos/cache.ts`
- Test: `server/test/repoCache.test.ts` (integration, local fixture repo, no network)

**Interfaces:**
- Consumes: `PrRef` from `types.ts`
- Produces: `class RepoCache` with constructor `(root: string)` and:
  - `ensureCheckout(pr: PrRef, opts: { cloneUrl: string; sourceBranch: string; commit: string }): Promise<string>` — returns absolute checkout path (`<root>/<workspace>/<repo>`). Clones `--depth 50` if absent, fetches the source branch, checks out the commit detached. Throws `Error` whose message includes git stderr on failure.
  - `clear(pr: PrRef): void` — removes that repo's cache directory.

- [ ] **Step 1: Write the failing test**

`server/test/repoCache.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoCache } from '../src/repos/cache.js'

let origin: string
let commit: string
const pr = { workspace: 'ws', repo: 'fixture', id: 1 }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

beforeAll(() => {
  origin = mkdtempSync(join(tmpdir(), 'prr-origin-'))
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'config', 'user.email', 't@t')
  git(origin, 'config', 'user.name', 't')
  writeFileSync(join(origin, 'a.txt'), 'main\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'init')
  git(origin, 'checkout', '-qb', 'feat/x')
  writeFileSync(join(origin, 'a.txt'), 'feature\n')
  git(origin, 'commit', '-aqm', 'feature change')
  commit = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'checkout', '-q', 'main')
})

describe('RepoCache', () => {
  it('clones, fetches the PR branch, and checks out the commit detached', async () => {
    const cache = new RepoCache(mkdtempSync(join(tmpdir(), 'prr-cache-')))
    const dir = await cache.ensureCheckout(pr, {
      cloneUrl: origin,
      sourceBranch: 'feat/x',
      commit,
    })
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('feature\n')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(commit)
  })

  it('reuses an existing clone on second call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const opts = { cloneUrl: origin, sourceBranch: 'feat/x', commit }
    const first = await cache.ensureCheckout(pr, opts)
    const second = await cache.ensureCheckout(pr, opts)
    expect(second).toBe(first)
  })

  it('clear removes the cached repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const dir = await cache.ensureCheckout(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit })
    cache.clear(pr)
    expect(existsSync(dir)).toBe(false)
  })

  it('surfaces git stderr on failure', async () => {
    const cache = new RepoCache(mkdtempSync(join(tmpdir(), 'prr-cache-')))
    await expect(
      cache.ensureCheckout(pr, { cloneUrl: '/nonexistent/repo', sourceBranch: 'x', commit: 'y' }),
    ).rejects.toThrow(/git clone failed/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/repoCache.test.ts`
Expected: FAIL — cannot find module `../src/repos/cache.js`

- [ ] **Step 3: Write minimal implementation**

`server/src/repos/cache.ts`:

```ts
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PrRef } from '../types.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string | undefined, label: string, args: string[]): Promise<void> {
  try {
    await execFileAsync('git', args, { cwd })
  } catch (err: any) {
    throw new Error(`git ${label} failed: ${err.stderr ?? err.message}`)
  }
}

export class RepoCache {
  constructor(private root: string) {}

  repoDir(pr: PrRef): string {
    return join(this.root, pr.workspace, pr.repo)
  }

  async ensureCheckout(
    pr: PrRef,
    opts: { cloneUrl: string; sourceBranch: string; commit: string },
  ): Promise<string> {
    const dir = this.repoDir(pr)
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(join(this.root, pr.workspace), { recursive: true })
      await git(undefined, 'clone', ['clone', '--depth', '50', opts.cloneUrl, dir])
    }
    await git(dir, 'fetch', ['fetch', '--depth', '50', 'origin', opts.sourceBranch])
    await git(dir, 'checkout', ['checkout', '--detach', '-f', opts.commit])
    return dir
  }

  clear(pr: PrRef): void {
    rmSync(this.repoDir(pr), { recursive: true, force: true })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/repoCache.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/cache.ts server/test/repoCache.test.ts
git commit -m "feat: shallow-clone repo cache with detached PR checkout"
```

---

### Task 6: Findings schema + extractor

**Files:**
- Create: `server/src/review/findings.ts`
- Test: `server/test/findings.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Severity` from `types.ts`
- Produces:
  - `FindingSchema` (zod) and `extractFindings(text: string): Finding[]` — locates the last fenced ```json block (or a bare top-level JSON array) in the agent's final text, parses it, validates each element. Throws `FindingsParseError` (exported class) if no valid JSON array is found; invalid individual items are dropped, not fatal, as long as at least the array parses.
  - `countDiffLines(diff: string): number` — counts `+`/`-` lines (excluding `+++`/`---` headers) for the oversized-diff warning.

- [ ] **Step 1: Write the failing test**

`server/test/findings.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractFindings, FindingsParseError, countDiffLines } from '../src/review/findings.js'

const valid = {
  file: 'src/a.ts',
  line: 3,
  severity: 'high',
  category: 'bug',
  summary: 's',
  detail: 'd',
  suggestion: 'fix',
  skill: 'review-code',
}

describe('extractFindings', () => {
  it('parses a fenced json block', () => {
    const text = 'Here is my review.\n```json\n' + JSON.stringify([valid]) + '\n```\nDone.'
    expect(extractFindings(text)).toEqual([valid])
  })

  it('uses the LAST fenced block when several exist', () => {
    const text =
      '```json\n[]\n```\nrevised:\n```json\n' + JSON.stringify([valid]) + '\n```'
    expect(extractFindings(text)).toHaveLength(1)
  })

  it('accepts a bare JSON array', () => {
    expect(extractFindings(JSON.stringify([valid]))).toEqual([valid])
  })

  it('drops invalid items but keeps valid ones', () => {
    const text = '```json\n' + JSON.stringify([valid, { file: 'x' }]) + '\n```'
    expect(extractFindings(text)).toEqual([valid])
  })

  it('throws FindingsParseError when no JSON array found', () => {
    expect(() => extractFindings('no json here')).toThrow(FindingsParseError)
  })
})

describe('countDiffLines', () => {
  it('counts changed lines, ignoring file headers', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' ctx',
    ].join('\n')
    expect(countDiffLines(diff)).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/findings.test.ts`
Expected: FAIL — cannot find module `../src/review/findings.js`

- [ ] **Step 3: Write minimal implementation**

`server/src/review/findings.ts`:

```ts
import { z } from 'zod'
import type { Finding } from '../types.js'

export class FindingsParseError extends Error {
  constructor() {
    super('Could not find a valid JSON findings array in the agent output.')
    this.name = 'FindingsParseError'
  }
}

export const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(['high', 'medium', 'low', 'info']),
  category: z.string().min(1),
  summary: z.string().min(1),
  detail: z.string(),
  suggestion: z.string(),
  skill: z.string(),
})

function candidateJson(text: string): string | undefined {
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  if (fenced.length > 0) return fenced[fenced.length - 1][1]
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) return trimmed
  return undefined
}

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
    return parsed.success ? [parsed.data] : []
  })
}

export function countDiffLines(diff: string): number {
  return diff
    .split('\n')
    .filter(
      (l) =>
        (l.startsWith('+') || l.startsWith('-')) &&
        !l.startsWith('+++') &&
        !l.startsWith('---'),
    ).length
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/findings.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/review/findings.ts server/test/findings.test.ts
git commit -m "feat: findings JSON schema, extractor, and diff line counter"
```

---

### Task 7: Review prompt builder

**Files:**
- Create: `server/src/review/prompt.ts`
- Test: `server/test/prompt.test.ts`

**Interfaces:**
- Consumes: `PrMeta` from `types.ts`
- Produces: `buildReviewPrompt(input: { meta: PrMeta; diff: string; skills: { name: string; content: string }[]; focus?: string }): string` — a single prompt string containing PR context, mandatory skill instructions, the diff, and the strict JSON output contract matching `FindingSchema`.

- [ ] **Step 1: Write the failing test**

`server/test/prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildReviewPrompt } from '../src/review/prompt.js'

const meta = {
  title: 'Fix rounding',
  description: 'Rounds totals correctly',
  sourceBranch: 'feat/round',
  destinationBranch: 'develop',
  sourceCommit: 'abc',
}

describe('buildReviewPrompt', () => {
  it('embeds PR context, skills, diff, focus, and the output contract', () => {
    const p = buildReviewPrompt({
      meta,
      diff: 'diff --git a/x b/x\n+new line',
      skills: [{ name: 'review-code', content: 'ALWAYS check naming.' }],
      focus: 'watch date handling',
    })
    expect(p).toContain('Fix rounding')
    expect(p).toContain('feat/round')
    expect(p).toContain('## Skill: review-code')
    expect(p).toContain('ALWAYS check naming.')
    expect(p).toContain('+new line')
    expect(p).toContain('watch date handling')
    expect(p).toContain('"severity"')
    expect(p).toContain('```json')
  })

  it('omits the focus section when not given', () => {
    const p = buildReviewPrompt({ meta, diff: 'd', skills: [] })
    expect(p).not.toContain('Reviewer focus')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/prompt.test.ts`
Expected: FAIL — cannot find module `../src/review/prompt.js`

- [ ] **Step 3: Write minimal implementation**

`server/src/review/prompt.ts`:

```ts
import type { PrMeta } from '../types.js'

export function buildReviewPrompt(input: {
  meta: PrMeta
  diff: string
  skills: { name: string; content: string }[]
  focus?: string
}): string {
  const { meta, diff, skills, focus } = input
  const skillSections = skills
    .map((s) => `## Skill: ${s.name}\n\n${s.content}`)
    .join('\n\n')

  return `You are performing a code review of a Bitbucket pull request.
The repository is checked out at your working directory at the PR's head commit.
Use Read/Grep/Glob to inspect surrounding code — do not limit yourself to the diff.

# Pull request
Title: ${meta.title}
Description: ${meta.description || '(none)'}
Source branch: ${meta.sourceBranch} → Destination: ${meta.destinationBranch}

# Mandatory review instructions
Apply EVERY skill below. Each is mandatory, not optional.

${skillSections || '(no extra skills selected — perform a general code review)'}
${focus ? `\n# Reviewer focus\n${focus}\n` : ''}
# Diff under review
\`\`\`diff
${diff}
\`\`\`

# Output contract (strict)
After your investigation, end your reply with ONE fenced \`\`\`json block containing a JSON array.
Each element must be exactly:
{
  "file": "path relative to repo root",
  "line": <positive integer — line in the NEW file version>,
  "severity": "high" | "medium" | "low" | "info",
  "category": "bug" | "security" | "performance" | "a11y" | "rtl" | "style" | "convention",
  "summary": "one sentence",
  "detail": "explanation with reasoning",
  "suggestion": "concrete fix, may include code",
  "skill": "name of the skill that produced this finding"
}
Only report findings on files changed in the diff. An empty array [] is a valid result.
Do not put any text after the json block.`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/prompt.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/review/prompt.ts server/test/prompt.test.ts
git commit -m "feat: review prompt builder with skill injection and output contract"
```

---

### Task 8: Run store

**Files:**
- Create: `server/src/store/runs.ts`
- Test: `server/test/runStore.test.ts`

**Interfaces:**
- Consumes: `RunRecord`, `RunStatus` from `types.ts`
- Produces: `class RunStore` with constructor `(dir: string)` and:
  - `create(partial: Omit<RunRecord, 'id' | 'createdAt' | 'findings' | 'transcript' | 'postedCommentIds'>): RunRecord` — generates `id` via `crypto.randomUUID()`, stamps `createdAt` ISO string, initializes empty arrays, persists, returns the record.
  - `save(run: RunRecord): void`
  - `get(id: string): RunRecord | undefined`
  - `list(): RunRecord[]` — newest first, transcript omitted (set to `[]`) to keep the listing light.

- [ ] **Step 1: Write the failing test**

`server/test/runStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunStore } from '../src/store/runs.js'

const base = {
  pr: { workspace: 'ws', repo: 'r', id: 1 },
  prTitle: 'T',
  skills: ['review-code'],
  status: 'running' as const,
}

describe('RunStore', () => {
  it('creates, persists, and reloads a run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-runs-'))
    const store = new RunStore(dir)
    const run = store.create(base)
    expect(run.id).toBeTruthy()
    expect(run.findings).toEqual([])
    const reloaded = new RunStore(dir).get(run.id)
    expect(reloaded?.prTitle).toBe('T')
  })

  it('save overwrites and list returns newest first without transcripts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-runs-'))
    const store = new RunStore(dir)
    const a = store.create({ ...base, prTitle: 'A' })
    a.status = 'completed'
    a.transcript.push({ kind: 'text', text: 'hello', at: a.createdAt })
    store.save(a)
    const b = store.create({ ...base, prTitle: 'B' })
    const list = store.list()
    expect(list.map((r) => r.id)).toContain(a.id)
    expect(list.map((r) => r.id)).toContain(b.id)
    expect(list.every((r) => r.transcript.length === 0)).toBe(true)
    expect(store.get(a.id)?.status).toBe('completed')
    expect(store.get(a.id)?.transcript).toHaveLength(1)
  })

  it('get returns undefined for unknown id', () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), 'prr-runs-')))
    expect(store.get('nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/runStore.test.ts`
Expected: FAIL — cannot find module `../src/store/runs.js`

- [ ] **Step 3: Write minimal implementation**

`server/src/store/runs.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunRecord } from '../types.js'

export class RunStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  create(
    partial: Omit<RunRecord, 'id' | 'createdAt' | 'findings' | 'transcript' | 'postedCommentIds'>,
  ): RunRecord {
    const run: RunRecord = {
      ...partial,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      findings: [],
      transcript: [],
      postedCommentIds: [],
    }
    this.save(run)
    return run
  }

  save(run: RunRecord): void {
    writeFileSync(this.path(run.id), JSON.stringify(run, null, 2))
  }

  get(id: string): RunRecord | undefined {
    const p = this.path(id)
    if (!existsSync(p)) return undefined
    return JSON.parse(readFileSync(p, 'utf8')) as RunRecord
  }

  list(): RunRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as RunRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r, transcript: [] }))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/runStore.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/store/runs.ts server/test/runStore.test.ts
git commit -m "feat: JSON-file run store with light listing"
```

---

### Task 9: Agent review runner

**Files:**
- Create: `server/src/review/runner.ts`
- Test: `server/test/runner.test.ts` (agent boundary mocked)

**Interfaces:**
- Consumes: `buildReviewPrompt` (Task 7), `extractFindings`, `FindingsParseError` (Task 6), `Finding`, `RunEvent`, `PrMeta` from `types.ts`
- Produces:
  - `type AgentQuery = (prompt: string, opts: { cwd: string; model: string }) => AsyncIterable<AgentMessage>` where `AgentMessage = { type: 'assistant'; text?: string; tool?: string } | { type: 'result'; ok: boolean; text: string }`
  - `sdkQuery: AgentQuery` — the real implementation wrapping `query()` from `@anthropic-ai/claude-agent-sdk` with `allowedTools: ['Read','Grep','Glob']`, `permissionMode: 'bypassPermissions'`.
  - `runReview(input: { meta: PrMeta; diff: string; skills: { name: string; content: string }[]; focus?: string; cwd: string; model: string }, onEvent: (e: RunEvent) => void, agentQuery?: AgentQuery): Promise<Finding[]>` — streams events, extracts findings from the result text; on `FindingsParseError` retries ONCE with a reformat prompt; rethrows on second failure.

- [ ] **Step 1: Write the failing test**

`server/test/runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runReview } from '../src/review/runner.js'
import type { RunEvent } from '../src/types.js'

const meta = {
  title: 'T',
  description: '',
  sourceBranch: 's',
  destinationBranch: 'd',
  sourceCommit: 'c',
}
const finding = {
  file: 'a.ts',
  line: 1,
  severity: 'low',
  category: 'style',
  summary: 's',
  detail: 'd',
  suggestion: 'fix',
  skill: 'review-code',
}
const goodJson = '```json\n' + JSON.stringify([finding]) + '\n```'
const input = { meta, diff: 'd', skills: [], cwd: '/tmp', model: 'm' }

function fakeAgent(...resultTexts: string[]) {
  let call = 0
  return async function* (_prompt: string) {
    yield { type: 'assistant' as const, text: 'thinking' }
    yield { type: 'assistant' as const, tool: 'Read a.ts' }
    yield { type: 'result' as const, ok: true, text: resultTexts[call++] }
  }
}

describe('runReview', () => {
  it('streams events and returns parsed findings', async () => {
    const events: RunEvent[] = []
    const findings = await runReview(input, (e) => events.push(e), fakeAgent(goodJson))
    expect(findings).toHaveLength(1)
    expect(events.some((e) => e.kind === 'text' && e.text === 'thinking')).toBe(true)
    expect(events.some((e) => e.kind === 'tool')).toBe(true)
  })

  it('retries once on malformed findings, then succeeds', async () => {
    const findings = await runReview(input, () => {}, fakeAgent('no json at all', goodJson))
    expect(findings).toHaveLength(1)
  })

  it('fails after the single retry is also malformed', async () => {
    await expect(
      runReview(input, () => {}, fakeAgent('bad', 'still bad')),
    ).rejects.toThrow(/JSON findings/)
  })

  it('fails when the agent result is not ok', async () => {
    const agent = async function* () {
      yield { type: 'result' as const, ok: false, text: 'agent crashed' }
    }
    await expect(runReview(input, () => {}, agent)).rejects.toThrow(/agent crashed/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/runner.test.ts`
Expected: FAIL — cannot find module `../src/review/runner.js`

- [ ] **Step 3: Write minimal implementation**

`server/src/review/runner.ts`:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Finding, PrMeta, RunEvent } from '../types.js'
import { FindingsParseError, extractFindings } from './findings.js'
import { buildReviewPrompt } from './prompt.js'

export type AgentMessage =
  | { type: 'assistant'; text?: string; tool?: string }
  | { type: 'result'; ok: boolean; text: string }

export type AgentQuery = (
  prompt: string,
  opts: { cwd: string; model: string },
) => AsyncIterable<AgentMessage>

export const sdkQuery: AgentQuery = async function* (prompt, opts) {
  const q = query({
    prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      allowedTools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'bypassPermissions',
    },
  })
  for await (const msg of q as AsyncIterable<any>) {
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text') yield { type: 'assistant', text: block.text }
        if (block.type === 'tool_use')
          yield { type: 'assistant', tool: `${block.name} ${JSON.stringify(block.input).slice(0, 120)}` }
      }
    }
    if (msg.type === 'result') {
      yield {
        type: 'result',
        ok: msg.subtype === 'success',
        text: msg.subtype === 'success' ? msg.result : (msg.result ?? 'agent failed'),
      }
    }
  }
}

async function runOnce(
  prompt: string,
  opts: { cwd: string; model: string },
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery,
): Promise<string> {
  let resultText: string | undefined
  for await (const msg of agentQuery(prompt, opts)) {
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

const REFORMAT_PROMPT =
  'Your previous reply did not end with a valid ```json findings array. ' +
  'Reply now with ONLY the ```json fenced array of findings from your review, nothing else. ' +
  'Previous reply:\n\n'

export async function runReview(
  input: {
    meta: PrMeta
    diff: string
    skills: { name: string; content: string }[]
    focus?: string
    cwd: string
    model: string
  },
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery = sdkQuery,
): Promise<Finding[]> {
  const opts = { cwd: input.cwd, model: input.model }
  const text = await runOnce(buildReviewPrompt(input), opts, onEvent, agentQuery)
  try {
    return extractFindings(text)
  } catch (err) {
    if (!(err instanceof FindingsParseError)) throw err
    onEvent({ kind: 'status', text: 'Output malformed — asking agent to reformat', at: new Date().toISOString() })
    const retryText = await runOnce(REFORMAT_PROMPT + text, opts, onEvent, agentQuery)
    return extractFindings(retryText)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/runner.test.ts`
Expected: PASS (4 tests). Also run `npx tsc --noEmit` — the `sdkQuery` wrapper must typecheck against the installed SDK; if the SDK's message shape differs from `msg.message?.content`, adjust the wrapper (only the wrapper — tests don't touch it).

- [ ] **Step 5: Commit**

```bash
git add server/src/review/runner.ts server/test/runner.test.ts
git commit -m "feat: agent review runner with streaming events and reformat retry"
```

---

### Task 10: HTTP API + SSE + run queue

**Files:**
- Create: `server/src/app.ts` (Fastify app factory), `server/src/index.ts` (entry point)
- Test: `server/test/app.test.ts` (uses `app.inject`, agent mocked)

**Interfaces:**
- Consumes: everything from Tasks 1–9
- Produces: `buildApp(deps: { configPath?: string; agentQuery?: AgentQuery }): FastifyInstance` with routes:
  - `GET /api/config` → `Config` (token masked as `"***"` when set); `PUT /api/config` body `Config` (a masked `"***"` token means "keep existing") → saved config
  - `GET /api/skills` → `SkillInfo[]`
  - `GET /api/runs` → `RunRecord[]` (light); `GET /api/runs/:id` → full `RunRecord` or 404
  - `POST /api/runs` body `{ url: string; skills: string[]; focus?: string; force?: boolean }` → `202 { id }`; `400 { error }` on bad URL; `409 { error, diffLines }` when the diff exceeds `diffWarnLines` and `force` is not true
  - `GET /api/runs/:id/events` → SSE stream of `RunEvent` JSON, ending with event `done`
  - `POST /api/runs/:id/comments` body `{ findingIndexes: number[] }` → `{ posted: number[] }` (comment ids), appends to `postedCommentIds`
  - `DELETE /api/cache/:workspace/:repo` → `{ ok: true }` — removes that repo's cache directory (spec: per-repo cache clear)
  - One review executes at a time; extra submissions are `status: 'queued'` and start when the active one finishes.

- [ ] **Step 1: Write the failing test**

`server/test/app.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { saveConfig, loadConfig } from '../src/config.js'

function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prr-app-'))
  const skillsDir = join(dir, 'skills')
  mkdirSync(join(skillsDir, 'review-code'), { recursive: true })
  writeFileSync(
    join(skillsDir, 'review-code', 'SKILL.md'),
    '---\nname: review-code\ndescription: desc\n---\nbody',
  )
  const path = join(dir, 'config.json')
  const cfg = loadConfig(path)
  cfg.bitbucketToken = 'tok'
  cfg.bitbucketEmail = 'e@x.io'
  cfg.skillDirs = [skillsDir]
  cfg.runsDir = join(dir, 'runs')
  cfg.cacheDir = join(dir, 'repos')
  saveConfig(cfg, path)
  return path
}

describe('app', () => {
  it('GET /api/config masks the token', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.statusCode).toBe(200)
    expect(res.json().bitbucketToken).toBe('***')
  })

  it('PUT /api/config keeps existing token when masked value is sent', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const body = { ...loadConfig(path), bitbucketToken: '***', model: 'claude-opus-4-8' }
    const res = await app.inject({ method: 'PUT', url: '/api/config', payload: body })
    expect(res.statusCode).toBe(200)
    expect(loadConfig(path).bitbucketToken).toBe('tok')
    expect(loadConfig(path).model).toBe('claude-opus-4-8')
  })

  it('GET /api/skills lists scanned skills', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({ method: 'GET', url: '/api/skills' })
    expect(res.json().map((s: any) => s.name)).toEqual(['review-code'])
  })

  it('POST /api/runs rejects an invalid URL with 400', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://github.com/a/b/pull/1', skills: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Invalid PR URL/)
  })

  it('GET /api/runs/:id returns 404 for unknown run', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({ method: 'GET', url: '/api/runs/nope' })
    expect(res.statusCode).toBe(404)
  })
})
```

(The full run lifecycle — Bitbucket fetch, clone, agent — is covered by the smoke script in Task 14; this test covers routing, validation, and config semantics, which is where regressions bite.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/app.test.ts`
Expected: FAIL — cannot find module `../src/app.js`

- [ ] **Step 3: Write the implementation**

`server/src/app.ts`:

```ts
import { EventEmitter } from 'node:events'
import Fastify, { type FastifyInstance } from 'fastify'
import { BitbucketAuthError, BitbucketClient } from './bitbucket/client.js'
import { parsePrUrl } from './bitbucket/parsePrUrl.js'
import { DEFAULT_CONFIG_PATH, loadConfig, saveConfig, type Config } from './config.js'
import { RepoCache } from './repos/cache.js'
import { countDiffLines } from './review/findings.js'
import { runReview, sdkQuery, type AgentQuery } from './review/runner.js'
import { readSkillContent, scanSkillDirs } from './skills/scanner.js'
import { RunStore } from './store/runs.js'
import type { RunEvent, RunRecord } from './types.js'

const MASK = '***'

export function buildApp(deps: { configPath?: string; agentQuery?: AgentQuery } = {}): FastifyInstance {
  const configPath = deps.configPath ?? DEFAULT_CONFIG_PATH
  const agentQuery = deps.agentQuery ?? sdkQuery
  const app = Fastify()
  const events = new EventEmitter()
  let queue: Promise<void> = Promise.resolve()

  const cfg = (): Config => loadConfig(configPath)
  const store = (): RunStore => new RunStore(cfg().runsDir)

  app.get('/api/config', async () => {
    const c = cfg()
    return { ...c, bitbucketToken: c.bitbucketToken ? MASK : '' }
  })

  app.put('/api/config', async (req) => {
    const incoming = req.body as Config
    const current = cfg()
    if (incoming.bitbucketToken === MASK) incoming.bitbucketToken = current.bitbucketToken
    saveConfig(incoming, configPath)
    return { ok: true }
  })

  app.get('/api/skills', async () => scanSkillDirs(cfg().skillDirs))

  app.get('/api/runs', async () => store().list())

  app.get('/api/runs/:id', async (req, reply) => {
    const run = store().get((req.params as any).id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    return run
  })

  app.post('/api/runs', async (req, reply) => {
    const body = req.body as { url: string; skills: string[]; focus?: string; force?: boolean }
    const c = cfg()
    let pr
    try {
      pr = parsePrUrl(body.url)
    } catch (err: any) {
      return reply.code(400).send({ error: err.message })
    }
    const client = new BitbucketClient(c.bitbucketEmail, c.bitbucketToken)
    let meta, diff
    try {
      meta = await client.getPullRequest(pr)
      diff = await client.getDiff(pr)
    } catch (err: any) {
      const code = err instanceof BitbucketAuthError ? 401 : 502
      return reply.code(code).send({ error: err.message })
    }
    const diffLines = countDiffLines(diff)
    if (diffLines > c.diffWarnLines && !body.force) {
      return reply.code(409).send({
        error: `Diff has ${diffLines} changed lines (threshold ${c.diffWarnLines}). Re-submit with force to proceed.`,
        diffLines,
      })
    }
    const run = store().create({
      pr,
      prTitle: meta.title,
      skills: body.skills,
      focus: body.focus,
      status: 'queued',
    })
    queue = queue.then(() => executeRun(run.id, { pr, meta, diff, body }))
    return reply.code(202).send({ id: run.id })
  })

  async function executeRun(
    runId: string,
    ctx: { pr: any; meta: any; diff: string; body: { skills: string[]; focus?: string } },
  ): Promise<void> {
    const c = cfg()
    const s = store()
    const run = s.get(runId)
    if (!run) return
    const emit = (e: RunEvent) => {
      run.transcript.push(e)
      s.save(run)
      events.emit(runId, e)
    }
    try {
      run.status = 'running'
      s.save(run)
      emit({ kind: 'status', text: 'Preparing repository checkout…', at: new Date().toISOString() })
      const client = new BitbucketClient(c.bitbucketEmail, c.bitbucketToken)
      const cache = new RepoCache(c.cacheDir)
      const cwd = await cache.ensureCheckout(ctx.pr, {
        cloneUrl: client.cloneUrl(ctx.pr),
        sourceBranch: ctx.meta.sourceBranch,
        commit: ctx.meta.sourceCommit,
      })
      emit({ kind: 'status', text: 'Starting review agent…', at: new Date().toISOString() })
      const all = scanSkillDirs(c.skillDirs)
      const skills = all
        .filter((sk) => ctx.body.skills.includes(sk.name))
        .map((sk) => ({ name: sk.name, content: readSkillContent(sk) }))
      run.findings = await runReview(
        { meta: ctx.meta, diff: ctx.diff, skills, focus: ctx.body.focus, cwd, model: c.model },
        emit,
        agentQuery,
      )
      run.status = 'completed'
    } catch (err: any) {
      run.status = 'failed'
      run.error = err.message
      emit({ kind: 'error', text: err.message, at: new Date().toISOString() })
    } finally {
      run.finishedAt = new Date().toISOString()
      s.save(run)
      events.emit(runId, { kind: 'done' })
    }
  }

  app.get('/api/runs/:id/events', (req, reply) => {
    const id = (req.params as any).id as string
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const send = (e: RunEvent | { kind: 'done' }) => {
      if (e.kind === 'done') {
        reply.raw.write('event: done\ndata: {}\n\n')
        reply.raw.end()
        events.removeListener(id, send)
      } else {
        reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
      }
    }
    events.on(id, send)
    const run = new RunStore(cfg().runsDir).get(id)
    if (run && run.status !== 'running' && run.status !== 'queued') send({ kind: 'done' })
    req.raw.on('close', () => events.removeListener(id, send))
  })

  app.post('/api/runs/:id/comments', async (req, reply) => {
    const id = (req.params as any).id as string
    const { findingIndexes } = req.body as { findingIndexes: number[] }
    const s = store()
    const run = s.get(id)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    const c = cfg()
    const client = new BitbucketClient(c.bitbucketEmail, c.bitbucketToken)
    const posted: number[] = []
    for (const i of findingIndexes) {
      const f = run.findings[i]
      if (!f) continue
      const text = `**[AI review — ${f.severity}/${f.category}]** ${f.summary}\n\n${f.detail}\n\n**Suggestion:** ${f.suggestion}`
      posted.push(await client.postInlineComment(run.pr, { path: f.file, line: f.line, text }))
    }
    run.postedCommentIds.push(...posted)
    s.save(run)
    return { posted }
  })

  app.delete('/api/cache/:workspace/:repo', async (req) => {
    const { workspace, repo } = req.params as { workspace: string; repo: string }
    new RepoCache(cfg().cacheDir).clear({ workspace, repo, id: 0 })
    return { ok: true }
  })

  return app
}
```

`server/src/index.ts`:

```ts
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import { buildApp } from './app.js'

const app = buildApp()
const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
if (existsSync(webDist)) {
  app.register(fastifyStatic, { root: webDist })
}
const port = Number(process.env.PORT ?? 5175)
app.listen({ port, host: '127.0.0.1' }).then(() => {
  console.log(`PR Reviewer running at http://127.0.0.1:${port}`)
})
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: all suites PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/test/app.test.ts
git commit -m "feat: HTTP API with SSE streaming, run queue, and comment posting"
```

---

### Task 11: Web scaffold + API client

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/types.ts`
- Test: `web/test/api.test.ts`

**Interfaces:**
- Consumes: the HTTP API from Task 10
- Produces: `web/src/api.ts` exporting typed functions used by all screens:
  - `getConfig(): Promise<Config>`, `putConfig(c: Config): Promise<void>`
  - `getSkills(): Promise<SkillInfo[]>`
  - `listRuns(): Promise<RunRecord[]>`, `getRun(id: string): Promise<RunRecord>`
  - `createRun(input: { url: string; skills: string[]; focus?: string; force?: boolean }): Promise<{ id?: string; error?: string; diffLines?: number; status: number }>`
  - `postComments(id: string, findingIndexes: number[]): Promise<number[]>`
  - `clearRepoCache(workspace: string, repo: string): Promise<void>`
  - `subscribeRun(id: string, onEvent: (e: RunEvent) => void, onDone: () => void): () => void` — wraps `EventSource`, returns unsubscribe.
  - `web/src/types.ts` mirrors the server's `Finding`, `RunRecord`, `RunEvent`, `SkillInfo`, `Config` shapes (copy the definitions from `server/src/types.ts` plus `Config` from Task 2).

- [ ] **Step 1: Scaffold the web package**

`web/package.json`:

```json
{
  "name": "pr-reviewer-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

`web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:5175' } },
  test: { include: ['test/**/*.test.ts'] },
})
```

`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src", "test"]
}
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PR Reviewer</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/types.ts`: copy `PrRef`, `Severity`, `Finding`, `RunStatus`, `RunEvent`, `RunRecord`, `SkillInfo` verbatim from `server/src/types.ts`, and add:

```ts
export interface Config {
  bitbucketEmail: string
  bitbucketToken: string
  skillDirs: string[]
  model: string
  cacheDir: string
  runsDir: string
  diffWarnLines: number
}
```

Run: `cd web && npm install`
Expected: installs cleanly.

- [ ] **Step 2: Write the failing test**

`web/test/api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRun } from '../src/api.js'

afterEach(() => vi.unstubAllGlobals())

describe('createRun', () => {
  it('returns id on 202', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'r1' }), { status: 202 })))
    expect(await createRun({ url: 'u', skills: [] })).toEqual({ id: 'r1', status: 202 })
  })

  it('returns error payload on 409 oversized diff', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'big', diffLines: 9001 }), { status: 409 })),
    )
    const r = await createRun({ url: 'u', skills: [] })
    expect(r.status).toBe(409)
    expect(r.diffLines).toBe(9001)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run`
Expected: FAIL — cannot find module `../src/api.js`

- [ ] **Step 4: Write the implementation**

`web/src/api.ts`:

```ts
import type { Config, RunEvent, RunRecord, SkillInfo } from './types.js'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(((await res.json()) as any).error ?? `HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export const getConfig = () => fetch('/api/config').then((r) => json<Config>(r))
export const putConfig = (c: Config) =>
  fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c),
  }).then((r) => json<{ ok: boolean }>(r).then(() => undefined))

export const getSkills = () => fetch('/api/skills').then((r) => json<SkillInfo[]>(r))
export const listRuns = () => fetch('/api/runs').then((r) => json<RunRecord[]>(r))
export const getRun = (id: string) => fetch(`/api/runs/${id}`).then((r) => json<RunRecord>(r))

export async function createRun(input: {
  url: string
  skills: string[]
  focus?: string
  force?: boolean
}): Promise<{ id?: string; error?: string; diffLines?: number; status: number }> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json()) as any
  return { ...body, status: res.status }
}

export const postComments = (id: string, findingIndexes: number[]) =>
  fetch(`/api/runs/${id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findingIndexes }),
  })
    .then((r) => json<{ posted: number[] }>(r))
    .then((r) => r.posted)

export const clearRepoCache = (workspace: string, repo: string) =>
  fetch(`/api/cache/${workspace}/${repo}`, { method: 'DELETE' }).then(() => undefined)

export function subscribeRun(
  id: string,
  onEvent: (e: RunEvent) => void,
  onDone: () => void,
): () => void {
  const es = new EventSource(`/api/runs/${id}/events`)
  es.onmessage = (m) => onEvent(JSON.parse(m.data) as RunEvent)
  es.addEventListener('done', () => {
    es.close()
    onDone()
  })
  return () => es.close()
}
```

`web/src/main.tsx`:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

`web/src/App.tsx` (placeholder shell; screens land in Tasks 12–13):

```tsx
export function App() {
  return <h1>PR Reviewer</h1>
}
```

- [ ] **Step 5: Run tests and build**

Run: `cd web && npx vitest run && npm run build`
Expected: tests PASS, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web
git commit -m "feat: web scaffold with typed API client"
```

---

### Task 12: New Review screen + app shell routing

**Files:**
- Create: `web/src/screens/NewReview.tsx`, `web/src/styles.css`
- Modify: `web/src/App.tsx`, `web/src/main.tsx` (import styles)
- Test: `web/test/grouping.test.ts` (pure helpers), plus manual verify

**Interfaces:**
- Consumes: `getSkills`, `listRuns`, `createRun` from `api.ts`
- Produces:
  - `App` with hash-based routing: `#/` → NewReview, `#/runs/:id` → RunView (Task 13), `#/settings` → Settings (Task 13). Export `parseRoute(hash: string): { screen: 'new' } | { screen: 'run'; id: string } | { screen: 'settings' }` from `App.tsx` so it's testable.
  - `groupSkillsBySource(skills: SkillInfo[]): Map<string, SkillInfo[]>` exported from `NewReview.tsx`.

- [ ] **Step 1: Write the failing test**

`web/test/grouping.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseRoute } from '../src/App.js'
import { groupSkillsBySource } from '../src/screens/NewReview.js'

describe('parseRoute', () => {
  it('routes hashes to screens', () => {
    expect(parseRoute('')).toEqual({ screen: 'new' })
    expect(parseRoute('#/')).toEqual({ screen: 'new' })
    expect(parseRoute('#/runs/abc')).toEqual({ screen: 'run', id: 'abc' })
    expect(parseRoute('#/settings')).toEqual({ screen: 'settings' })
    expect(parseRoute('#/junk')).toEqual({ screen: 'new' })
  })
})

describe('groupSkillsBySource', () => {
  it('groups by source dir preserving order', () => {
    const a = { name: 'x', description: '', dir: '/s1/x', source: '/s1' }
    const b = { name: 'y', description: '', dir: '/s2/y', source: '/s2' }
    const c = { name: 'z', description: '', dir: '/s1/z', source: '/s1' }
    const g = groupSkillsBySource([a, b, c])
    expect([...g.keys()]).toEqual(['/s1', '/s2'])
    expect(g.get('/s1')!.map((s) => s.name)).toEqual(['x', 'z'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run test/grouping.test.ts`
Expected: FAIL — `parseRoute` / `groupSkillsBySource` not exported.

- [ ] **Step 3: Write the implementation**

`web/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { NewReview } from './screens/NewReview.js'
import { RunView } from './screens/RunView.js'
import { Settings } from './screens/Settings.js'

export type Route = { screen: 'new' } | { screen: 'run'; id: string } | { screen: 'settings' }

export function parseRoute(hash: string): Route {
  const run = /^#\/runs\/(.+)$/.exec(hash)
  if (run) return { screen: 'run', id: run[1] }
  if (hash === '#/settings') return { screen: 'settings' }
  return { screen: 'new' }
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute(window.location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return (
    <div className="app">
      <header>
        <a href="#/">PR Reviewer</a>
        <a href="#/settings">Settings</a>
      </header>
      {route.screen === 'new' && <NewReview />}
      {route.screen === 'run' && <RunView id={route.id} />}
      {route.screen === 'settings' && <Settings />}
    </div>
  )
}
```

Note: `RunView.tsx` and `Settings.tsx` don't exist yet — create minimal placeholders now so this compiles; Task 13 fills them in:

```tsx
// web/src/screens/RunView.tsx (placeholder)
export function RunView({ id }: { id: string }) {
  return <p>Run {id}</p>
}
```

```tsx
// web/src/screens/Settings.tsx (placeholder)
export function Settings() {
  return <p>Settings</p>
}
```

`web/src/screens/NewReview.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { createRun, getSkills, listRuns } from '../api.js'
import type { RunRecord, SkillInfo } from '../types.js'

export function groupSkillsBySource(skills: SkillInfo[]): Map<string, SkillInfo[]> {
  const g = new Map<string, SkillInfo[]>()
  for (const s of skills) {
    if (!g.has(s.source)) g.set(s.source, [])
    g.get(s.source)!.push(s)
  }
  return g
}

const LAST_SKILLS_KEY = 'pr-reviewer.lastSkills'

export function NewReview() {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem(LAST_SKILLS_KEY) ?? '[]')),
  )
  const [url, setUrl] = useState('')
  const [focus, setFocus] = useState('')
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [error, setError] = useState('')
  const [oversized, setOversized] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getSkills().then(setSkills).catch((e) => setError(e.message))
    listRuns().then(setRuns).catch(() => {})
  }, [])

  function toggle(name: string) {
    const next = new Set(selected)
    next.has(name) ? next.delete(name) : next.add(name)
    setSelected(next)
    localStorage.setItem(LAST_SKILLS_KEY, JSON.stringify([...next]))
  }

  async function submit(force = false) {
    setBusy(true)
    setError('')
    setOversized(null)
    const res = await createRun({ url, skills: [...selected], focus: focus || undefined, force })
    setBusy(false)
    if (res.id) window.location.hash = `#/runs/${res.id}`
    else if (res.status === 409) setOversized(res.diffLines ?? 0)
    else setError(res.error ?? 'Failed to start run')
  }

  return (
    <main>
      <h2>New Review</h2>
      <input
        placeholder="https://bitbucket.org/workspace/repo/pull-requests/123"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      {[...groupSkillsBySource(skills)].map(([source, group]) => (
        <fieldset key={source}>
          <legend>{source}</legend>
          {group.map((s) => (
            <label key={s.dir} title={s.description}>
              <input
                type="checkbox"
                checked={selected.has(s.name)}
                onChange={() => toggle(s.name)}
              />
              {s.name}
            </label>
          ))}
        </fieldset>
      ))}
      <textarea
        placeholder="Optional focus, e.g. “pay attention to date handling”"
        value={focus}
        onChange={(e) => setFocus(e.target.value)}
      />
      <button disabled={busy || !url} onClick={() => submit()}>
        {busy ? 'Starting…' : 'Run Review'}
      </button>
      {error && <p className="error">{error}</p>}
      {oversized !== null && (
        <p className="warn">
          Large diff ({oversized} changed lines) — this may be slow and costly.{' '}
          <button onClick={() => submit(true)}>Proceed anyway</button>
        </p>
      )}
      <h3>Recent runs</h3>
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            <a href={`#/runs/${r.id}`}>
              [{r.status}] {r.prTitle} — {r.pr.workspace}/{r.pr.repo}#{r.pr.id}
            </a>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

`web/src/styles.css` (import it in `main.tsx`: `import './styles.css'`):

```css
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; }
.app { max-width: 860px; margin: 0 auto; padding: 0 1rem 3rem; }
header { display: flex; justify-content: space-between; padding: 1rem 0; border-bottom: 1px solid #ddd; }
main input, main textarea { display: block; width: 100%; box-sizing: border-box; margin: 0.35rem 0 0.9rem; padding: 0.5rem; }
fieldset { margin: 0.75rem 0; }
fieldset label { display: inline-flex; align-items: center; gap: 0.3rem; margin-right: 1rem; }
button { padding: 0.5rem 1rem; cursor: pointer; }
.error { color: #c0392b; }
.warn { color: #b9770e; }
.feed { max-height: 20rem; overflow-y: auto; background: #111; color: #ddd; padding: 0.75rem; font-family: monospace; font-size: 0.85rem; }
.feed p { margin: 0.15rem 0; }
.ev-error { color: #ff8a80; }
.sev-high { color: #fff; background: #c0392b; display: inline-block; padding: 0.1rem 0.6rem; border-radius: 4px; }
.sev-medium { color: #fff; background: #b9770e; display: inline-block; padding: 0.1rem 0.6rem; border-radius: 4px; }
.sev-low { color: #fff; background: #2471a3; display: inline-block; padding: 0.1rem 0.6rem; border-radius: 4px; }
.sev-info { color: #333; background: #d5dbdb; display: inline-block; padding: 0.1rem 0.6rem; border-radius: 4px; }
article { border: 1px solid #e0e0e0; border-radius: 6px; padding: 0.6rem 0.9rem; margin: 0.6rem 0; }
article pre { background: #f6f6f6; padding: 0.5rem; overflow-x: auto; }
.confirm { border: 2px solid #b9770e; border-radius: 6px; padding: 0.75rem 1rem; }
```

- [ ] **Step 4: Run tests and build**

Run: `cd web && npx vitest run && npm run build`
Expected: tests PASS, build succeeds.

- [ ] **Step 5: Manual verify**

Run server (`cd server && npm run dev`) and web (`cd web && npm run dev`), open the Vite URL: skills from your configured dirs render grouped with checkboxes; a GitHub URL shows the inline error from the server.

- [ ] **Step 6: Commit**

```bash
git add web
git commit -m "feat: New Review screen with skill picker and recent runs"
```

---

### Task 13: Run view (live feed + report + post comments) and Settings screen

**Files:**
- Modify: `web/src/screens/RunView.tsx`, `web/src/screens/Settings.tsx` (replace placeholders)
- Test: `web/test/report.test.ts`

**Interfaces:**
- Consumes: `getRun`, `subscribeRun`, `postComments`, `getConfig`, `putConfig` from `api.ts`
- Produces: `groupFindingsBySeverity(findings: Finding[]): { severity: Severity; items: { finding: Finding; index: number }[] }[]` exported from `RunView.tsx`, ordered high → medium → low → info, empty groups omitted. (`index` is the finding's position in `run.findings` — the API's comment-posting contract.)

- [ ] **Step 1: Write the failing test**

`web/test/report.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { groupFindingsBySeverity } from '../src/screens/RunView.js'
import type { Finding } from '../src/types.js'

const f = (severity: Finding['severity'], file: string): Finding => ({
  file,
  line: 1,
  severity,
  category: 'bug',
  summary: 's',
  detail: 'd',
  suggestion: 'x',
  skill: 'review-code',
})

describe('groupFindingsBySeverity', () => {
  it('orders high→info, keeps original indexes, omits empty groups', () => {
    const groups = groupFindingsBySeverity([f('low', 'a'), f('high', 'b'), f('low', 'c')])
    expect(groups.map((g) => g.severity)).toEqual(['high', 'low'])
    expect(groups[0].items[0].index).toBe(1)
    expect(groups[1].items.map((i) => i.index)).toEqual([0, 2])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run test/report.test.ts`
Expected: FAIL — `groupFindingsBySeverity` not exported.

- [ ] **Step 3: Write the implementation**

`web/src/screens/RunView.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { createRun, getRun, postComments, subscribeRun } from '../api.js'
import type { Finding, RunEvent, RunRecord, Severity } from '../types.js'

const ORDER: Severity[] = ['high', 'medium', 'low', 'info']

export function groupFindingsBySeverity(
  findings: Finding[],
): { severity: Severity; items: { finding: Finding; index: number }[] }[] {
  return ORDER.map((severity) => ({
    severity,
    items: findings
      .map((finding, index) => ({ finding, index }))
      .filter((x) => x.finding.severity === severity),
  })).filter((g) => g.items.length > 0)
}

export function RunView({ id }: { id: string }) {
  const [run, setRun] = useState<RunRecord | null>(null)
  const [live, setLive] = useState<RunEvent[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [posted, setPosted] = useState<number[] | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let unsub = () => {}
    getRun(id).then((r) => {
      setRun(r)
      setLive(r.transcript)
      if (r.status === 'running' || r.status === 'queued') {
        unsub = subscribeRun(
          id,
          (e) => setLive((prev) => [...prev, e]),
          () => getRun(id).then(setRun),
        )
      }
    })
    return () => unsub()
  }, [id])

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [live])

  if (!run) return <p>Loading…</p>
  const active = run.status === 'running' || run.status === 'queued'

  async function post() {
    const ids = await postComments(id, [...checked])
    setPosted(ids)
    setConfirming(false)
  }

  return (
    <main>
      <h2>
        {run.prTitle} <small>({run.status})</small>
      </h2>
      <p>
        {run.pr.workspace}/{run.pr.repo}#{run.pr.id} · skills: {run.skills.join(', ') || 'none'}
      </p>

      {(active || run.status === 'failed') && (
        <div className="feed" ref={feedRef}>
          {live.map((e, i) => (
            <p key={i} className={`ev-${e.kind}`}>
              {e.kind === 'tool' ? '🔧 ' : e.kind === 'error' ? '❌ ' : ''}
              {e.text}
            </p>
          ))}
        </div>
      )}
      {run.status === 'failed' && (
        <>
          <p className="error">Run failed: {run.error}</p>
          <button
            onClick={async () => {
              const res = await createRun({
                url: `https://bitbucket.org/${run.pr.workspace}/${run.pr.repo}/pull-requests/${run.pr.id}`,
                skills: run.skills,
                focus: run.focus,
                force: true,
              })
              if (res.id) window.location.hash = `#/runs/${res.id}`
            }}
          >
            Retry run
          </button>
        </>
      )}

      {run.status === 'completed' && (
        <>
          {run.findings.length === 0 && <p>✅ No findings — the agent had nothing to flag.</p>}
          {groupFindingsBySeverity(run.findings).map((g) => (
            <section key={g.severity}>
              <h3 className={`sev-${g.severity}`}>{g.severity}</h3>
              {g.items.map(({ finding, index }) => (
                <article key={index}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked.has(index)}
                      onChange={() => {
                        const next = new Set(checked)
                        next.has(index) ? next.delete(index) : next.add(index)
                        setChecked(next)
                      }}
                    />
                    <code>
                      {finding.file}:{finding.line}
                    </code>{' '}
                    [{finding.category} · {finding.skill}] {finding.summary}
                  </label>
                  <p>{finding.detail}</p>
                  <pre>{finding.suggestion}</pre>
                </article>
              ))}
            </section>
          ))}
          {run.findings.length > 0 && !confirming && (
            <button disabled={checked.size === 0} onClick={() => setConfirming(true)}>
              Post {checked.size} selected to Bitbucket…
            </button>
          )}
          {confirming && (
            <div className="confirm">
              <p>These comments will be created on the PR:</p>
              <ul>
                {[...checked].map((i) => (
                  <li key={i}>
                    <code>
                      {run.findings[i].file}:{run.findings[i].line}
                    </code>{' '}
                    — {run.findings[i].summary}
                  </li>
                ))}
              </ul>
              <button onClick={post}>Confirm — post to Bitbucket</button>
              <button onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          )}
          {posted && <p>✅ Posted {posted.length} comments.</p>}
        </>
      )}
    </main>
  )
}
```

`web/src/screens/Settings.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { clearRepoCache, getConfig, putConfig } from '../api.js'
import type { Config } from '../types.js'

export function Settings() {
  const [cfg, setCfg] = useState<Config | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getConfig().then(setCfg)
  }, [])
  if (!cfg) return <p>Loading…</p>

  const set = (patch: Partial<Config>) => {
    setCfg({ ...cfg, ...patch })
    setSaved(false)
  }

  return (
    <main>
      <h2>Settings</h2>
      <label>
        Bitbucket email
        <input value={cfg.bitbucketEmail} onChange={(e) => set({ bitbucketEmail: e.target.value })} />
      </label>
      <label>
        Bitbucket API token
        <input
          type="password"
          value={cfg.bitbucketToken}
          onChange={(e) => set({ bitbucketToken: e.target.value })}
          placeholder="*** means unchanged"
        />
      </label>
      <label>
        Skill directories (one per line)
        <textarea
          value={cfg.skillDirs.join('\n')}
          onChange={(e) => set({ skillDirs: e.target.value.split('\n').filter(Boolean) })}
        />
      </label>
      <label>
        Model
        <input value={cfg.model} onChange={(e) => set({ model: e.target.value })} />
      </label>
      <label>
        Diff warning threshold (changed lines)
        <input
          type="number"
          value={cfg.diffWarnLines}
          onChange={(e) => set({ diffWarnLines: Number(e.target.value) })}
        />
      </label>
      <label>
        Clone cache location
        <input value={cfg.cacheDir} onChange={(e) => set({ cacheDir: e.target.value })} />
      </label>
      <button
        onClick={() => putConfig(cfg).then(() => setSaved(true))}
      >
        Save
      </button>
      {saved && <p>✅ Saved.</p>}

      <h3>Clear a cached repo</h3>
      <ClearCache />
    </main>
  )
}

function ClearCache() {
  const [ws, setWs] = useState('')
  const [repo, setRepo] = useState('')
  const [cleared, setCleared] = useState(false)
  return (
    <div>
      <input placeholder="workspace" value={ws} onChange={(e) => setWs(e.target.value)} />
      <input placeholder="repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
      <button
        disabled={!ws || !repo}
        onClick={() => clearRepoCache(ws, repo).then(() => setCleared(true))}
      >
        Clear cache
      </button>
      {cleared && <p>✅ Cache cleared for {ws}/{repo}.</p>}
    </div>
  )
}
```

- [ ] **Step 4: Run tests and build**

Run: `cd web && npx vitest run && npm run build`
Expected: tests PASS, build succeeds.

- [ ] **Step 5: Manual verify**

With both dev servers running: Settings loads/saves config (token shows `***` after reload); a run page shows the live feed then the grouped report.

- [ ] **Step 6: Commit**

```bash
git add web
git commit -m "feat: run view with live feed, findings report, comment posting; settings screen"
```

---

### Task 14: Smoke script, root scripts, README

**Files:**
- Create: `package.json` (repo root), `scripts/smoke.md`, `README.md`
- Test: manual end-to-end

**Interfaces:**
- Consumes: everything
- Produces: `npm start` at repo root runs the production app; documented smoke procedure.

- [ ] **Step 1: Root package.json**

```json
{
  "name": "pr-reviewer",
  "private": true,
  "scripts": {
    "build": "cd web && npm run build",
    "start": "npm run build && cd server && npx tsx src/index.ts",
    "test": "cd server && npm test && cd ../web && npm test"
  }
}
```

- [ ] **Step 2: Smoke procedure**

`scripts/smoke.md`:

```markdown
# End-to-end smoke test (manual, uses real Bitbucket + Claude)

1. `npm start` at repo root → open http://127.0.0.1:5175
2. Settings → enter Bitbucket email + API token → Save.
3. Home → paste a SMALL real PR URL, tick `review-code` only, Run Review.
4. Verify: live feed streams status + tool events; report renders grouped findings
   (or the explicit "no findings" state).
5. Tick one finding → Post to Bitbucket → confirm → check the comment appears
   inline on the PR in the browser.
6. Re-run the same PR: clone step should be fast (cache hit — "Preparing repository
   checkout…" completes in ~1s).
7. Failure path: put a wrong token in Settings, submit a run → the run view shows
   a 401 message pointing at Settings.
```

- [ ] **Step 3: README**

`README.md`: what the tool is (one paragraph), prerequisites (Node 20+, git, Claude Code login or `ANTHROPIC_API_KEY`, Bitbucket API token with `pullrequest:read`, `pullrequest:write`, `repository:read` scopes), quick start (`npm install` in `server/` and `web/`, `npm start`, open Settings first), where data lives (`~/.pr-reviewer/`), and a pointer to `docs/superpowers/specs/` for the design.

- [ ] **Step 4: Full verification**

Run: `npm test` at repo root, then execute `scripts/smoke.md` against a real small PR.
Expected: all unit/integration tests pass; smoke checklist completes.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/smoke.md README.md
git commit -m "chore: root scripts, smoke procedure, README"
```
