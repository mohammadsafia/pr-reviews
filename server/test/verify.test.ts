import { describe, it, expect } from 'vitest'
import { verifyFinding } from '../src/review/verify.js'
import type { Finding, RunEvent } from '../src/types.js'

const finding: Finding = {
  file: 'a.ts', line: 1, severity: 'high', category: 'bug',
  summary: 'null deref', detail: 'x may be null', suggestion: 'guard it',
  skills: ['review-code'], verdict: 'confirmed',
}
const ctx = { meta: { title: 'T', description: '', sourceBranch: 's', destinationBranch: 'd', sourceCommit: 'c' }, diff: 'd', cwd: '/tmp', model: 'm' }

function fakeAgent(resultText: string, ok = true) {
  return async function* () {
    yield { type: 'assistant' as const, text: 'checking' }
    yield { type: 'result' as const, ok, text: resultText }
  }
}

describe('verifyFinding', () => {
  it('parses a confirmed verdict', async () => {
    const v = await verifyFinding(finding, ctx, () => {}, fakeAgent('```json\n{"verdict":"confirmed","reason":"real"}\n```'))
    expect(v.verdict).toBe('confirmed')
  })

  it('parses an unverified verdict with reason', async () => {
    const v = await verifyFinding(finding, ctx, () => {}, fakeAgent('```json\n{"verdict":"unverified","reason":"line not in changed code"}\n```'))
    expect(v.verdict).toBe('unverified')
    expect(v.reason).toBe('line not in changed code')
  })

  it('fails open to confirmed when the agent errors', async () => {
    const events: RunEvent[] = []
    const v = await verifyFinding(finding, ctx, (e) => events.push(e), fakeAgent('boom', false))
    expect(v.verdict).toBe('confirmed')
    expect(v.reason).toMatch(/verifier failed/)
    expect(events.some((e) => e.kind === 'error')).toBe(true)
  })

  it('fails open when the result is unparseable after retry', async () => {
    const v = await verifyFinding(finding, ctx, () => {}, fakeAgent('no json here'))
    expect(v.verdict).toBe('confirmed')
    expect(v.reason).toMatch(/verifier failed/)
  })

  it('tags emitted events with skill "verify"', async () => {
    const events: RunEvent[] = []
    await verifyFinding(finding, ctx, (e) => events.push(e), fakeAgent('```json\n{"verdict":"confirmed"}\n```'))
    expect(events.every((e) => e.skill === 'verify')).toBe(true)
  })
})
