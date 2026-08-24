import { claudeQuery } from './claude.js'
import { cliQuery } from './cli.js'
import { openaiQuery } from './openai.js'
import type { ModelProfile } from './profiles.js'
import type { AgentQuery } from '../review/runner.js'

export function queryFor(profile: ModelProfile): AgentQuery {
  switch (profile.kind) {
    case 'claude':
      return claudeQuery(profile)
    case 'cli':
      return cliQuery(profile)
    case 'openai':
      return openaiQuery(profile)
  }
}
