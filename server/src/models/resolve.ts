import { claudeQuery } from './claude.js'
import { cliQuery } from './cli.js'
import type { ModelProfile } from './profiles.js'
import type { AgentQuery } from '../review/runner.js'

export function queryFor(profile: ModelProfile): AgentQuery {
  switch (profile.kind) {
    case 'claude':
      return claudeQuery(profile)
    case 'cli':
      return cliQuery(profile)
    default:
      throw new Error(`model kind not yet supported: ${profile.kind}`)
  }
}
