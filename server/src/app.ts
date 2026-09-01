import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { DEFAULT_CONFIG_PATH, loadConfig, type Config } from './config.js'
import { makeClient } from './providers/factory.js'
import { sweepStrandedWorktrees } from './repos/cache.js'
import { queryFor } from './models/resolve.js'
import type { AgentQuery } from './review/runner.js'
import { makeTaskPool } from './queue.js'
import { RunStore } from './store/runs.js'
import type { AppContext } from './context.js'
import { registerCacheRoutes, isSafeCacheSegment } from './routes/cache.js'
import { registerConfigRoutes } from './routes/config.js'
import { registerReviewerPrRoutes } from './routes/reviewerPrs.js'
import { registerRunRoutes, sweepStrandedRuns } from './routes/runs.js'
import { registerSkillRoutes } from './routes/skills.js'
import type { ModelProfile } from './models/profiles.js'
import type { PrProviderClient, PrRef } from './types.js'

export { isSafeCacheSegment, sweepStrandedRuns }

export function buildApp(
  deps: {
    configPath?: string
    agentQuery?: AgentQuery
    queryFactory?: (profile: ModelProfile) => AgentQuery
    clientFactory?: (pr: PrRef, cfg: Config) => PrProviderClient
  } = {},
): FastifyInstance {
  let cfgChain: Promise<unknown> = Promise.resolve()
  function withConfigLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = cfgChain.then(fn)
    cfgChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const configPath = deps.configPath ?? DEFAULT_CONFIG_PATH
  const app = Fastify()

  const cfg = (): Config => loadConfig(configPath)
  const store = (): RunStore => new RunStore(cfg().runsDir)
  const skillReposDir = (): string => join(dirname(cfg().cacheDir), 'skill-repos')

  const ctx: AppContext = {
    configPath,
    cfg,
    store,
    withConfigLock,
    skillReposDir,
    agentQuery: deps.agentQuery,
    queryFactory: deps.queryFactory ?? queryFor,
    clientFactory: deps.clientFactory ?? makeClient,
    events: new EventEmitter(),
    runQueue: makeTaskPool(() => cfg().maxConcurrentRuns, (err) => app.log.error(err)),
  }

  sweepStrandedRuns(cfg().runsDir)
  sweepStrandedWorktrees(cfg().cacheDir)

  registerConfigRoutes(app, ctx)
  registerSkillRoutes(app, ctx)
  registerReviewerPrRoutes(app, ctx)
  registerRunRoutes(app, ctx)
  registerCacheRoutes(app, ctx)

  return app
}
