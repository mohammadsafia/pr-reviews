import type { Finding, PrMeta, RunEvent } from '../types.js'
import { FindingsParseError, extractFindings } from './findings.js'
import { buildReviewPrompt } from './prompt.js'

export type AgentMessage =
  | { type: 'assistant'; text?: string; tool?: string }
  | {
      type: 'result'
      ok: boolean
      text: string
      usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
    }

/** One agent session. Adapters close over their model profile — callers only supply the
 * working directory; model choice is an orchestration concern (see models/resolve.ts). */
export type AgentQuery = (prompt: string, opts: { cwd: string }) => AsyncIterable<AgentMessage>

async function runOnce(
  prompt: string,
  cwd: string,
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery,
): Promise<string> {
  let resultText: string | undefined
  for await (const msg of agentQuery(prompt, { cwd })) {
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
    skills: { name: string; content: string }[]
    focus?: string
    cwd: string
    query: AgentQuery
    reformatQuery: AgentQuery
  },
  onEvent: (e: RunEvent) => void,
): Promise<Finding[]> {
  const validSkills = input.skills.length > 0 ? input.skills.map((s) => s.name) : ['general']
  const text = await runOnce(buildReviewPrompt(input), input.cwd, onEvent, input.query)
  try {
    return extractFindings(text, validSkills)
  } catch (err) {
    if (!(err instanceof FindingsParseError)) throw err
    onEvent({ kind: 'status', text: 'Output malformed — asking agent to reformat', at: new Date().toISOString() })
    // Pure formatting fix — no reasoning needed, so the cheap verify model handles it.
    const retryText = await runOnce(REFORMAT_PROMPT + text, input.cwd, onEvent, input.reformatQuery)
    return extractFindings(retryText, validSkills)
  }
}
