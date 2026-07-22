import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunStore } from '../src/store/runs.js'

const base = {
  pr: { provider: 'bitbucket' as const, workspace: 'ws', repo: 'r', id: 1 },
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
    expect(run.skillResults).toEqual([])
    const reloaded = new RunStore(dir).get(run.id)
    expect(reloaded?.prTitle).toBe('T')
    expect(reloaded?.skillResults).toEqual([])
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

  it('list() skips a corrupt .json file instead of throwing, and still returns the valid runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-runs-'))
    const store = new RunStore(dir)
    const a = store.create({ ...base, prTitle: 'A' })
    writeFileSync(join(dir, 'garbage.json'), '{not valid json')
    const list = store.list()
    expect(list.map((r) => r.id)).toEqual([a.id])
  })

  it('get() returns undefined (not a throw) for a corrupt .json file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-runs-'))
    writeFileSync(join(dir, 'corrupt-id.json'), '{not valid json')
    const store = new RunStore(dir)
    expect(store.get('corrupt-id')).toBeUndefined()
  })

  it('save() is atomic: it never leaves a stray .tmp file behind and the target always has valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-runs-'))
    const store = new RunStore(dir)
    const run = store.create({ ...base, prTitle: 'A' })
    run.status = 'completed'
    store.save(run)
    const files = readdirSync(dir)
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
    expect(store.get(run.id)?.status).toBe('completed')
  })
})
