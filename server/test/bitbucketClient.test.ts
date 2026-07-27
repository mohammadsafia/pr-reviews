import { describe, it, expect, vi } from 'vitest'
import { BitbucketClient, BitbucketAuthError } from '../src/bitbucket/client.js'

const pr = { provider: 'bitbucket' as const, workspace: 'ws', repo: 'r', id: 5 }

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

  it('builds an ssh clone URL by default', () => {
    const c = new BitbucketClient('e@x.io', 't0k', fakeFetch(200, {}))
    expect(c.cloneUrl(pr)).toBe('git@bitbucket.org:ws/r.git')
  })

  it('builds an authenticated https clone URL when requested', () => {
    const c = new BitbucketClient('e@x.io', 't0k', fakeFetch(200, {}))
    expect(c.cloneUrl(pr, 'https')).toBe('https://e%40x.io:t0k@bitbucket.org/ws/r.git')
  })

  it('listComments maps body, inline path/line, and resolution across pages', async () => {
    const page1 = {
      values: [
        { content: { raw: 'open one <!-- prr-fp:aaaaaaaaaaaa -->' }, inline: { path: 'a.ts', to: 5 }, resolution: null },
        { content: { raw: 'resolved one <!-- prr-fp:bbbbbbbbbbbb -->' }, inline: { path: 'b.ts', to: 9 }, resolution: { type: 'resolved' } },
      ],
      next: 'https://api.bitbucket.org/2.0/next-page',
    }
    const page2 = { values: [{ content: { raw: 'general no-inline' }, resolution: null }] }
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }))
    const client = new BitbucketClient('e@x.io', 'tok', fetchFn as any)
    const out = await client.listComments({ provider: 'bitbucket', workspace: 'w', repo: 'r', id: 3 })
    expect(out).toEqual([
      { path: 'a.ts', line: 5, body: 'open one <!-- prr-fp:aaaaaaaaaaaa -->', resolved: false },
      { path: 'b.ts', line: 9, body: 'resolved one <!-- prr-fp:bbbbbbbbbbbb -->', resolved: true },
      { path: undefined, line: undefined, body: 'general no-inline', resolved: false },
    ])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
