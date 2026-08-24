import { describe, it, expect } from 'vitest'
import { cliQuery } from '../src/models/cli.js'
import type { ModelProfile } from '../src/models/profiles.js'

type CliProfile = Extract<ModelProfile, { kind: 'cli' }>
const base: Omit<CliProfile, 'command' | 'args'> = { id: 'fake', label: 'Fake', kind: 'cli' }

async function collect(q: ReturnType<typeof cliQuery>, prompt: string, cwd: string) {
  const events: any[] = []
  for await (const msg of q(prompt, { cwd })) events.push(msg)
  return events
}

describe('cliQuery', () => {
  it('substitutes {prompt} and {cwd} into args and returns stdout as the result', async () => {
    const p: CliProfile = {
      ...base,
      command: 'node',
      args: ['-e', 'console.log(process.argv[1] + "|" + process.argv[2])', '{prompt}', '{cwd}'],
    }
    const events = await collect(cliQuery(p), 'hello', '/tmp')
    const result = events.find((e) => e.type === 'result')
    expect(result.ok).toBe(true)
    expect(result.text.trim()).toBe('hello|/tmp')
  })

  it('feeds the prompt via stdin when no arg contains {prompt}, and streams stdout as assistant events', async () => {
    const p: CliProfile = {
      ...base,
      command: 'node',
      args: ['-e', 'process.stdin.on("data", (d) => process.stdout.write("got:" + d))'],
    }
    const events = await collect(cliQuery(p), 'from-stdin', '/tmp')
    expect(events.some((e) => e.type === 'assistant' && /got:from-stdin/.test(e.text ?? ''))).toBe(true)
    const result = events.find((e) => e.type === 'result')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('got:from-stdin')
  })

  it('reports non-zero exit as a failure carrying the stderr tail', async () => {
    const p: CliProfile = { ...base, command: 'node', args: ['-e', 'console.error("kaboom"); process.exit(3)'] }
    const result = (await collect(cliQuery(p), 'x', '/tmp')).find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('exit 3')
    expect(result.text).toContain('kaboom')
  })

  it('reports a missing command as a failure, not a crash', async () => {
    const p: CliProfile = { ...base, command: '/nonexistent/agent-cli', args: [] }
    const result = (await collect(cliQuery(p), 'x', '/tmp')).find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
  })

  it('kills a hung process at timeoutMs and reports a timeout failure', async () => {
    const p: CliProfile = { ...base, command: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 300 }
    const result = (await collect(cliQuery(p), 'x', '/tmp')).find((e) => e.type === 'result')
    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/timed out/i)
  }, 10000)
})
