import { describe, it, expect, vi } from 'vitest'
import { runReview, type AgentQuery } from '../src/review/runner.js'
import { buildQueryOptions } from '../src/models/claude.js'
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

const input = (query: AgentQuery, reformatQuery: AgentQuery = query) => ({
  meta,
  skills: [],
  cwd: '/tmp',
  query,
  reformatQuery,
})

function fakeAgent(...resultTexts: string[]): AgentQuery {
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
    const findings = await runReview(input(fakeAgent(goodJson)), (e) => events.push(e))
    expect(findings).toHaveLength(1)
    expect(events.some((e) => e.kind === 'text' && e.text === 'thinking')).toBe(true)
    expect(events.some((e) => e.kind === 'tool')).toBe(true)
  })

  it('retries once on malformed findings, then succeeds', async () => {
    const findings = await runReview(input(fakeAgent('no json at all', goodJson)), () => {})
    expect(findings).toHaveLength(1)
  })

  it('fails after the single retry is also malformed', async () => {
    await expect(runReview(input(fakeAgent('bad', 'still bad')), () => {})).rejects.toThrow(/JSON findings/)
  })

  it('fails when the agent result is not ok', async () => {
    const agent: AgentQuery = async function* () {
      yield { type: 'result' as const, ok: false, text: 'agent crashed' }
    }
    await expect(runReview(input(agent), () => {})).rejects.toThrow(/agent crashed/)
  })

  it('derives validSkills from the skill group and reattributes unknown labels', async () => {
    const mislabeled = { ...finding, skill: 'nonsense' }
    const agent: AgentQuery = async function* () {
      yield { type: 'result', ok: true, text: '```json\n' + JSON.stringify([mislabeled]) + '\n```' }
    }
    const out = await runReview(
      {
        meta,
        skills: [
          { name: 'sec', content: 'c' },
          { name: 'perf', content: 'c' },
        ],
        cwd: '/tmp',
        query: agent,
        reformatQuery: agent,
      },
      () => {},
    )
    expect(out[0].skills).toEqual(['sec'])
  })

  it('runs the reformat retry on reformatQuery, not the main query', async () => {
    const calls: string[] = []
    const main: AgentQuery = async function* () {
      calls.push('main')
      yield { type: 'result', ok: true, text: 'no json here' }
    }
    const cheap: AgentQuery = async function* () {
      calls.push('cheap')
      yield { type: 'result', ok: true, text: goodJson }
    }
    const out = await runReview({ meta, skills: [], cwd: '/tmp', query: main, reformatQuery: cheap }, () => {})
    expect(out).toHaveLength(1)
    expect(calls).toEqual(['main', 'cheap'])
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
    expect((opts as any).allowedTools ?? []).not.toEqual(
      expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']),
    )
  })

  it('passes through cwd and model', () => {
    const opts = buildQueryOptions('/tmp/cwd', 'claude-opus-4-8')
    expect(opts.cwd).toBe('/tmp/cwd')
    expect(opts.model).toBe('claude-opus-4-8')
  })
})

describe('claudeQuery usage', () => {
  it('extracts usage and cost from a successful SDK result', async () => {
    vi.resetModules()
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: () =>
        (async function* () {
          yield {
            type: 'result',
            subtype: 'success',
            result: 'done',
            total_cost_usd: 0.05,
            usage: { input_tokens: 500, output_tokens: 80 },
          }
        })(),
    }))
    const { claudeQuery } = await import('../src/models/claude.js')
    const q = claudeQuery({ id: 'c', label: 'Claude', kind: 'claude', model: 'claude-sonnet-5' })
    const events: any[] = []
    for await (const m of q('prompt', { cwd: '/tmp' })) events.push(m)
    const result = events.find((e) => e.type === 'result')
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 80, costUsd: 0.05 })
    vi.doUnmock('@anthropic-ai/claude-agent-sdk')
  })

  it('extracts usage and cost from a failed SDK result — a failed session still spent tokens', async () => {
    vi.resetModules()
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: () =>
        (async function* () {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            errors: ['boom'],
            total_cost_usd: 0.02,
            usage: { input_tokens: 300, output_tokens: 10 },
          }
        })(),
    }))
    const { claudeQuery } = await import('../src/models/claude.js')
    const q = claudeQuery({ id: 'c', label: 'Claude', kind: 'claude', model: 'claude-sonnet-5' })
    const events: any[] = []
    for await (const m of q('prompt', { cwd: '/tmp' })) events.push(m)
    const result = events.find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 10, costUsd: 0.02 })
    vi.doUnmock('@anthropic-ai/claude-agent-sdk')
  })
})
