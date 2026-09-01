import type { FastifyInstance } from 'fastify'
import { ConfigSchema, saveConfig, type Config } from '../config.js'
import type { AppContext } from '../context.js'

const MASK = '***'

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/config', async () => {
    const c = ctx.cfg()
    return {
      ...c,
      bitbucketToken: c.bitbucketToken ? MASK : '',
      githubToken: c.githubToken ? MASK : '',
      modelProfiles: c.modelProfiles.map((p) =>
        p.kind === 'openai' ? { ...p, apiKey: p.apiKey ? MASK : '' } : p,
      ),
    }
  })

  app.put('/api/config', async (req, reply) => {
    const incoming = req.body as Config
    return ctx.withConfigLock(() => {
      const current = ctx.cfg()
      if (incoming.bitbucketToken === MASK) incoming.bitbucketToken = current.bitbucketToken
      if (incoming.githubToken === MASK) incoming.githubToken = current.githubToken
      if (Array.isArray(incoming.modelProfiles)) {
        incoming.modelProfiles = incoming.modelProfiles.map((p: any) => {
          if (p?.kind !== 'openai' || p.apiKey !== MASK) return p
          const stored = current.modelProfiles.find((sp) => sp.id === p.id)
          return { ...p, apiKey: stored?.kind === 'openai' ? stored.apiKey : '' }
        })
      }
      const parsed = ConfigSchema.safeParse(incoming)
      if (!parsed.success) {
        reply.code(400)
        return { error: parsed.error.message }
      }
      saveConfig(parsed.data, ctx.configPath)
      return { ok: true }
    })
  })
}
