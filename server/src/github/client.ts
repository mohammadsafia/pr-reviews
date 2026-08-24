import { PrAuthError } from '../providers/errors.js'
import type { ExistingComment, PrMeta, PrProviderClient, PrRef, ReviewerPr } from '../types.js'

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

  async listComments(pr: PrRef): Promise<ExistingComment[]> {
    const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
      repository(owner:$owner,name:$repo){ pullRequest(number:$number){
        reviewThreads(first:100, after:$cursor){
          pageInfo{ hasNextPage endCursor }
          nodes{ isResolved path line comments(first:1){ nodes{ body } } }
        } } } }`
    const out: ExistingComment[] = []
    let cursor: string | null = null
    for (;;) {
      const res = await this.request(`${API}/graphql`, {
        method: 'POST',
        body: JSON.stringify({
          query,
          variables: { owner: pr.workspace, repo: pr.repo, number: pr.id, cursor },
        }),
      })
      const json = (await res.json()) as any
      if (json.errors) throw new Error(`GitHub GraphQL error: ${JSON.stringify(json.errors)}`)
      const threads = json.data?.repository?.pullRequest?.reviewThreads
      for (const t of threads?.nodes ?? []) {
        for (const c of t.comments?.nodes ?? []) {
          out.push({ path: t.path ?? undefined, line: t.line ?? undefined, body: c.body ?? '', resolved: !!t.isResolved })
        }
      }
      if (!threads?.pageInfo?.hasNextPage) break
      cursor = threads.pageInfo.endCursor
    }
    return out
  }

  cloneUrl(pr: PrRef, protocol: 'ssh' | 'https' = 'ssh'): string {
    if (protocol === 'ssh') return `git@github.com:${pr.workspace}/${pr.repo}.git`
    return `https://x-access-token:${this.token}@github.com/${pr.workspace}/${pr.repo}.git`
  }

  /** Open PRs where the authenticated user is a requested reviewer — one global search
   * call (`review-requested:@me` resolves against the token's user). */
  async listReviewerPrs(): Promise<ReviewerPr[]> {
    const q = encodeURIComponent('is:pr is:open review-requested:@me')
    const data = (await (
      await this.request(`${API}/search/issues?q=${q}&per_page=50&sort=updated`)
    ).json()) as any
    const out: ReviewerPr[] = []
    for (const item of data.items ?? []) {
      // repository_url: https://api.github.com/repos/{owner}/{repo}
      const parts = String(item.repository_url ?? '').split('/')
      const repo = parts.pop() ?? ''
      const owner = parts.pop() ?? ''
      if (!owner || !repo) continue
      out.push({
        provider: 'github',
        workspace: owner,
        repo,
        id: item.number,
        title: item.title ?? '',
        author: item.user?.login ?? '',
        updatedAt: item.updated_at ?? '',
        url: item.html_url ?? `https://github.com/${owner}/${repo}/pull/${item.number}`,
      })
    }
    return out
  }
}
