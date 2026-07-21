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
