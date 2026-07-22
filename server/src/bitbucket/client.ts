import { PrAuthError } from '../providers/errors.js'
import type { PrMeta, PrProviderClient, PrRef } from '../types.js'

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

  cloneUrl(pr: PrRef, protocol: 'ssh' | 'https' = 'ssh'): string {
    if (protocol === 'ssh') return `git@bitbucket.org:${pr.workspace}/${pr.repo}.git`
    return `https://${encodeURIComponent(this.email)}:${encodeURIComponent(this.token)}@bitbucket.org/${pr.workspace}/${pr.repo}.git`
  }
}
