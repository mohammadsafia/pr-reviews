import { PrAuthError } from '../providers/errors.js'
import type { ExistingComment, PrMeta, PrProviderClient, PrRef, ReviewerPr } from '../types.js'

const API = 'https://api.bitbucket.org/2.0'

/** Structural shape the app depends on, so tests can inject a fake client.
 * @deprecated superseded by `PrProviderClient` in `../types.js`; kept as an alias so existing
 * imports keep working. */
export type BitbucketLike = PrProviderClient

export class BitbucketAuthError extends PrAuthError {
  constructor(status: number) {
    super(
      status === 401
        ? 'Bitbucket rejected your credentials (401). Check your email/API token in Settings.'
        : 'Bitbucket denied access to this repository (403). Your token may lack access to it.',
    )
    this.name = 'BitbucketAuthError'
  }
}

export class BitbucketClient implements PrProviderClient {
  constructor(
    private email: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private prBase(pr: PrRef): string {
    return `${API}/repositories/${pr.workspace}/${pr.repo}/pullrequests/${pr.id}`
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${this.email}:${this.token}`).toString('base64'),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    if (res.status === 401 || res.status === 403) throw new BitbucketAuthError(res.status)
    if (!res.ok) throw new Error(`Bitbucket API error ${res.status} for ${url}`)
    return res
  }

  async getPullRequest(pr: PrRef): Promise<PrMeta> {
    const d = (await (await this.request(this.prBase(pr))).json()) as any
    return {
      title: d.title ?? '',
      description: d.description ?? '',
      sourceBranch: d.source.branch.name,
      destinationBranch: d.destination.branch.name,
      sourceCommit: d.source.commit.hash,
    }
  }

  async getDiff(pr: PrRef): Promise<string> {
    return (await this.request(`${this.prBase(pr)}/diff`)).text()
  }

  async postInlineComment(
    pr: PrRef,
    c: { path: string; line: number; text: string },
  ): Promise<number> {
    const res = await this.request(`${this.prBase(pr)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: { raw: c.text }, inline: { path: c.path, to: c.line } }),
    })
    return ((await res.json()) as any).id as number
  }

  async listComments(pr: PrRef): Promise<ExistingComment[]> {
    const out: ExistingComment[] = []
    let url: string | undefined = `${this.prBase(pr)}/comments?pagelen=100`
    while (url) {
      const page = (await (await this.request(url)).json()) as any
      for (const c of page.values ?? []) {
        if (c.deleted) continue
        out.push({
          path: c.inline?.path,
          line: c.inline?.to,
          body: c.content?.raw ?? '',
          resolved: c.resolution != null,
        })
      }
      url = page.next
    }
    return out
  }

  cloneUrl(pr: PrRef, protocol: 'ssh' | 'https' = 'ssh'): string {
    if (protocol === 'ssh') return `git@bitbucket.org:${pr.workspace}/${pr.repo}.git`
    return `https://${encodeURIComponent(this.email)}:${encodeURIComponent(this.token)}@bitbucket.org/${pr.workspace}/${pr.repo}.git`
  }

  /** Open PRs across a workspace where the authenticated user is a requested reviewer.
   * Bitbucket Cloud has no cross-repo reviewer query, so this scans the workspace's most
   * recently active repos (first 100, sorted by -updated_on) and filters each repo's open
   * PRs by reviewers.uuid — per-repo queries run concurrently, capped at 10 in flight. */
  async listReviewerPrs(workspace: string): Promise<ReviewerPr[]> {
    const me = (await (await this.request(`${API}/user`)).json()) as any
    const uuid: string = me.uuid

    const repos: string[] = []
    // one page = the 100 most recently active repos; older idle repos are deliberately skipped
    const page = (await (
      await this.request(
        `${API}/repositories/${encodeURIComponent(workspace)}?sort=-updated_on&pagelen=100&fields=values.slug`,
      )
    ).json()) as any
    for (const r of page.values ?? []) repos.push(r.slug)

    const q = encodeURIComponent(`state="OPEN" AND reviewers.uuid="${uuid}"`)
    const out: ReviewerPr[] = []
    const CONCURRENCY = 10
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < repos.length) {
        const slug = repos[next++]
        try {
          const prs = (await (
            await this.request(
              `${API}/repositories/${encodeURIComponent(workspace)}/${slug}/pullrequests?q=${q}&pagelen=50&fields=values.id,values.title,values.author.display_name,values.updated_on,values.links.html.href`,
            )
          ).json()) as any
          for (const p of prs.values ?? []) {
            out.push({
              provider: 'bitbucket',
              workspace,
              repo: slug,
              id: p.id,
              title: p.title ?? '',
              author: p.author?.display_name ?? '',
              updatedAt: p.updated_on ?? '',
              url: p.links?.html?.href ?? `https://bitbucket.org/${workspace}/${slug}/pull-requests/${p.id}`,
            })
          }
        } catch {
          // one unreadable repo (permissions, transient error) must not sink the whole scan
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, repos.length) }, worker))
    return out
  }
}
