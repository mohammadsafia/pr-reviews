import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { BitbucketClient } from '../bitbucket/client.js'
import { GitHubClient } from '../github/client.js'
import type { Provider, ReviewerPr } from '../types.js'

export function registerReviewerPrRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/reviewer-prs', async () => {
    const c = ctx.cfg()
    const errors: { provider: Provider; message: string }[] = []
    const collect = async (provider: Provider, fn: () => Promise<ReviewerPr[]>): Promise<ReviewerPr[]> => {
      try {
        return await fn()
      } catch (err: any) {
        errors.push({ provider, message: err.message })
        return []
      }
    }
    const [github, bitbucket] = await Promise.all([
      c.githubToken
        ? collect('github', () => new GitHubClient(c.githubToken).listReviewerPrs())
        : Promise.resolve<ReviewerPr[]>([]),
      c.bitbucketToken && c.bitbucketWorkspace
        ? collect('bitbucket', () =>
            new BitbucketClient(c.bitbucketEmail, c.bitbucketToken).listReviewerPrs(c.bitbucketWorkspace),
          )
        : Promise.resolve<ReviewerPr[]>([]),
    ])
    const prs = [...github, ...bitbucket].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { prs, errors }
  })
}
