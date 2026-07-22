import { describe, it, expect } from 'vitest'
import { runReview, buildQueryOptions } from '../src/review/runner.js'
import type { RunEvent } from '../src/types.js'

const meta = {
  title: 'T',
  description: '',
  sourceBranch: 's',
  destinationBranch: 'd',
  sourceCommit: 'c',
}
const finding = {
  file: 'a.ts',
  line: 1,
  severity: 'low',
  category: 'style',
  summary: 's',
  detail: 'd',
  suggestion: 'fix',
  skill: 'review-code',
}
const goodJson = '```json\n' + JSON.stringify([finding]) + '\n```'
const input = { meta, diff: 'd', skills: [], cwd: '/tmp', model: 'm' }

function fakeAgent(...resultTexts: string[]) {
  let call = 0
  return async function* (_prompt: string) {
    yield { type: 'assistant' as const, text: 'thinking' }
    yield { type: 'assistant' as const, tool: 'Read a.ts' }
    yield { type: 'result' as const, ok: true, text: resultTexts[call++] }
  }
}

describe('runReview', () => {
  it('streams events and returns parsed findings', async () => {
    const events: RunEvent[] = []
    const findings = await runReview(input, (e) => events.push(e), fakeAgent(goodJson))
    expect(findings).toHaveLength(1)
    expect(events.some((e) => e.kind === 'text' && e.text === 'thinking')).toBe(true)
    expect(events.some((e) => e.kind === 'tool')).toBe(true)
  })

  it('retries once on malformed findings, then succeeds', async () => {
    const findings = await runReview(input, () => {}, fakeAgent('no json at all', goodJson))
    expect(findings).toHaveLength(1)
  })

  it('fails after the single retry is also malformed', async () => {
    await expect(
      runReview(input, () => {}, fakeAgent('bad', 'still bad')),
    ).rejects.toThrow(/JSON findings/)
  })

  it('fails when the agent result is not ok', async () => {
    const agent = async function* () {
      yield { type: 'result' as const, ok: false, text: 'agent crashed' }
    }
    await expect(runReview(input, () => {}, agent)).rejects.toThrow(/agent crashed/)
  })
})

describe('buildQueryOptions', () => {
  it('restricts the agent to read-only tools via the real allow-list option', () => {
    const opts = buildQueryOptions('/tmp/cwd', 'claude-sonnet-5')
    expect(opts.tools).toEqual(['Read', 'Grep', 'Glob'])
  })

  it('also sets disallowedTools as defense in depth against dangerous tools', () => {
    const opts = buildQueryOptions('/tmp/cwd', 'claude-sonnet-5')
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']),
    )
  })

  it('does not rely on allowedTools alone (that option is auto-approve, not a restriction)', () => {
    const opts = buildQueryOptions('/tmp/cwd', 'claude-sonnet-5')
    // allowedTools must not list any dangerous tool as auto-approved
    expect(opts.allowedTools ?? []).not.toEqual(
      expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']),
    )
  })

  it('passes through cwd and model', () => {
    const opts = buildQueryOptions('/tmp/cwd', 'claude-opus-4-8')
    expect(opts.cwd).toBe('/tmp/cwd')
    expect(opts.model).toBe('claude-opus-4-8')
  })
})
