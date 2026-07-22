import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  addGithubSkillSource,
  clearRepoCache,
  createRun,
  postComments,
  refreshSkillSource,
  removeSkillSource,
} from '../src/api.js'

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

  it('handles network failure without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const r = await createRun({ url: 'u', skills: [] })
    expect(r.status).toBe(0)
    expect(r.error).toContain('boom')
  })

  it('handles non-JSON response gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })))
    const r = await createRun({ url: 'u', skills: [] })
    expect(r.status).toBe(502)
    expect(r.error).toContain('non-JSON')
  })
})

describe('addGithubSkillSource', () => {
  it('returns dir and skillCount on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ dir: '/x/skills', skillCount: 3 }), { status: 200 })),
    )
    expect(await addGithubSkillSource('acme/skills')).toEqual({ dir: '/x/skills', skillCount: 3 })
  })

  it('returns the error message on 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid GitHub repo: x' }), { status: 400 })),
    )
    const r = await addGithubSkillSource('x')
    expect(r.error).toBe('Invalid GitHub repo: x')
  })

  it('handles network failure without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const r = await addGithubSkillSource('acme/skills')
    expect(r.error).toContain('boom')
  })
})

describe('removeSkillSource', () => {
  it('returns ok:true on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
    expect(await removeSkillSource('/x')).toEqual({ ok: true })
  })

  it('returns ok:false with the error on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })),
    )
    const r = await removeSkillSource('/x')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('nope')
  })
})

describe('refreshSkillSource', () => {
  it('returns skillCount on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ skillCount: 5 }), { status: 200 })),
    )
    expect(await refreshSkillSource('/x')).toEqual({ skillCount: 5 })
  })

  it('returns an error on 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Not a GitHub-backed skill source' }), { status: 400 })),
    )
    const r = await refreshSkillSource('/x')
    expect(r.error).toBe('Not a GitHub-backed skill source')
  })
})

describe('clearRepoCache', () => {
  it('returns ok:true on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
    expect(await clearRepoCache('ws', 'repo')).toEqual({ ok: true })
  })

  it('surfaces a non-OK response as ok:false with the error, instead of always resolving', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid workspace or repo name' }), { status: 400 })),
    )
    const r = await clearRepoCache('..', 'etc')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Invalid workspace or repo name')
  })

  it('handles network failure without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const r = await clearRepoCache('ws', 'repo')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('boom')
  })
})

describe('postComments', () => {
  it('returns the posted and failed arrays from the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ posted: [111], failed: [{ index: 1, error: 'bitbucket down' }] }), {
          status: 200,
        }),
      ),
    )
    const r = await postComments('run1', [0, 1])
    expect(r).toEqual({ posted: [111], failed: [{ index: 1, error: 'bitbucket down' }] })
  })
})
