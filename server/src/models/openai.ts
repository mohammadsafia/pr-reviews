import type { AgentMessage, AgentQuery } from '../review/runner.js'
import type { ModelProfile } from './profiles.js'
import { TOOL_DEFS, runTool } from './tools.js'

const MAX_ITERATIONS = 40

/** OpenAI-compatible chat-completions loop (Kimi/Moonshot, OpenAI, DeepSeek…). WE execute
 * the tool calls locally, confined to the worktree — API-only models get the same agentic
 * repo access the SDK/CLI adapters have. */
export function openaiQuery(
  profile: Extract<ModelProfile, { kind: 'openai' }>,
  fetchFn: typeof fetch = fetch,
): AgentQuery {
  return async function* (prompt, opts): AsyncGenerator<AgentMessage> {
    const messages: any[] = [{ role: 'user', content: prompt }]
    let lastText = ''
    let inputTokens = 0
    let outputTokens = 0
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let res: Response
      try {
        res = await fetchFn(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
          body: JSON.stringify({ model: profile.model, messages, tools: TOOL_DEFS }),
        })
      } catch (err: any) {
        yield { type: 'result', ok: false, text: `API request failed: ${err.message}`, usage: { inputTokens, outputTokens } }
        return
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300)
        yield { type: 'result', ok: false, text: `API error ${res.status}: ${body}`, usage: { inputTokens, outputTokens } }
        return
      }
      const data: any = await res.json()
      if (data.usage) {
        inputTokens += data.usage.prompt_tokens ?? 0
        outputTokens += data.usage.completion_tokens ?? 0
      }
      const message = data.choices?.[0]?.message
      if (!message) {
        yield { type: 'result', ok: false, text: 'API returned no message', usage: { inputTokens, outputTokens } }
        return
      }
      messages.push(message)
      if (typeof message.content === 'string' && message.content !== '') {
        lastText = message.content
        yield { type: 'assistant', text: message.content }
      }
      const toolCalls: any[] = message.tool_calls ?? []
      if (toolCalls.length === 0) {
        yield { type: 'result', ok: true, text: lastText, usage: { inputTokens, outputTokens } }
        return
      }
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function?.arguments ?? '{}')
        } catch {
          // malformed arguments: run with empty args so the tool reports the problem back
        }
        const name = call.function?.name ?? ''
        yield { type: 'assistant', tool: `${name} ${JSON.stringify(args).slice(0, 120)}` }
        const result = runTool(opts.cwd, name, args)
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.content })
      }
    }
    yield { type: 'result', ok: true, text: lastText, usage: { inputTokens, outputTokens } }
  }
}
