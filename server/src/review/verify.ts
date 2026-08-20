import { z } from 'zod'
import { sdkQuery, type AgentQuery } from './runner.js'
import type { Finding, PrMeta, RunEvent } from '../types.js'

const CHUNK = 20

const BatchItemSchema = z.object({
  index: z.number().int().nonnegative(),
  verdict: z.enum(['confirmed', 'unverified']),
  reason: z.string().optional(),
})

export type Verdict = { verdict: 'confirmed' | 'unverified'; reason?: string }

export function buildBatchVerifyPrompt(findings: Finding[], meta: PrMeta, offset: number): string {
  const items = findings.map((f, i) => ({
    index: offset + i,
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category,
    summary: f.summary,
    detail: f.detail,
    suggestion: f.suggestion,
  }))
  return `You are adversarially verifying claimed code-review findings on a pull request.
The repository is checked out at your working directory at the PR's head commit.

READ FIRST (with the Read tool):
- .pr-review/pr.md — PR context and the changed-file list
- .pr-review/diff.patch — the diff; read the sections around each finding

# Pull request
Title: ${meta.title}

# Claimed findings
\`\`\`json
${JSON.stringify(items, null, 2)}
\`\`\`

# Your job
For EACH finding, re-read the real code at its file:line and try to REFUTE it. Decide:
- "confirmed" ONLY if the issue is real AND applies to code changed in this diff.
- "unverified" if it's wrong, already handled, not in the changed code, or you cannot confirm it.
When uncertain, answer "unverified".

# Output contract (strict)
End your reply with ONE fenced \`\`\`json block containing a JSON array with one entry per finding:
[{ "index": <number from the list above>, "verdict": "confirmed" | "unverified", "reason": "one short sentence" }]
Do not put any text after the json block.`
}

export function extractBatchVerdicts(text: string): Map<number, Verdict> | undefined {
  // Closing fence anchored to a line start, mirroring findings.ts's candidateJson — reasons
  // inside the JSON could carry ``` sequences, which are never preceded by a raw newline.
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  const raw = fenced.length > 0 ? fenced[fenced.length - 1][1] : text.trim()
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(arr)) return undefined
  const map = new Map<number, Verdict>()
  for (const item of arr) {
    const parsed = BatchItemSchema.safeParse(item)
    if (!parsed.success) continue
    if (!map.has(parsed.data.index)) {
      map.set(parsed.data.index, { verdict: parsed.data.verdict, reason: parsed.data.reason })
    }
  }
  return map
}

const VERDICT_REFORMAT_PROMPT =
  'Your previous reply did not end with a valid ```json verdicts array. ' +
  'Reply now with ONLY the ```json array [{"index":<n>,"verdict":"confirmed"|"unverified","reason":"..."}], nothing else. ' +
  'Previous reply:\n\n'

/** Runs one agent turn and returns its final result text (the resolved text from the
 * `result` message), mirroring runner.ts's runOnce. Throws if the agent errors or never
 * produces a result. */
async function runVerifyTurn(
  prompt: string,
  opts: { cwd: string; model: string },
  emit: (e: RunEvent) => void,
  agentQuery: AgentQuery,
): Promise<string> {
  let resultText: string | undefined
  for await (const msg of agentQuery(prompt, opts)) {
    const at = new Date().toISOString()
    if (msg.type === 'assistant') {
      if (msg.text) emit({ kind: 'text', text: msg.text, at })
      if (msg.tool) emit({ kind: 'tool', text: msg.tool, at })
    } else {
      if (!msg.ok) throw new Error(msg.text)
      resultText = msg.text
    }
  }
  if (resultText === undefined) throw new Error('Agent run produced no result message.')
  return resultText
}

/** Verifies all findings in batched sessions (CHUNK per session) on the cheap verify model.
 * Returns verdicts aligned index-for-index with the input. Fail-open everywhere: a finding
 * is never dropped or downgraded because the VERIFIER broke. */
export async function verifyFindingsBatch(
  findings: Finding[],
  ctx: { meta: PrMeta; cwd: string; model: string },
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery = sdkQuery,
): Promise<Verdict[]> {
  const out: Verdict[] = new Array(findings.length)
  const emit = (e: RunEvent) => onEvent({ ...e, skill: 'verify' })
  const opts = { cwd: ctx.cwd, model: ctx.model }
  for (let start = 0; start < findings.length; start += CHUNK) {
    const chunk = findings.slice(start, start + CHUNK)
    try {
      const text = await runVerifyTurn(buildBatchVerifyPrompt(chunk, ctx.meta, start), opts, emit, agentQuery)
      let verdicts = extractBatchVerdicts(text)
      if (!verdicts) {
        const retryText = await runVerifyTurn(VERDICT_REFORMAT_PROMPT + text, opts, emit, agentQuery)
        verdicts = extractBatchVerdicts(retryText)
        if (!verdicts) throw new Error('unparseable verdicts')
      }
      for (let i = 0; i < chunk.length; i++) {
        out[start + i] = verdicts.get(start + i) ?? { verdict: 'confirmed', reason: 'verifier gave no verdict' }
      }
    } catch (err: any) {
      emit({ kind: 'error', text: `verifier failed: ${err.message}`, at: new Date().toISOString() })
      for (let i = 0; i < chunk.length; i++) {
        out[start + i] = { verdict: 'confirmed', reason: `verifier failed: ${err.message}` }
      }
    }
  }
  return out
}
