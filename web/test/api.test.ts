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
