import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openaiQuery } from '../src/models/openai.js'
import type { ModelProfile } from '../src/models/profiles.js'

const profile: Extract<ModelProfile, { kind: 'openai' }> = {
  id: 'kimi', label: 'Kimi', kind: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'kimi-k2',
}

let cwd: string
beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'prr-oai-'))
  execFileSync('git', ['init', '-q'], { cwd })
  writeFileSync(join(cwd, 'a.ts'), 'const secretBug = 1\n')
  execFileSync('git', ['add', '.'], { cwd })
})

const msg = (content: string | null, tool_calls?: any[]) => ({
  choices: [{ message: { role: 'assistant', content, tool_calls } }],
})

function fakeFetch(responses: any[]) {
  const calls: { url: string; body: any; headers: any }[] = []
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
    const next = responses.shift()
    if (next.status) return new Response(JSON.stringify(next.body ?? {}), { status: next.status })
    return new Response(JSON.stringify(next), { status: 200 })
  }) as typeof fetch
  return { fn, calls }
}

async function collect(q: ReturnType<typeof openaiQuery>, prompt: string, dir: string) {
  const events: any[] = []
  for await (const m of q(prompt, { cwd: dir })) events.push(m)
  return events
}

describe('openaiQuery', () => {
  it('executes a tool call locally, feeds the result back, and returns the final text', async () => {
    const { fn, calls } = fakeFetch([
      msg(null, [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]),
      msg('```json\n[]\n```'),
    ])
    const events = await collect(openaiQuery(profile, fn), 'review it', cwd)
    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions')
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test')
    // second request carries the tool result with the real file content
    const toolMsg = calls[1].body.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('secretBug')
    expect(events.some((e) => e.type === 'assistant' && /read_file/.test(e.tool ?? ''))).toBe(true)
    const result = events.find((e) => e.type === 'result')
    expect(result.ok).toBe(true)
    expect(result.text).toBe('```json\n[]\n```')
  })

  it('accumulates prompt/completion tokens across a multi-iteration tool-calling loop', async () => {
    const { fn } = fakeFetch([
      { ...msg(null, [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]), usage: { prompt_tokens: 100, completion_tokens: 20 } },
      { ...msg('```json\n[]\n```'), usage: { prompt_tokens: 150, completion_tokens: 30 } },
    ])
    const result = (await collect(openaiQuery(profile, fn), 'review it', cwd)).find((e) => e.type === 'result')
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 50 })
  })

  it('maps HTTP errors to a failed result without echoing the key', async () => {
    const { fn } = fakeFetch([{ status: 401, body: { error: 'bad key' } }])
    const result = (await collect(openaiQuery(profile, fn), 'x', cwd)).find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('401')
    expect(result.text).not.toContain('sk-test')
  })

  it('stops at the iteration ceiling and uses the last assistant text', async () => {
    const loop = Array.from({ length: 45 }, () =>
      msg('thinking', [{ id: 't', type: 'function', function: { name: 'list_files', arguments: '{}' } }]),
    )
    const { fn, calls } = fakeFetch(loop)
    const result = (await collect(openaiQuery(profile, fn), 'x', cwd)).find((e) => e.type === 'result')
    expect(calls.length).toBe(40)
    expect(result.ok).toBe(true)
    expect(result.text).toBe('thinking')
  })

  it('answers an out-of-worktree path with a tool error and lets the loop continue', async () => {
    const { fn, calls } = fakeFetch([
      msg(null, [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"../outside"}' } }]),
      msg('done'),
    ])
    const result = (await collect(openaiQuery(profile, fn), 'x', cwd)).find((e) => e.type === 'result')
    const toolMsg = calls[1].body.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toMatch(/outside/i)
    expect(result.ok).toBe(true)
  })
})
