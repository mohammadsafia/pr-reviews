import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Finding, PrMeta, RunEvent } from '../types.js'
import { FindingsParseError, extractFindings } from './findings.js'
import { buildReviewPrompt } from './prompt.js'

export type AgentMessage =
  | { type: 'assistant'; text?: string; tool?: string }
  | { type: 'result'; ok: boolean; text: string }

export type AgentQuery = (
  prompt: string,
  opts: { cwd: string; model: string },
) => AsyncIterable<AgentMessage>

export const sdkQuery: AgentQuery = async function* (prompt, opts) {
  const q = query({
    prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      allowedTools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'bypassPermissions',
      // Required by the installed SDK whenever permissionMode is 'bypassPermissions' —
      // without it, query() throws synchronously before yielding anything.
      allowDangerouslySkipPermissions: true,
    },
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
      // (there is no shared `.result` field to fall back on).
      yield {
        type: 'result',
        ok: msg.subtype === 'success',
        text: msg.subtype === 'success' ? msg.result : msg.errors.join('; ') || 'agent failed',
      }
    }
  }
}

async function runOnce(
  prompt: string,
  opts: { cwd: string; model: string },
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery,
): Promise<string> {
  let resultText: string | undefined
  for await (const msg of agentQuery(prompt, opts)) {
    const at = new Date().toISOString()
    if (msg.type === 'assistant') {
      if (msg.text) onEvent({ kind: 'text', text: msg.text, at })
      if (msg.tool) onEvent({ kind: 'tool', text: msg.tool, at })
    } else {
      if (!msg.ok) throw new Error(`Agent run failed: ${msg.text}`)
      resultText = msg.text
    }
  }
  if (resultText === undefined) throw new Error('Agent run produced no result message.')
  return resultText
}

const REFORMAT_PROMPT =
  'Your previous reply did not end with a valid ```json findings array. ' +
  'Reply now with ONLY the ```json fenced array of findings from your review, nothing else. ' +
  'Previous reply:\n\n'

export async function runReview(
  input: {
    meta: PrMeta
    diff: string
    skills: { name: string; content: string }[]
    focus?: string
    cwd: string
    model: string
  },
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery = sdkQuery,
): Promise<Finding[]> {
  const opts = { cwd: input.cwd, model: input.model }
  const text = await runOnce(buildReviewPrompt(input), opts, onEvent, agentQuery)
  try {
    return extractFindings(text)
  } catch (err) {
    if (!(err instanceof FindingsParseError)) throw err
    onEvent({ kind: 'status', text: 'Output malformed — asking agent to reformat', at: new Date().toISOString() })
    const retryText = await runOnce(REFORMAT_PROMPT + text, opts, onEvent, agentQuery)
    return extractFindings(retryText)
  }
}
