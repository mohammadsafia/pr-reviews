import { rmSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { saveConfig } from '../config.js'
import { scanSkillDirs } from '../skills/scanner.js'
import { addGithubSource, refreshGithubSource, skillRepoCloneDir } from '../skills/sources.js'

export function registerSkillRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/skills', async () => scanSkillDirs(ctx.cfg().skillDirs))

  app.post('/api/skill-sources/github', async (req, reply) => {
    const { repo } = req.body as { repo: string }
    let result: { dir: string; skillCount: number }
    try {
      result = await addGithubSource(repo, { reposDir: ctx.skillReposDir() })
    } catch (err: any) {
      const invalid = /^(Invalid GitHub repo|No skills found)/.test(err.message)
      return reply.code(invalid ? 400 : 502).send({ error: err.message })
    }
    await ctx.withConfigLock(() => {
      const c = ctx.cfg()
      if (!c.skillDirs.includes(result.dir)) {
        c.skillDirs.push(result.dir)
        saveConfig(c, ctx.configPath)
      }
    })
    return result
  })

  app.delete('/api/skill-sources', async (req) => {
    const { dir } = req.body as { dir: string }
    await ctx.withConfigLock(() => {
      const c = ctx.cfg()
      c.skillDirs = c.skillDirs.filter((d) => d !== dir)
      saveConfig(c, ctx.configPath)
    })
    const cloneRoot = skillRepoCloneDir(dir, ctx.skillReposDir())
    if (cloneRoot) {
      try {
        rmSync(cloneRoot, { recursive: true, force: true })
      } catch (err: any) {
        return {
          ok: true,
          warning: `Removed from config but the clone directory could not be deleted: ${err.message}`,
        }
      }
    }
    return { ok: true }
  })

  app.post('/api/skill-sources/refresh', async (req, reply) => {
    const { dir } = req.body as { dir: string }
    try {
      const result = await refreshGithubSource(dir, { reposDir: ctx.skillReposDir() })
      return result
    } catch (err: any) {
      const notGithub = /^Not a GitHub-backed/.test(err.message)
      return reply.code(notGithub ? 400 : 502).send({ error: err.message })
    }
  })
}
