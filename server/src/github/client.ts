import { PrAuthError } from '../providers/errors.js'
import type { PrMeta, PrProviderClient, PrRef } from '../types.js'

const API = 'https://api.github.com'

export class GitHubClient implements PrProviderClient {
  /** Memoized head commit SHA, resolved once per instance on the first postInlineComment call
   * and reused for the rest of the batch (one client instance is expected to handle a whole
   * posting batch — see app.ts's comments route, which constructs one client per request). */
  private headShaCache = new Map<string, string>()

  constructor(
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private prBase(pr: PrRef): string {
    return `${API}/repos/${pr.workspace}/${pr.repo}/pulls/${pr.id}`
  }

  private async request(
    url: string,
    init: RequestInit = {},
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    // Deliberately no X-GitHub-Api-Version header — omitting it uses GitHub's current default
    // version, which is future-proof and avoids pinning a stale date.
    const res = await this.fetchFn(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    if (res.status === 401) {
      throw new PrAuthError('GitHub rejected your token (401). Check your token in Settings.')
    }
    if (res.status === 403) {
      throw new PrAuthError(
        'GitHub denied access to this repository (403). Your token may lack `pull-requests` scope on it.',
      )
    }
    if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${url}`)
    return res
  }

  async getPullRequest(pr: PrRef): Promise<PrMeta> {
    const d = (await (await this.request(this.prBase(pr))).json()) as any
    return {
      title: d.title ?? '',
      description: d.body ?? '',
      sourceBranch: d.head.ref,
      destinationBranch: d.base.ref,
      sourceCommit: d.head.sha,
    }
  }

  async getDiff(pr: PrRef): Promise<string> {
    return (await this.request(this.prBase(pr), {}, 'application/vnd.github.diff')).text()
  }

  private async resolveHeadSha(pr: PrRef): Promise<string> {
    const key = `${pr.workspace}/${pr.repo}/${pr.id}`
    const cached = this.headShaCache.get(key)
    if (cached) return cached
    const d = (await (await this.request(this.prBase(pr))).json()) as any
    const sha = d.head.sha as string
    this.headShaCache.set(key, sha)
    return sha
  }

  async postInlineComment(
    pr: PrRef,
    c: { path: string; line: number; text: string },
  ): Promise<number> {
    const commitId = await this.resolveHeadSha(pr)
    const res = await this.request(`${this.prBase(pr)}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body: c.text,
        commit_id: commitId,
        path: c.path,
        line: c.line,
        side: 'RIGHT',
      }),
    })
    return ((await res.json()) as any).id as number
  }

  cloneUrl(pr: PrRef, protocol: 'ssh' | 'https' = 'ssh'): string {
    if (protocol === 'ssh') return `git@github.com:${pr.workspace}/${pr.repo}.git`
    return `https://x-access-token:${this.token}@github.com/${pr.workspace}/${pr.repo}.git`
  }
}
