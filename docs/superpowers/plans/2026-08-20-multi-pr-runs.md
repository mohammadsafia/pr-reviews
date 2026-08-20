# Multi-PR Concurrent Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user paste several PR URLs of one project and review them concurrently — per-run git worktrees isolate checkouts, a task pool caps concurrency, and the New Review screen batches submissions.

**Architecture:** The base clone per repo stays and is the only place clone/fetch run (serialized by a module-level per-repo mutex); each run gets a disposable `git worktree` under `<cacheDir>/.worktrees/<provider>/<ws>/<repo>/<runId>`, removed in `executeRun`'s finally. The global `SerialQueue` becomes `makeTaskPool` with a live `maxConcurrentRuns` config (default 2). The web client loops the existing `POST /api/runs` per pasted URL — no new server endpoint.

**Tech Stack:** Node 20 + TypeScript ESM (`.js` import suffixes), Fastify, zod, vitest; React + Vite on the web side. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-multi-pr-runs-design.md`

## Global Constraints

- ESM everywhere: relative imports end in `.js` (existing convention). No new npm dependencies.
- `maxConcurrentRuns` default: exactly `2`, minimum `1`.
- Worktree path: exactly `<cacheDir>/.worktrees/<provider>/<workspace>/<repo>/<runId>`.
- The per-repo mutex lives at module level in `cache.ts` (a fresh `RepoCache` is constructed per run — instance state would not be shared).
- `git worktree remove` always uses `--force` (the untracked `.pr-review/` pack would otherwise block removal); findings are already persisted in the run store.
- A worktree-cleanup failure NEVER changes a run's status — transcript note only.
- Batch submission is sequential per URL; one URL's failure never stops the rest.
- Server tests: `cd server && npx vitest run test/<file>` (never from the repo root — root vitest lacks the web alias config). Web tests: `cd web && npx vitest run`. Full suite: `npm test` at repo root.
- Commit after every task; `git add` only the files the task touched.

---

### Task 1: Config field `maxConcurrentRuns`

**Files:**
- Modify: `server/src/config.ts` (schema, after `defaultDepth`)
- Modify: `web/src/types.ts` (`Config` interface)
- Test: `server/test/config.test.ts`

**Interfaces:**
- Produces: `Config.maxConcurrentRuns: number` (int, min 1, default 2). Task 2's pool reads it via `cfg().maxConcurrentRuns`.

- [ ] **Step 1: Write the failing test** — append inside the top-level `describe('config', ...)` block of `server/test/config.test.ts`:

```ts
  describe('maxConcurrentRuns', () => {
    it('defaults to 2 when absent', () => {
      const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
      const path = join(dir, 'config.json')
      writeFileSync(path, JSON.stringify({}))
      expect(loadConfig(path).maxConcurrentRuns).toBe(2)
    })

    it('preserves a stored value and falls back per-field on invalid values', () => {
      const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
      const path = join(dir, 'config.json')
      writeFileSync(path, JSON.stringify({ maxConcurrentRuns: 5 }))
      expect(loadConfig(path).maxConcurrentRuns).toBe(5)
      writeFileSync(path, JSON.stringify({ maxConcurrentRuns: 0 }))
      expect(loadConfig(path).maxConcurrentRuns).toBe(2) // min(1) violated → field default
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/config.test.ts`
Expected: FAIL — `maxConcurrentRuns` is `undefined`.

- [ ] **Step 3: Implement** — in `server/src/config.ts`, after the `defaultDepth` line:

```ts
  maxConcurrentRuns: z.number().int().min(1).default(2),
```

In `web/src/types.ts`, add to `Config` after `defaultDepth`:

```ts
  maxConcurrentRuns: number
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/config.test.ts` — Expected: PASS.
Run: `cd web && npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts web/src/types.ts server/test/config.test.ts
git commit -m "feat: maxConcurrentRuns config field (default 2)"
```

---

### Task 2: Task pool replaces the serial queue

**Files:**
- Modify: `server/src/queue.ts` (full rewrite)
- Modify: `server/src/app.ts` (the `makeSerialQueue` import and the `runQueue` construction, ~line 99)
- Test: `server/test/queue.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `Config.maxConcurrentRuns` (Task 1).
- Produces: `makeTaskPool(getLimit: () => number, onError: (err: unknown) => void): TaskPool` with `TaskPool = { push(fn: () => Promise<void>): void }`. `makeSerialQueue` is DELETED — `app.ts` is its only consumer and switches in this task. `getLimit` is read at every dequeue decision.

- [ ] **Step 1: Rewrite the test** — replace `server/test/queue.test.ts` with (keep the existing `deferred` helper verbatim at the top):

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeTaskPool } from '../src/queue.js'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('makeTaskPool', () => {
  it('runs at most getLimit() tasks at once and starts waiters as slots free', async () => {
    const pool = makeTaskPool(() => 2, () => {})
    const order: string[] = []
    const gates = [deferred(), deferred(), deferred()]
    for (const [i, gate] of gates.entries()) {
      pool.push(async () => {
        order.push(`start-${i}`)
        await gate.promise
        order.push(`end-${i}`)
      })
    }
    await tick()
    expect(order).toEqual(['start-0', 'start-1']) // task 2 held back by the cap
    gates[0].resolve()
    await tick()
    expect(order).toEqual(['start-0', 'start-1', 'end-0', 'start-2'])
    gates[1].resolve()
    gates[2].resolve()
    await tick()
    expect(order).toContain('end-2')
  })

  it('with limit 1 preserves strict push order (the old serial guarantee)', async () => {
    const pool = makeTaskPool(() => 1, () => {})
    const order: string[] = []
    const first = deferred()
    pool.push(async () => {
      order.push('start-1')
      await first.promise
      order.push('end-1')
    })
    pool.push(async () => {
      order.push('start-2')
    })
    await tick()
    expect(order).toEqual(['start-1'])
    first.resolve()
    await tick()
    expect(order).toEqual(['start-1', 'end-1', 'start-2'])
  })

  it('reads getLimit at each dequeue — raising it mid-stream starts more waiters', async () => {
    let limit = 1
    const pool = makeTaskPool(() => limit, () => {})
    const running: string[] = []
    const gate = deferred()
    pool.push(async () => {
      running.push('a')
      await gate.promise
    })
    pool.push(async () => {
      running.push('b')
      await gate.promise
    })
    pool.push(async () => {
      running.push('c')
      await gate.promise
    })
    await tick()
    expect(running).toEqual(['a'])
    limit = 3
    // a raised limit takes effect at the next dequeue — trigger one by pushing
    pool.push(async () => {
      running.push('d')
      await gate.promise
    })
    await tick()
    expect(running).toEqual(['a', 'b', 'c', 'd'])
    gate.resolve()
  })

  it('routes task errors to onError and keeps the pool draining', async () => {
    const onError = vi.fn()
    const pool = makeTaskPool(() => 1, onError)
    const err = new Error('boom')
    pool.push(async () => {
      throw err
    })
    const d = deferred()
    pool.push(async () => {
      d.resolve()
    })
    await d.promise
    await tick()
    expect(onError).toHaveBeenCalledWith(err)
  })

  it('guards a getLimit of 0 or less by running at least one task', async () => {
    const pool = makeTaskPool(() => 0, () => {})
    const d = deferred()
    pool.push(async () => {
      d.resolve()
    })
    await d.promise // resolves only if the task ran despite limit 0
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/queue.test.ts`
Expected: FAIL — `makeTaskPool` not exported.

- [ ] **Step 3: Implement** — replace `server/src/queue.ts` with:

```ts
export interface TaskPool {
  push(fn: () => Promise<void>): void
}

/** Runs pushed tasks with at most getLimit() in flight. getLimit is read at every dequeue
 * decision (never captured), so a config change applies to the next task start without a
 * restart. Task errors go to onError; the pool never stalls on a failed task. */
export function makeTaskPool(getLimit: () => number, onError: (err: unknown) => void): TaskPool {
  const waiting: (() => Promise<void>)[] = []
  let running = 0
  function maybeStart(): void {
    while (running < Math.max(1, getLimit()) && waiting.length > 0) {
      const fn = waiting.shift()!
      running++
      fn()
        .catch(onError)
        .finally(() => {
          running--
          maybeStart()
        })
    }
  }
  return {
    push(fn) {
      waiting.push(fn)
      maybeStart()
    },
  }
}
```

In `server/src/app.ts`: change the import `import { makeSerialQueue } from './queue.js'` to `import { makeTaskPool } from './queue.js'`, and replace the `runQueue` construction:

```ts
  const runQueue = makeTaskPool(() => cfg().maxConcurrentRuns, (err) => app.log.error(err))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/queue.test.ts test/runPipeline.test.ts`
Expected: PASS — pipeline tests still pass (each creates its own app; nothing depends on cross-run serialization).

- [ ] **Step 5: Commit**

```bash
git add server/src/queue.ts server/src/app.ts server/test/queue.test.ts
git commit -m "feat: task pool with live maxConcurrentRuns cap replaces serial queue"
```

---

### Task 3: Worktree-safe context pack

**Files:**
- Modify: `server/src/review/contextPack.ts` (`writeContextPack` exclude logic)
- Test: `server/test/contextPack.test.ts`

**Interfaces:**
- Produces: `ensurePrReviewExcluded(repoRoot: string): void` — adds `.pr-review/` to `<repoRoot>/.git/info/exclude`, silently a no-op when `.git` is missing or not a directory. Task 4's `RepoCache` calls it on the base clone; `writeContextPack` calls it in place of its inline exclude block (so a worktree cwd, whose `.git` is a file, no longer crashes).

- [ ] **Step 1: Write the failing test** — append to the `writeContextPack` describe in `server/test/contextPack.test.ts`:

```ts
  it('skips the exclude write when .git is a file (worktree checkout) without crashing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prr-pack-wt-'))
    const gitPointer = 'gitdir: /elsewhere/.git/worktrees/x\n'
    writeFileSync(join(cwd, '.git'), gitPointer)
    writeContextPack(cwd, meta, diff)
    expect(readFileSync(join(cwd, '.pr-review', 'diff.patch'), 'utf8')).toBe(diff)
    expect(readFileSync(join(cwd, '.git'), 'utf8')).toBe(gitPointer) // pointer untouched
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/contextPack.test.ts`
Expected: FAIL — `mkdirSync` on `.git/info` throws `ENOTDIR`/`EEXIST`.

- [ ] **Step 3: Implement** — in `server/src/review/contextPack.ts`, add `statSync` to the `node:fs` import, add the exported helper, and have `writeContextPack` use it (replacing its trailing exclude block — everything from `const excludePath = ...` to the end of the function):

```ts
/** Adds .pr-review/ to the repo's .git/info/exclude (never a tracked file). No-op when
 * .git is absent or is a worktree's pointer FILE — worktrees share the base clone's
 * exclude via the common git dir, so the base entry covers them. */
export function ensurePrReviewExcluded(repoRoot: string): void {
  const gitDir = join(repoRoot, '.git')
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return
  const excludePath = join(gitDir, 'info', 'exclude')
  mkdirSync(dirname(excludePath), { recursive: true })
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  if (!existing.split('\n').includes('.pr-review/')) {
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
    writeFileSync(excludePath, `${existing}${sep}.pr-review/\n`)
  }
}
```

and end `writeContextPack` with:

```ts
  ensurePrReviewExcluded(cwd)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/contextPack.test.ts`
Expected: PASS, including the two pre-existing exclude tests (their behavior is unchanged — `.git` is a directory there).

- [ ] **Step 5: Commit**

```bash
git add server/src/review/contextPack.ts server/test/contextPack.test.ts
git commit -m "feat: worktree-safe context pack exclude via ensurePrReviewExcluded"
```

---

### Task 4: RepoCache worktree lifecycle

**Files:**
- Modify: `server/src/repos/cache.ts` (delete `ensureCheckout`; add mutex, `worktreeDir`, `ensureWorktree`, `removeWorktree`, `sweepStrandedWorktrees`; extend `clear`)
- Test: `server/test/repoCache.test.ts`

**Interfaces:**
- Consumes: `ensurePrReviewExcluded` (Task 3).
- Produces (Task 5 relies on these exact signatures):
  - `RepoCache.worktreeDir(pr: PrRef, runId: string): string` → `<root>/.worktrees/<provider>/<ws>/<repo>/<runId>`
  - `RepoCache.ensureWorktree(pr: PrRef, opts: { cloneUrl: string; sourceBranch: string; commit: string; runId: string }): Promise<string>`
  - `RepoCache.removeWorktree(pr: PrRef, runId: string): Promise<void>` — never throws for a missing worktree/base
  - `sweepStrandedWorktrees(root: string): void` (module export, synchronous)
  - `ensureCheckout` is DELETED (its only production caller migrates in Task 5; this task updates its tests).

- [ ] **Step 1: Rewrite the tests.** In `server/test/repoCache.test.ts`:

**(a)** Update imports: add `sweepStrandedWorktrees` to the `cache.js` import; add `rmSync` to the `node:fs` import.

**(b)** Retarget the five `ensureCheckout` tests to `ensureWorktree` (the `redactCredentials`, `repoDir`-namespacing, and `clear`-path-escape tests stay untouched):

```ts
  it('clones the base, fetches the PR branch, and checks the commit out in a per-run worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const dir = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'run-1' })
    expect(dir).toBe(join(root, '.worktrees', 'bitbucket', 'ws', 'fixture', 'run-1'))
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('feature\n')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(commit)
    // worktree .git is a pointer FILE, and the base clone's exclude covers .pr-review/
    expect(statSync(join(dir, '.git')).isFile()).toBe(true)
    const base = join(root, 'bitbucket', 'ws', 'fixture')
    expect(readFileSync(join(base, '.git', 'info', 'exclude'), 'utf8')).toContain('.pr-review/')
  })

  it('two runs of the same repo get coexisting worktrees at their own commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const opts = { cloneUrl: origin, sourceBranch: 'feat/x', commit }
    const [a, b] = await Promise.all([
      cache.ensureWorktree(pr, { ...opts, runId: 'run-a' }),
      cache.ensureWorktree(pr, { ...opts, runId: 'run-b' }),
    ])
    expect(a).not.toBe(b)
    expect(git(a, 'rev-parse', 'HEAD')).toBe(commit)
    expect(git(b, 'rev-parse', 'HEAD')).toBe(commit)
  })

  it('reuses the base clone for a second run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const opts = { cloneUrl: origin, sourceBranch: 'feat/x', commit }
    await cache.ensureWorktree(pr, { ...opts, runId: 'r1' })
    const marker = join(root, 'bitbucket', 'ws', 'fixture', 'marker.txt')
    writeFileSync(marker, 'still here means no re-clone')
    await cache.ensureWorktree(pr, { ...opts, runId: 'r2' })
    expect(existsSync(marker)).toBe(true)
  })

  it('self-heals a stale base dir without .git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const repoPath = join(root, 'bitbucket', 'ws', 'fixture')
    mkdirSync(repoPath, { recursive: true })
    writeFileSync(join(repoPath, 'stale.txt'), 'junk')
    const dir = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'r1' })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('feature\n')
    expect(existsSync(join(repoPath, 'stale.txt'))).toBe(false)
  })

  it('surfaces git stderr on failure', async () => {
    const cache = new RepoCache(mkdtempSync(join(tmpdir(), 'prr-cache-')))
    await expect(
      cache.ensureWorktree(pr, { cloneUrl: '/nonexistent/repo', sourceBranch: 'x', commit: 'y', runId: 'r' }),
    ).rejects.toThrow(/git clone failed/)
  })
```

(Add `statSync` to the `node:fs` import for the first test.)

**(c)** Replace the `clear` test and add lifecycle tests:

```ts
  it('clear removes the base clone AND the repo worktree subtree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const wt = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'r1' })
    cache.clear(pr)
    expect(existsSync(join(root, 'bitbucket', 'ws', 'fixture'))).toBe(false)
    expect(existsSync(wt)).toBe(false)
  })

  it('removeWorktree deletes the worktree and is a no-op when it never existed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const wt = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'r1' })
    // an untracked file (like the .pr-review pack) must not block removal
    writeFileSync(join(wt, 'untracked.txt'), 'x')
    await cache.removeWorktree(pr, 'r1')
    expect(existsSync(wt)).toBe(false)
    await cache.removeWorktree(pr, 'never-existed') // must not throw
  })

  it('a removed runId can be reused (stale registration pruned before add)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const opts = { cloneUrl: origin, sourceBranch: 'feat/x', commit }
    const first = await cache.ensureWorktree(pr, { ...opts, runId: 'r1' })
    rmSync(first, { recursive: true, force: true }) // simulate a crash leaving git's registration stale
    const second = await cache.ensureWorktree(pr, { ...opts, runId: 'r1' })
    expect(readFileSync(join(second, 'a.txt'), 'utf8')).toBe('feature\n')
  })

  it('sweepStrandedWorktrees deletes the .worktrees tree and prunes base registrations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prr-cache-'))
    const cache = new RepoCache(root)
    const wt = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'r1' })
    sweepStrandedWorktrees(root)
    expect(existsSync(join(root, '.worktrees'))).toBe(false)
    // registration pruned: the same runId is usable again immediately
    const again = await cache.ensureWorktree(pr, { cloneUrl: origin, sourceBranch: 'feat/x', commit, runId: 'r1' })
    expect(existsSync(again)).toBe(true)
    expect(wt).toBe(again)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/repoCache.test.ts`
Expected: FAIL — new methods missing.

- [ ] **Step 3: Implement** — rewrite the `RepoCache` class portion of `server/src/repos/cache.ts` (keep `redactCredentials` and `git()` as-is; add `readdirSync` and `execFileSync` imports from `node:fs`/`node:child_process`, and import `ensurePrReviewExcluded` from `../review/contextPack.js`):

```ts
/** Serializes git-level work per base repo. Module-level because executeRun constructs a
 * fresh RepoCache per run — instance state would not be shared across concurrent runs. */
const repoLocks = new Map<string, Promise<void>>()

function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn)
  repoLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/** Startup companion to sweepStrandedRuns: delete every leftover per-run worktree dir and
 * prune stale registrations in each base repo, so crashed runs never leak directories. */
export function sweepStrandedWorktrees(root: string): void {
  rmSync(join(root, '.worktrees'), { recursive: true, force: true })
  for (const provider of ['bitbucket', 'github']) {
    const providerDir = join(root, provider)
    if (!existsSync(providerDir)) continue
    for (const ws of readdirSync(providerDir)) {
      const wsDir = join(providerDir, ws)
      for (const repo of readdirSync(wsDir)) {
        const repoDir = join(wsDir, repo)
        if (!existsSync(join(repoDir, '.git'))) continue
        try {
          execFileSync('git', ['worktree', 'prune'], { cwd: repoDir })
        } catch {
          // best-effort: a broken base repo must not stop server startup
        }
      }
    }
  }
}

export class RepoCache {
  constructor(private root: string) {}

  repoDir(pr: PrRef): string {
    return join(this.root, pr.provider, pr.workspace, pr.repo)
  }

  worktreeDir(pr: PrRef, runId: string): string {
    return join(this.root, '.worktrees', pr.provider, pr.workspace, pr.repo, runId)
  }

  /** Ensures the base clone (clone/fetch serialized per repo), then checks the commit out
   * into a per-run worktree. Returns the worktree path. */
  async ensureWorktree(
    pr: PrRef,
    opts: { cloneUrl: string; sourceBranch: string; commit: string; runId: string },
  ): Promise<string> {
    const base = this.repoDir(pr)
    const wt = this.worktreeDir(pr, opts.runId)
    return withRepoLock(base, async () => {
      if (!existsSync(join(base, '.git'))) {
        rmSync(base, { recursive: true, force: true })
        mkdirSync(join(this.root, pr.provider, pr.workspace), { recursive: true })
        await git(undefined, 'clone', ['clone', '--depth', '50', opts.cloneUrl, base])
      }
      ensurePrReviewExcluded(base)
      await git(base, 'fetch', ['fetch', '--depth', '50', 'origin', opts.sourceBranch])
      // A crashed run may have left the dir or a stale registration — clear both first.
      rmSync(wt, { recursive: true, force: true })
      await git(base, 'worktree prune', ['worktree', 'prune'])
      mkdirSync(join(this.root, '.worktrees', pr.provider, pr.workspace, pr.repo), { recursive: true })
      await git(base, 'worktree add', ['worktree', 'add', '--detach', wt, opts.commit])
      return wt
    })
  }

  /** Removes a run's worktree. --force because the machine-managed tree may hold the
   * untracked .pr-review pack; findings live in the run store. Never throws for a missing
   * worktree or base. */
  async removeWorktree(pr: PrRef, runId: string): Promise<void> {
    const base = this.repoDir(pr)
    const wt = this.worktreeDir(pr, runId)
    await withRepoLock(base, async () => {
      if (existsSync(join(base, '.git'))) {
        if (existsSync(wt)) await git(base, 'worktree remove', ['worktree', 'remove', '--force', wt])
        await git(base, 'worktree prune', ['worktree', 'prune'])
      } else {
        rmSync(wt, { recursive: true, force: true })
      }
    })
  }

  clear(pr: PrRef): void {
    const root = resolve(this.root)
    const dir = resolve(this.repoDir(pr))
    const rel = relative(root, dir)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Refusing to clear a path outside the cache root: ${dir}`)
    }
    rmSync(dir, { recursive: true, force: true })
    const wtDir = resolve(join(this.root, '.worktrees', pr.provider, pr.workspace, pr.repo))
    const wtRel = relative(root, wtDir)
    if (wtRel === '' || wtRel === '..' || wtRel.startsWith(`..${sep}`) || isAbsolute(wtRel)) {
      throw new Error(`Refusing to clear a path outside the cache root: ${wtDir}`)
    }
    rmSync(wtDir, { recursive: true, force: true })
  }
}
```

(`ensureCheckout` is deleted.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/repoCache.test.ts`
Expected: PASS. (`runPipeline.test.ts` is now broken — `app.ts` still calls the deleted `ensureCheckout`. TypeScript will flag it; that's Task 5's job. Do not run the full suite green-gate here.)

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/cache.ts server/test/repoCache.test.ts
git commit -m "feat: per-run git worktrees with per-repo mutex in RepoCache"
```

---

### Task 5: Orchestration — worktrees in executeRun, startup sweep, concurrency tests

**Files:**
- Modify: `server/src/app.ts` (imports; `sweepStrandedWorktrees` at startup; `executeRun` checkout + finally)
- Test: `server/test/runPipeline.test.ts`

**Interfaces:**
- Consumes: `ensureWorktree` / `removeWorktree` / `sweepStrandedWorktrees` (Task 4), pool (Task 2).
- Produces: runs execute in per-run worktrees, cleaned up in `finally`; a cleanup failure appends a `status` transcript event and never changes run status.

- [ ] **Step 1: Write the failing tests** — append to `server/test/runPipeline.test.ts` (add a `deferred` helper near the top, copied from `queue.test.ts`, and add `saveConfig`+`loadConfig` usage as shown):

```ts
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
```

```ts
  it('runs two PRs of the same repo concurrently in isolated worktrees (agent phases overlap)', async () => {
    const path = tempConfig()
    const diff = '+line1\n'
    const finding = {
      file: 'a.txt', line: 1, severity: 'low', category: 'style',
      summary: 's', detail: 'd', suggestion: 'x', skill: 'general',
    }
    let reviewStarts = 0
    const bothStarted = deferred()
    // Each review session blocks until BOTH runs' sessions have started — the test can only
    // pass if the two runs' agent phases truly overlap.
    const agent: AgentQuery = async function* () {
      reviewStarts++
      if (reviewStarts >= 2) bothStarted.resolve()
      await bothStarted.promise
      yield { type: 'result' as const, ok: true, text: '```json\n' + JSON.stringify([finding]) + '\n```' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, diff),
      agentQuery: agent,
    })
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], verify: false },
    })
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/2', skills: [], verify: false },
    })
    const run1 = await pollRun(app, res1.json().id)
    const run2 = await pollRun(app, res2.json().id)
    expect(run1.status).toBe('completed')
    expect(run2.status).toBe('completed')
    expect(run1.findings).toHaveLength(1)
    expect(run2.findings).toHaveLength(1)
  })

  it('holds the second run queued when maxConcurrentRuns is 1', async () => {
    const path = tempConfig()
    const cfgObj = loadConfig(path)
    cfgObj.maxConcurrentRuns = 1
    saveConfig(cfgObj, path)
    const gate = deferred()
    const agent: AgentQuery = async function* () {
      await gate.promise
      yield { type: 'result' as const, ok: true, text: '```json\n[]\n```' }
    }
    const app = buildApp({
      configPath: path,
      clientFactory: () => fakeClient({ ...meta, sourceCommit: commit }, '+x\n'),
      agentQuery: agent,
    })
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/1', skills: [], verify: false },
    })
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://bitbucket.org/ws/repo/pull-requests/2', skills: [], verify: false },
    })
    // give run 1 time to start; run 2 must still be queued behind the cap
    await new Promise((r) => setTimeout(r, 150))
    const r1 = (await app.inject({ method: 'GET', url: `/api/runs/${res1.json().id}` })).json()
    const r2 = (await app.inject({ method: 'GET', url: `/api/runs/${res2.json().id}` })).json()
    expect(r1.status).toBe('running')
    expect(r2.status).toBe('queued')
    gate.resolve()
    expect((await pollRun(app, res1.json().id)).status).toBe('completed')
    expect((await pollRun(app, res2.json().id)).status).toBe('completed')
  })
```

(`loadConfig`/`saveConfig` are already imported in this file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/runPipeline.test.ts`
Expected: FAIL — `app.ts` still calls the deleted `ensureCheckout` (compile error).

- [ ] **Step 3: Implement** — in `server/src/app.ts`:

**(a)** Change the cache import to `import { RepoCache, sweepStrandedWorktrees } from './repos/cache.js'`, and after the existing `sweepStrandedRuns(cfg().runsDir)` line add:

```ts
  sweepStrandedWorktrees(cfg().cacheDir)
```

**(b)** In `executeRun`, hoist the cache so `finally` can reach it — above the `try`, next to `let s`/`let run`:

```ts
    let cache: RepoCache | undefined
```

change the checkout lines inside the `try` to:

```ts
      cache = new RepoCache(c.cacheDir)
      const cwd = await cache.ensureWorktree(ctx.pr, {
        cloneUrl: client.cloneUrl(ctx.pr, c.cloneProtocol),
        sourceBranch: ctx.meta.sourceBranch,
        commit: ctx.meta.sourceCommit,
        runId,
      })
```

**(c)** Extend the `finally` block — worktree cleanup runs before the final save so a failure note lands in the persisted transcript:

```ts
    } finally {
      if (cache) {
        try {
          await cache.removeWorktree(ctx.pr, runId)
        } catch (err: any) {
          // Cleanup must never change the run's outcome; the startup sweep is the backstop.
          if (run) run.transcript.push({ kind: 'status', text: `Worktree cleanup failed: ${err.message}`, at: new Date().toISOString() })
        }
      }
      if (s && run) {
        run.finishedAt = new Date().toISOString()
        s.save(run)
      }
      events.emit(runId, { kind: 'done' })
    }
```

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npx vitest run`
Expected: PASS — all suites, including the two new concurrency tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/test/runPipeline.test.ts
git commit -m "feat: runs execute in per-run worktrees with startup sweep and pool concurrency"
```

---

### Task 6: Batch helpers (web)

**Files:**
- Create: `web/src/lib/urls.ts`
- Create: `web/src/lib/batch.ts`
- Test: `web/test/urls.test.ts`, `web/test/batch.test.ts`

**Interfaces:**
- Produces (Task 7 consumes):
  - `parsePrUrlLines(text: string): string[]` — split lines, trim, drop empties, dedupe preserving first-seen order.
  - `type BatchOutcome = { url: string; kind: 'started'; id: string } | { url: string; kind: 'oversized'; diffLines: number } | { url: string; kind: 'error'; message: string }`
  - `submitBatch(urls: string[], opts: { skills: string[]; focus?: string; verify: boolean; depth?: 'thorough' | 'balanced' | 'economy'; force?: boolean }, createRunFn: typeof createRun): Promise<BatchOutcome[]>` — sequential; one URL's failure never stops the rest.

- [ ] **Step 1: Write the failing tests** — create `web/test/urls.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parsePrUrlLines } from '../src/lib/urls.js'

describe('parsePrUrlLines', () => {
  it('splits lines, trims whitespace, and drops empties', () => {
    expect(parsePrUrlLines('  https://a/1  \n\nhttps://b/2\n   \n')).toEqual(['https://a/1', 'https://b/2'])
  })
  it('dedupes preserving first-seen order', () => {
    expect(parsePrUrlLines('https://a/1\nhttps://b/2\nhttps://a/1')).toEqual(['https://a/1', 'https://b/2'])
  })
  it('returns [] for empty input', () => {
    expect(parsePrUrlLines('')).toEqual([])
    expect(parsePrUrlLines('  \n \n')).toEqual([])
  })
})
```

and `web/test/batch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { submitBatch } from '../src/lib/batch.js'

const opts = { skills: ['a'], verify: true, depth: 'balanced' as const }

describe('submitBatch', () => {
  it('maps started, oversized, and error outcomes per URL and continues past failures', async () => {
    const calls: string[] = []
    const fake = async (input: { url: string }) => {
      calls.push(input.url)
      if (input.url === 'u1') return { id: 'run-1', status: 202 }
      if (input.url === 'u2') return { status: 409, diffLines: 9001, error: 'too big' }
      return { status: 500, error: 'kaput' }
    }
    const out = await submitBatch(['u1', 'u2', 'u3'], opts, fake as any)
    expect(calls).toEqual(['u1', 'u2', 'u3'])
    expect(out).toEqual([
      { url: 'u1', kind: 'started', id: 'run-1' },
      { url: 'u2', kind: 'oversized', diffLines: 9001 },
      { url: 'u3', kind: 'error', message: 'kaput' },
    ])
  })

  it('passes the shared options and force flag through to every call', async () => {
    const seen: any[] = []
    const fake = async (input: any) => {
      seen.push(input)
      return { id: 'x', status: 202 }
    }
    await submitBatch(['u1'], { ...opts, force: true }, fake as any)
    expect(seen[0]).toEqual({ url: 'u1', skills: ['a'], verify: true, depth: 'balanced', force: true })
  })

  it('defaults a missing error message', async () => {
    const fake = async () => ({ status: 0 })
    const out = await submitBatch(['u1'], opts, fake as any)
    expect(out[0]).toEqual({ url: 'u1', kind: 'error', message: 'Failed to start run' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/urls.test.ts test/batch.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement** — create `web/src/lib/urls.ts`:

```ts
/** Splits a textarea's content into PR URLs: one per line, trimmed, empties dropped,
 * duplicates removed preserving first-seen order. */
export function parsePrUrlLines(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split('\n')) {
    const url = line.trim()
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}
```

and `web/src/lib/batch.ts`:

```ts
import type { createRun } from '../api.js'

export type BatchOutcome =
  | { url: string; kind: 'started'; id: string }
  | { url: string; kind: 'oversized'; diffLines: number }
  | { url: string; kind: 'error'; message: string }

/** Submits one run per URL, sequentially — each POST makes the server fetch PR meta and
 * diff from the provider, so a serial loop keeps the burst polite. One URL's failure
 * never stops the rest. */
export async function submitBatch(
  urls: string[],
  opts: {
    skills: string[]
    focus?: string
    verify: boolean
    depth?: 'thorough' | 'balanced' | 'economy'
    force?: boolean
  },
  createRunFn: typeof createRun,
): Promise<BatchOutcome[]> {
  const out: BatchOutcome[] = []
  for (const url of urls) {
    const res = await createRunFn({ url, ...opts })
    if (res.id) out.push({ url, kind: 'started', id: res.id })
    else if (res.status === 409) out.push({ url, kind: 'oversized', diffLines: res.diffLines ?? 0 })
    else out.push({ url, kind: 'error', message: res.error ?? 'Failed to start run' })
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run test/urls.test.ts test/batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/urls.ts web/src/lib/batch.ts web/test/urls.test.ts web/test/batch.test.ts
git commit -m "feat: batch URL parsing and sequential batch submission helpers"
```

---

### Task 7: Batch submission UI (NewReview)

**Files:**
- Modify: `web/src/pages/NewReview.tsx`

**Interfaces:**
- Consumes: `parsePrUrlLines`, `submitBatch`, `BatchOutcome` (Task 6); existing `createRun`, `listRuns`.

- [ ] **Step 1: Implement** (behavior is covered by Task 6's helper tests; this task is wiring + typecheck + build — the repo has no component-render test rig):

**(a)** Imports: add `Textarea` is already imported; add `import { parsePrUrlLines } from '../lib/urls.js'` and `import { submitBatch, type BatchOutcome } from '../lib/batch.js'`.

**(b)** State: remove `const [oversized, setOversized] = useState<number | null>(null)`; add:

```ts
  const [results, setResults] = useState<BatchOutcome[]>([])
```

**(c)** Derive the parsed URLs from the existing `url` state (which becomes the textarea's value):

```ts
  const urls = useMemo(() => parsePrUrlLines(url), [url])
```

**(d)** Replace `submit` with:

```ts
  async function submit(forceUrl?: string) {
    setBusy(true)
    setError('')
    const targets = forceUrl ? [forceUrl] : urls
    try {
      const opts = {
        skills: [...selected],
        focus: focus || undefined,
        verify,
        depth: depth ?? undefined,
        force: forceUrl !== undefined,
      }
      const outcomes = await submitBatch(targets, opts, createRun)
      if (!forceUrl && urls.length === 1 && outcomes[0].kind === 'started') {
        navigate(`/runs/${outcomes[0].id}`)
        return
      }
      // merge: a forced resubmit replaces that URL's previous row
      setResults((prev) => [...prev.filter((r) => !targets.includes(r.url)), ...outcomes])
      listRuns().then(setRuns).catch(() => {})
    } finally {
      setBusy(false)
    }
  }
```

**(e)** Replace the URL `Input` + button block: the `Input` becomes

```tsx
          <Textarea
            className="min-h-24 font-family-mono text-sm sm:flex-1"
            placeholder={'https://bitbucket.org/workspace/repo/pull-requests/123\nhttps://bitbucket.org/workspace/repo/pull-requests/124'}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
```

the button's `disabled` becomes `busy || urls.length === 0` and its label:

```tsx
            {busy ? 'Starting…' : urls.length > 1 ? `Run ${urls.length} reviews` : 'Run review'}
```

and the hint line under the field becomes:

```tsx
        <p className="text-muted-foreground text-xs">
          One Bitbucket or GitHub PR URL per line · {urls.length} PR{urls.length === 1 ? '' : 's'} ·{' '}
          {selected.size} of {skills.length} skills selected
        </p>
```

**(f)** Replace the old `{oversized !== null && (...)}` alert with the per-URL results list:

```tsx
        {results.length > 0 && (
          <div className="flex flex-col gap-2">
            {results.map((r) => (
              <div key={r.url} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-family-mono min-w-0 truncate text-xs">{r.url}</span>
                {r.kind === 'started' && (
                  <Link to={`/runs/${r.id}`} className="text-primary text-xs font-medium">
                    started — view run
                  </Link>
                )}
                {r.kind === 'oversized' && (
                  <>
                    <span className="text-warning text-xs">{r.diffLines} changed lines — large diff</span>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => submit(r.url)}>
                      Run anyway
                    </Button>
                  </>
                )}
                {r.kind === 'error' && <span className="text-destructive text-xs">{r.message}</span>}
              </div>
            ))}
          </div>
        )}
```

(If the project's Tailwind theme lacks a `text-warning` utility, use `text-muted-foreground` — check `web/src/index.css` for the token and match whatever the oversized alert used before.)

**(g)** Removing the oversized alert may leave `Alert` and `AlertTriangle` imports unused — delete any import the typechecker flags as unused.

- [ ] **Step 2: Typecheck, test, build**

Run: `cd web && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all pass.

- [ ] **Step 3: Manual smoke** — `npm start` at the repo root: paste two PR URLs (or any two lines) and confirm the button reads "Run 2 reviews", a single URL still navigates straight to its run view, and the results list renders rows for failures.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/NewReview.tsx
git commit -m "feat: multi-URL batch submission on the New Review screen"
```

---

### Task 8: Documentation & green-gate

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README** — in Quick Start step 5, change "Paste a Bitbucket Cloud PR URL" to "Paste one or more PR URLs (one per line)". Add a short "Concurrent Runs" subsection under Review Quality: runs execute concurrently up to `maxConcurrentRuns` (config, default 2), excess runs queue; each run checks out into its own disposable git worktree under `~/.pr-reviewer/repos/.worktrees/`, removed when the run finishes (and swept at startup after a crash). Mention in Data Locations that `~/.pr-reviewer/repos/` now also holds per-run worktrees under `.worktrees/`.

- [ ] **Step 2: Full suite green-gate**

Run: `npm test` at the repo root.
Expected: PASS (server + web).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document concurrent runs, worktrees, and batch submission"
```
