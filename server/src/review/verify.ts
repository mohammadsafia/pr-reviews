import { z } from 'zod'
import { sdkQuery, type AgentQuery } from './runner.js'
import type { Finding, PrMeta, RunEvent } from '../types.js'

const VerdictSchema = z.object({
  verdict: z.enum(['confirmed', 'unverified']),
  reason: z.string().optional(),
})

function buildVerifyPrompt(finding: Finding, meta: PrMeta, diff: string): string {
  return `You are adversarially verifying a single claimed code-review finding on a pull request.
The repository is checked out at your working directory at the PR's head commit.
Use Read/Grep/Glob to inspect the ACTUAL code. Try to REFUTE the finding.

# Pull request
Title: ${meta.title}

# Claimed finding
File: ${finding.file}:${finding.line}
Severity: ${finding.severity} · Category: ${finding.category}
Summary: ${finding.summary}
Detail: ${finding.detail}
Suggested fix: ${finding.suggestion}

# Diff under review
\`\`\`diff
${diff}
\`\`\`

# Your job
Re-read the real code around ${finding.file}:${finding.line}. Decide:
- "confirmed" ONLY if the issue is real AND applies to code changed in this diff.
- "unverified" if it's wrong, already handled, not in the changed code, or you cannot confirm it.
When uncertain, answer "unverified".

# Output contract (strict)
End your reply with ONE fenced \`\`\`json object, nothing after it:
{ "verdict": "confirmed" | "unverified", "reason": "one short sentence" }`
}

function extractVerdict(text: string): { verdict: 'confirmed' | 'unverified'; reason?: string } | undefined {
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  const raw = fenced.length > 0 ? fenced[fenced.length - 1][1] : text.trim()
  try {
    const parsed = VerdictSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export async function verifyFinding(
  finding: Finding,
  ctx: { meta: PrMeta; diff: string; cwd: string; model: string },
  onEvent: (e: RunEvent) => void,
  agentQuery: AgentQuery = sdkQuery,
): Promise<{ verdict: 'confirmed' | 'unverified'; reason?: string }> {
  const emit = (e: RunEvent) => onEvent({ ...e, skill: 'verify' })
  const opts = { cwd: ctx.cwd, model: ctx.model }
  try {
    let resultText: string | undefined
    for await (const msg of agentQuery(buildVerifyPrompt(finding, ctx.meta, ctx.diff), opts)) {
      const at = new Date().toISOString()
      if (msg.type === 'assistant') {
        if (msg.text) emit({ kind: 'text', text: msg.text, at })
        if (msg.tool) emit({ kind: 'tool', text: msg.tool, at })
      } else {
        if (!msg.ok) throw new Error(msg.text)
        resultText = msg.text
      }
    }
    const parsed = resultText !== undefined ? extractVerdict(resultText) : undefined
    if (!parsed) throw new Error('unparseable verdict')
    return parsed
  } catch (err: any) {
    emit({ kind: 'error', text: `verifier failed: ${err.message}`, at: new Date().toISOString() })
    return { verdict: 'confirmed', reason: `verifier failed: ${err.message}` }
  }
}
