import { claudeQuery } from './claude.js'
import type { ModelProfile } from './profiles.js'
import type { AgentQuery } from '../review/runner.js'

export function queryFor(profile: ModelProfile): AgentQuery {
  switch (profile.kind) {
    case 'claude':
      return claudeQuery(profile)
    default:
      throw new Error(`model kind not yet supported: ${profile.kind}`)
  }
}
