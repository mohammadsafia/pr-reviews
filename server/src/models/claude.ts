import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentMessage, AgentQuery } from '../review/runner.js'
import type { ModelProfile } from './profiles.js'

// NOTE: In the installed SDK (@anthropic-ai/claude-agent-sdk@0.3.216), `allowedTools` is
// only an auto-approve list — it does NOT restrict which tools are available. The actual
// allow-list is the `tools` option (`tools?: string[] | { type: 'preset'; preset: 'claude_code' }`,
// see node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts around line 1404). `disallowedTools`
// removes tools even if otherwise allowed (line 1368) and is kept here as defense in depth.
export function buildQueryOptions(cwd: string, model: string) {
  return {
    cwd,
    model,
    tools: ['Read', 'Grep', 'Glob'],
    disallowedTools: ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch'],
    permissionMode: 'bypassPermissions' as const,
    // Required by the installed SDK whenever permissionMode is 'bypassPermissions' —
    // without it, query() throws synchronously before yielding anything.
    allowDangerouslySkipPermissions: true,
  }
}

export function claudeQuery(profile: Extract<ModelProfile, { kind: 'claude' }>): AgentQuery {
  return async function* (prompt, opts): AsyncGenerator<AgentMessage> {
    const q = query({
      prompt,
      options: buildQueryOptions(opts.cwd, profile.model),
    })
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') yield { type: 'assistant', text: block.text }
          if (block.type === 'tool_use')
            yield { type: 'assistant', tool: `${block.name} ${JSON.stringify(block.input).slice(0, 120)}` }
        }
      }
      if (msg.type === 'result') {
        // SDKResultMessage is a discriminated union on `subtype`: only the 'success'
        // variant carries `result`; error variants carry `errors: string[]` instead
        // (there is no shared `.result` field to fall back on). Both variants carry
        // `usage`/`total_cost_usd` — a failed session still spent real tokens.
        yield {
          type: 'result',
          ok: msg.subtype === 'success',
          text: msg.subtype === 'success' ? msg.result : msg.errors.join('; ') || 'agent failed',
          usage: {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            costUsd: msg.total_cost_usd,
          },
        }
      }
    }
  }
}
