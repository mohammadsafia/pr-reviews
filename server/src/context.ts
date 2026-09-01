import type { EventEmitter } from 'node:events'
import type { Config } from './config.js'
import type { TaskPool } from './queue.js'
import type { AgentQuery } from './review/runner.js'
import type { ModelProfile } from './models/profiles.js'
import type { RunStore } from './store/runs.js'
import type { PrProviderClient, PrRef } from './types.js'

/** Everything a route module needs, built once per buildApp() call and passed in rather
 * than captured ambiently from buildApp's closure — makes each route module's real
 * dependencies explicit and lets it be extracted into its own file. */
export interface AppContext {
  configPath: string
  cfg(): Config
  store(): RunStore
  withConfigLock<T>(fn: () => T | Promise<T>): Promise<T>
  skillReposDir(): string
  agentQuery?: AgentQuery
  queryFactory(profile: ModelProfile): AgentQuery
  clientFactory(pr: PrRef, cfg: Config): PrProviderClient
  events: EventEmitter
  runQueue: TaskPool
}
