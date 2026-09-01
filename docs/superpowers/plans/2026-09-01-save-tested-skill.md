# Save a Tested Skill to Disk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a skill author save a tested skill's exact draft content directly to a local skill directory from the run page, closing the loop A4 (skill test-run) deliberately left open.

**Architecture:** Two new routes in `routes/skills.ts` — `GET /api/skills/local-dirs` (config's `skillDirs` minus GitHub-managed clones) and `POST /api/skills/save` (writes `<dir>/<name>/SKILL.md`, 409-then-`overwrite:true` on collision, the same pattern the oversized-diff gate already uses twice). A "Save skill…" dialog on `RunView.tsx`, shown only for `isTest` runs.

**Tech Stack:** TypeScript, Vitest, Fastify (server); React (web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-save-tested-skill-design.md`

## Global Constraints

- Save only ever targets a directory `GET /api/skills/local-dirs` would return — re-validated server-side on every `POST /api/skills/save` call, never trusted from client-cached state.
- The skill name comes from `parseFrontmatter(content).name`; missing/empty → 400. The parsed name is validated as a safe path segment with the exact same `isSafeCacheSegment` check the cache-clear route already applies — reused, not duplicated.
- An existing file at the target path is never overwritten without `overwrite: true` on the request (409 otherwise).

---

### Task 1: `GET /api/skills/local-dirs` and `POST /api/skills/save`

**Files:**
- Modify: `server/src/routes/skills.ts`
- Test: `server/test/app.test.ts`

**Interfaces:**
- Produces: `GET /api/skills/local-dirs` → `string[]`. `POST /api/skills/save` (body `{ dir: string; content: string; overwrite?: boolean }`) → `{ ok: true; path: string; created: boolean }` at 200, or a 400/409 error body. Task 2 consumes both.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/app.test.ts`, in the `describe('app', ...)` block, directly after the
existing `'POST /api/skill-sources/refresh 400s for a dir that is not GitHub-backed'` test:

```ts
  it('GET /api/skills/local-dirs excludes a GitHub-sourced directory and includes a local one', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const c = loadConfig(path)
    const localDir = c.skillDirs[0]
    const reposDir = join(dirname(c.cacheDir), 'skill-repos')
    const cloneRoot = join(reposDir, 'acme__skills')
    const cloneSkillsDir = join(cloneRoot, 'skills')
    mkdirSync(cloneSkillsDir, { recursive: true })
    mkdirSync(join(cloneRoot, '.git'), { recursive: true })
    c.skillDirs.push(cloneSkillsDir)
    saveConfig(c, path)

    const res = await app.inject({ method: 'GET', url: '/api/skills/local-dirs' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toContain(localDir)
    expect(res.json()).not.toContain(cloneSkillsDir)
  })

  it('POST /api/skills/save creates a new skill directory and file', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const dir = loadConfig(path).skillDirs[0]
    const content = '---\nname: my-new-skill\ndescription: d\n---\nbody'
    const res = await app.inject({ method: 'POST', url: '/api/skills/save', payload: { dir, content } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.created).toBe(true)
    expect(body.path).toBe(join(dir, 'my-new-skill', 'SKILL.md'))
    expect(readFileSync(body.path, 'utf8')).toBe(content)
  })

  it('POST /api/skills/save 409s on a second save without overwrite, then succeeds with overwrite:true', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const dir = loadConfig(path).skillDirs[0]
    const content = '---\nname: dup-skill\ndescription: d\n---\nfirst version'
    await app.inject({ method: 'POST', url: '/api/skills/save', payload: { dir, content } })

    const conflict = await app.inject({ method: 'POST', url: '/api/skills/save', payload: { dir, content } })
    expect(conflict.statusCode).toBe(409)

    const updated = '---\nname: dup-skill\ndescription: d\n---\nsecond version'
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills/save',
      payload: { dir, content: updated, overwrite: true },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.created).toBe(false)
    expect(readFileSync(body.path, 'utf8')).toBe(updated)
  })

  it('POST /api/skills/save 400s when the content has no name: frontmatter', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const dir = loadConfig(path).skillDirs[0]
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills/save',
      payload: { dir, content: 'no frontmatter here' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/skills/save 400s on an unsafe skill name', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const dir = loadConfig(path).skillDirs[0]
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills/save',
      payload: { dir, content: '---\nname: ../escape\n---\nbody' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/skills/save 400s when dir is not a known local skill directory', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills/save',
      payload: { dir: '/not/a/configured/dir', content: '---\nname: x\n---\nbody' },
    })
    expect(res.statusCode).toBe(400)
  })
```

Add `readFileSync` to the existing `node:fs` import at the top of `app.test.ts` (it currently
imports `mkdtempSync, writeFileSync, mkdirSync, existsSync` — add `readFileSync` to that
same import line).

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd server && npx vitest run test/app.test.ts -t "api/skills/local-dirs|api/skills/save"`
Expected: FAIL — both routes 404 (they don't exist yet).

- [ ] **Step 3: Add the routes**

In `server/src/routes/skills.ts`, change the imports at the top:

```ts
import { rmSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { saveConfig } from '../config.js'
import { scanSkillDirs } from '../skills/scanner.js'
import { addGithubSource, refreshGithubSource, skillRepoCloneDir } from '../skills/sources.js'
```

to:

```ts
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { saveConfig } from '../config.js'
import { parseFrontmatter, scanSkillDirs } from '../skills/scanner.js'
import { addGithubSource, refreshGithubSource, skillRepoCloneDir } from '../skills/sources.js'
import { isSafeCacheSegment } from './cache.js'
```

Then add these two routes at the end of `registerSkillRoutes`, right before its closing
brace (after the existing `app.post('/api/skill-sources/refresh', ...)` route):

```ts
  app.get('/api/skills/local-dirs', async () => {
    const c = ctx.cfg()
    return c.skillDirs.filter((d) => !skillRepoCloneDir(d, ctx.skillReposDir()))
  })

  app.post('/api/skills/save', async (req, reply) => {
    const body = req.body as { dir: string; content: string; overwrite?: boolean }
    const c = ctx.cfg()
    const localDirs = c.skillDirs.filter((d) => !skillRepoCloneDir(d, ctx.skillReposDir()))
    if (!localDirs.includes(body.dir)) {
      return reply.code(400).send({ error: 'Not a known local skill directory.' })
    }
    const name = parseFrontmatter(body.content).name
    if (!name) {
      return reply.code(400).send({ error: 'Add a name: field to the skill content before saving.' })
    }
    if (!isSafeCacheSegment(name)) {
      return reply.code(400).send({ error: `Invalid skill name: ${name}` })
    }
    const skillDir = join(body.dir, name)
    const filePath = join(skillDir, 'SKILL.md')
    const created = !existsSync(filePath)
    if (!created && !body.overwrite) {
      return reply.code(409).send({ error: `A skill named "${name}" already exists at ${filePath}.` })
    }
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(filePath, body.content)
    return { ok: true, path: filePath, created }
  })
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd server && npx vitest run test/app.test.ts`
Expected: PASS, all tests in the file including the six new ones.

- [ ] **Step 5: Run the full server test suite and typecheck**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/skills.ts server/test/app.test.ts
git commit -m "feat: local-dirs and save routes for the skill test-run save-to-disk flow"
```

---

### Task 2: "Save skill…" dialog on `RunView`

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/RunView.tsx`

**Interfaces:**
- Consumes: `GET /api/skills/local-dirs`, `POST /api/skills/save` from Task 1.

No new unit tests — presentational, matching this project's established convention.
Verification is typecheck + build + full test suite.

- [ ] **Step 1: Add the API functions**

In `web/src/api.ts`, add after `createTestRun`:

```ts
export const getLocalSkillDirs = () => fetch('/api/skills/local-dirs').then((r) => json<string[]>(r))

export async function saveSkill(input: {
  dir: string
  content: string
  overwrite?: boolean
}): Promise<{ ok?: boolean; path?: string; created?: boolean; error?: string; status: number }> {
  try {
    const res = await fetch('/api/skills/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    let body: any = {}
    try {
      body = await res.json()
    } catch {
      body = { error: `Server returned a non-JSON response (HTTP ${res.status})` }
    }
    return { ...body, status: res.status }
  } catch (err: any) {
    return { error: err?.message ?? 'Network error', status: 0 }
  }
}
```

- [ ] **Step 2: Add imports and state to `RunView.tsx`**

`RunView.tsx` has no model/depth pickers today, so `Select` isn't imported there yet. Add
both of these to the existing import block:

```ts
import { Select } from '@/components/ui/select'
```

```ts
import { getLocalSkillDirs, saveSkill } from '../api.js'
```

(add `getLocalSkillDirs, saveSkill` to the existing `import { createRun, getPostPreview,
getRun, postComments, subscribeRun, ... } from '../api.js'` block rather than a second
import statement.)

Add state, near the existing `useState` declarations:

```ts
  const [savingOpen, setSavingOpen] = useState(false)
  const [localDirs, setLocalDirs] = useState<string[]>([])
  const [saveDir, setSaveDir] = useState<string | null>(null)
  const [saveConflict, setSaveConflict] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
```

- [ ] **Step 3: Fetch local dirs when the dialog opens**

Add a new effect, after the existing `parentRun`-fetching effect:

```ts
  useEffect(() => {
    if (!savingOpen) return
    let cancelled = false
    setSaveConflict(false)
    getLocalSkillDirs()
      .then((dirs) => {
        if (cancelled) return
        setLocalDirs(dirs)
        setSaveDir((cur) => cur ?? dirs[0] ?? null)
      })
      .catch(() => {
        if (!cancelled) setLocalDirs([])
      })
    return () => {
      cancelled = true
    }
  }, [savingOpen])
```

- [ ] **Step 4: Add the save handler**

Add near the other action functions (e.g. after `retryFailedSkills`):

```ts
  async function saveSkillToDisk(overwrite = false) {
    if (!run?.testSkillContent || !saveDir) return
    setSaveBusy(true)
    try {
      const res = await saveSkill({ dir: saveDir, content: run.testSkillContent, overwrite })
      if (res.status === 409) {
        setSaveConflict(true)
        return
      }
      if (res.ok) {
        toast.success(res.created ? `Saved to ${res.path}` : `Updated ${res.path}`)
        setSavingOpen(false)
        setSaveConflict(false)
      } else {
        toast.error(res.error ?? 'Failed to save skill')
      }
    } finally {
      setSaveBusy(false)
    }
  }
```

- [ ] **Step 5: Render the "Save skill…" button and dialog**

Change the test-run header slot (currently rendering nothing for `run.isTest`):

```tsx
          {!run.isTest && (
            <div className="flex shrink-0 gap-2">
              {run.status === 'failed' && (
                <Button variant="secondary" size="sm" onClick={retry}>
                  Retry run
                </Button>
              )}
              {failed.length > 0 && (run.status === 'completed' || run.status === 'failed') && (
                <Button variant="secondary" size="sm" onClick={retryFailedSkills}>
                  Retry failed skills ({failed.length})
                </Button>
              )}
            </div>
          )}
```

to:

```tsx
          {!run.isTest ? (
            <div className="flex shrink-0 gap-2">
              {run.status === 'failed' && (
                <Button variant="secondary" size="sm" onClick={retry}>
                  Retry run
                </Button>
              )}
              {failed.length > 0 && (run.status === 'completed' || run.status === 'failed') && (
                <Button variant="secondary" size="sm" onClick={retryFailedSkills}>
                  Retry failed skills ({failed.length})
                </Button>
              )}
            </div>
          ) : (
            run.status === 'completed' && (
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" size="sm" onClick={() => setSavingOpen(true)}>
                  Save skill…
                </Button>
              </div>
            )
          )}
```

Add the dialog right after the existing post-comments `<Dialog>` block, before the closing
`</div>` of the component's root:

```tsx
      <Dialog open={savingOpen} onOpenChange={setSavingOpen}>
        <Dialog.Panel>
          <Dialog.Header>
            <Dialog.Title>Save skill</Dialog.Title>
            <Dialog.Description>Writes the tested content to a local skill directory.</Dialog.Description>
          </Dialog.Header>
          <Dialog.Content>
            {localDirs.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No local skill directory configured — add one in Settings → Skills first.
              </p>
            ) : localDirs.length === 1 ? (
              <p className="font-family-mono text-sm">{localDirs[0]}</p>
            ) : (
              <Select value={saveDir ?? undefined} onValueChange={setSaveDir}>
                <Select.Trigger>
                  <Select.Value placeholder="Choose a destination" />
                </Select.Trigger>
                <Select.Content>
                  {localDirs.map((d) => (
                    <Select.Item key={d} value={d}>
                      {d}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            )}
            {saveConflict && (
              <p className="text-warning-400 mt-3 text-sm">
                A skill with this name already exists at that location — overwrite it?
              </p>
            )}
          </Dialog.Content>
          <Dialog.Footer className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSavingOpen(false)}>
              Cancel
            </Button>
            {saveConflict ? (
              <Button variant="destructive" disabled={saveBusy} onClick={() => saveSkillToDisk(true)}>
                Overwrite
              </Button>
            ) : (
              <Button disabled={saveBusy || !saveDir} onClick={() => saveSkillToDisk(false)}>
                {saveBusy ? 'Saving…' : 'Save'}
              </Button>
            )}
          </Dialog.Footer>
        </Dialog.Panel>
      </Dialog>
```

- [ ] **Step 6: Run the full web test suite, typecheck, and build**

Run: `cd web && npm test && npm run build`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/pages/RunView.tsx
git commit -m "feat(ui): save a tested skill to a local skill directory from the run page"
```
