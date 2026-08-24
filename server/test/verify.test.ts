import { describe, it, expect } from 'vitest'
import { buildBatchVerifyPrompt, extractBatchVerdicts, verifyFindingsBatch } from '../src/review/verify.js'
import type { AgentQuery } from '../src/review/runner.js'
import type { Finding, PrMeta } from '../src/types.js'

const meta: PrMeta = { title: 'T', description: '', sourceBranch: 'f', destinationBranch: 'main', sourceCommit: '' }

const mkFinding = (n: number): Finding => ({
  file: `f${n}.ts`,
  line: n + 1,
  severity: 'low',
  category: 'style',
  summary: `finding ${n}`,
  detail: 'd',
  suggestion: 'x',
  skills: ['s'],
  verdict: 'confirmed',
})

const ok = (text: string) => ({ type: 'result' as const, ok: true, text })

describe('buildBatchVerifyPrompt', () => {
  it('carries the dispatch phrase, pack pointers, and globally-indexed findings — no inline diff', () => {
    const p = buildBatchVerifyPrompt([mkFinding(0), mkFinding(1)], meta, 20)
    expect(p).toContain('adversarially verifying')
    expect(p).toContain('.pr-review/diff.patch')
    expect(p).toContain('"index": 20')
    expect(p).toContain('"index": 21')
    expect(p).not.toContain('```diff')
  })
})

describe('extractBatchVerdicts', () => {
  it('parses the last json fence into a map, first verdict wins on duplicates, bad entries skipped', () => {
    const text =
      'thinking…\n```json\n' +
      JSON.stringify([
        { index: 0, verdict: 'confirmed' },
        { index: 1, verdict: 'unverified', reason: 'nope' },
        { index: 1, verdict: 'confirmed' },
        { index: 'bad', verdict: 'confirmed' },
      ]) +
      '\n```'
    const m = extractBatchVerdicts(text)!
    expect(m.get(0)).toEqual({ verdict: 'confirmed', reason: undefined })
    expect(m.get(1)).toEqual({ verdict: 'unverified', reason: 'nope' })
    expect(m.size).toBe(2)
  })

  it('returns undefined for unparseable text', () => {
    expect(extractBatchVerdicts('no json at all')).toBeUndefined()
    expect(extractBatchVerdicts('```json\n{"not":"array"}\n```')).toBeUndefined()
  })
})

describe('verifyFindingsBatch', () => {
  it('verifies all findings in one session and aligns verdicts with input order', async () => {
    let calls = 0
    const agent: AgentQuery = async function* (prompt) {
      calls++
      const items = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)![1]) as { index: number; summary: string }[]
      yield ok(
        '```json\n' +
          JSON.stringify(
            items.map((it) => ({
              index: it.index,
              verdict: it.summary === 'finding 1' ? 'unverified' : 'confirmed',
              reason: it.summary === 'finding 1' ? 'refuted' : undefined,
            })),
          ) +
          '\n```',
      )
    }
    const verdicts = await verifyFindingsBatch([mkFinding(0), mkFinding(1)], { meta, cwd: '/tmp' }, () => {}, agent)
    expect(calls).toBe(1)
    expect(verdicts[0].verdict).toBe('confirmed')
    expect(verdicts[1]).toEqual({ verdict: 'unverified', reason: 'refuted' })
  })

  it('fails open per finding when the verifier omits an index', async () => {
    const agent: AgentQuery = async function* () {
      yield ok('```json\n[{"index":0,"verdict":"confirmed"}]\n```')
    }
    const verdicts = await verifyFindingsBatch([mkFinding(0), mkFinding(1)], { meta, cwd: '/tmp' }, () => {}, agent)
    expect(verdicts[1]).toEqual({ verdict: 'confirmed', reason: 'verifier gave no verdict' })
  })

  it('retries once on unparseable output, then fails the whole chunk open', async () => {
    let calls = 0
    const agent: AgentQuery = async function* () {
      calls++
      yield ok('still not json')
    }
    const verdicts = await verifyFindingsBatch([mkFinding(0)], { meta, cwd: '/tmp' }, () => {}, agent)
    expect(calls).toBe(2)
    expect(verdicts[0].verdict).toBe('confirmed')
    expect(verdicts[0].reason).toMatch(/verifier failed/)
  })

  it('fails open when the agent session itself errors', async () => {
    const agent: AgentQuery = async function* () {
      yield { type: 'result' as const, ok: false, text: 'boom' }
    }
    const verdicts = await verifyFindingsBatch([mkFinding(0)], { meta, cwd: '/tmp' }, () => {}, agent)
    expect(verdicts[0].verdict).toBe('confirmed')
    expect(verdicts[0].reason).toMatch(/verifier failed: boom/)
  })

  it('chunks more than 20 findings into sequential sessions with global indexes', async () => {
    const prompts: string[] = []
    const agent: AgentQuery = async function* (prompt) {
      prompts.push(prompt)
      const items = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)![1]) as { index: number }[]
      yield ok('```json\n' + JSON.stringify(items.map((it) => ({ index: it.index, verdict: 'confirmed' }))) + '\n```')
    }
    const findings = Array.from({ length: 25 }, (_, i) => mkFinding(i))
    const verdicts = await verifyFindingsBatch(findings, { meta, cwd: '/tmp' }, () => {}, agent)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('"index": 20')
    expect(verdicts).toHaveLength(25)
    expect(verdicts.every((v) => v.verdict === 'confirmed')).toBe(true)
  })
})
