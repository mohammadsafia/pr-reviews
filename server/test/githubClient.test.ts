import { describe, it, expect, vi } from 'vitest'
import { GitHubClient } from '../src/github/client.js'
import { PrAuthError } from '../src/providers/errors.js'

const pr = { provider: 'github' as const, workspace: 'acme', repo: 'r', id: 5 }

function fakeFetch(status: number, body: unknown, text = '') {
  return vi.fn(async () => new Response(text || JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('GitHubClient', () => {
  it('maps pull request metadata', async () => {
    const f = fakeFetch(200, {
      title: 'Fix members page',
      body: 'desc',
      head: { ref: 'feat/x', sha: 'abc123' },
      base: { ref: 'main' },
    })
    const c = new GitHubClient('tok', f)
    const meta = await c.getPullRequest(pr)
    expect(meta).toEqual({
      title: 'Fix members page',
      description: 'desc',
      sourceBranch: 'feat/x',
      destinationBranch: 'main',
      sourceCommit: 'abc123',
    })
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/acme/r/pulls/5')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(init.headers.Accept).toBe('application/vnd.github+json')
    expect(init.headers['X-GitHub-Api-Version']).toBeUndefined()
  })

  it('returns raw diff text via the diff Accept header', async () => {
    const f = fakeFetch(200, null, 'diff --git a/x b/x')
    const c = new GitHubClient('tok', f)
    expect(await c.getDiff(pr)).toBe('diff --git a/x b/x')
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/acme/r/pulls/5')
    expect(init.headers.Accept).toBe('application/vnd.github.diff')
  })

  it('posts an inline comment: resolves the head SHA once, sends commit_id/side/line/path, returns the id', async () => {
    const calls: { url: string; init: any }[] = []
    const f = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url.endsWith('/pulls/5')) {
        return new Response(JSON.stringify({ head: { sha: 'headsha1' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 77 }), { status: 201 })
    }) as unknown as typeof fetch

    const c = new GitHubClient('tok', f)
    const id1 = await c.postInlineComment(pr, { path: 'src/a.ts', line: 12, text: 'hi' })
    const id2 = await c.postInlineComment(pr, { path: 'src/b.ts', line: 3, text: 'hi2' })
    expect(id1).toBe(77)
    expect(id2).toBe(77)

    // Only one GET to resolve the head SHA, memoized across the batch.
    const getCalls = calls.filter((c) => c.url.endsWith('/pulls/5'))
    expect(getCalls).toHaveLength(1)

    const postCalls = calls.filter((c) => c.url.endsWith('/comments'))
    expect(postCalls).toHaveLength(2)
    const body1 = JSON.parse(postCalls[0].init.body)
    expect(body1).toEqual({
      body: 'hi',
      commit_id: 'headsha1',
      path: 'src/a.ts',
      line: 12,
      side: 'RIGHT',
    })
  })

  it('throws PrAuthError on 401', async () => {
    const c = new GitHubClient('bad', fakeFetch(401, {}))
    await expect(c.getDiff(pr)).rejects.toBeInstanceOf(PrAuthError)
  })

  it('throws PrAuthError on 403', async () => {
    const c = new GitHubClient('bad', fakeFetch(403, {}))
    await expect(c.getDiff(pr)).rejects.toBeInstanceOf(PrAuthError)
  })

  it('throws a plain Error on other non-2xx statuses', async () => {
    const c = new GitHubClient('tok', fakeFetch(500, {}))
    await expect(c.getDiff(pr)).rejects.toThrow(/GitHub API error 500/)
  })

  it('builds an ssh clone URL by default', () => {
    const c = new GitHubClient('tok', fakeFetch(200, {}))
    expect(c.cloneUrl(pr)).toBe('git@github.com:acme/r.git')
  })

  it('builds an authenticated https clone URL when requested, using x-access-token', () => {
    const c = new GitHubClient('tok123', fakeFetch(200, {}))
    expect(c.cloneUrl(pr, 'https')).toBe('https://x-access-token:tok123@github.com/acme/r.git')
  })
})
