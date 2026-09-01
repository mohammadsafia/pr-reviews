import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { RepoCache } from '../repos/cache.js'
import type { Provider } from '../types.js'

const SAFE_CACHE_SEGMENT = /^[A-Za-z0-9._-]+$/
const PROVIDERS: readonly Provider[] = ['bitbucket', 'github']

/** Path segments accepted for cache workspace/repo params: no separators, no bare "."/"..". */
export function isSafeCacheSegment(s: string): boolean {
  return SAFE_CACHE_SEGMENT.test(s) && s !== '.' && s !== '..'
}

export function registerCacheRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.delete('/api/cache/:provider/:workspace/:repo', async (req, reply) => {
    const { provider, workspace, repo } = req.params as {
      provider: string
      workspace: string
      repo: string
    }
    if (!PROVIDERS.includes(provider as Provider)) {
      return reply.code(400).send({ error: 'Invalid provider' })
    }
    if (!isSafeCacheSegment(workspace) || !isSafeCacheSegment(repo)) {
      return reply.code(400).send({ error: 'Invalid workspace or repo name' })
    }
    try {
      new RepoCache(ctx.cfg().cacheDir).clear({ provider: provider as Provider, workspace, repo, id: 0 })
    } catch (err: any) {
      return reply.code(400).send({ error: err.message })
    }
    return { ok: true }
  })
}
