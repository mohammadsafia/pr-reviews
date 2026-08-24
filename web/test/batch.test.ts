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
    await submitBatch(['u1'], { ...opts, force: true, profile: 'codex' }, fake as any)
    expect(seen[0]).toEqual({ url: 'u1', skills: ['a'], verify: true, depth: 'balanced', force: true, profile: 'codex' })
  })

  it('defaults a missing error message', async () => {
    const fake = async () => ({ status: 0 })
    const out = await submitBatch(['u1'], opts, fake as any)
    expect(out[0]).toEqual({ url: 'u1', kind: 'error', message: 'Failed to start run' })
  })
})
