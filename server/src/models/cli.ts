import { spawn } from 'node:child_process'
import type { AgentMessage, AgentQuery } from '../review/runner.js'
import type { ModelProfile } from './profiles.js'

const DEFAULT_TIMEOUT_MS = 900_000
const STDERR_TAIL = 2000

/** Adapter for agentic CLIs (Codex CLI, Gemini CLI, …). The CLI brings its own harness
 * and login; tool restrictions cannot be injected here — the profile's args must carry
 * them (e.g. codex's --sandbox read-only). */
export function cliQuery(profile: Extract<ModelProfile, { kind: 'cli' }>): AgentQuery {
  return async function* (prompt, opts): AsyncGenerator<AgentMessage> {
    const args = profile.args.map((a) => a.replaceAll('{cwd}', opts.cwd).replaceAll('{prompt}', prompt))
    const viaStdin = !profile.args.some((a) => a.includes('{prompt}'))
    const timeoutMs = profile.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const child = spawn(profile.command, args, { cwd: opts.cwd })
    let stdout = ''
    let stderr = ''
    const pending: AgentMessage[] = []
    let finished: { code: number | null; timedOut: boolean; spawnError?: string } | undefined
    let wake: (() => void) | undefined
    const notify = () => {
      wake?.()
      wake = undefined
    }

    const timer = setTimeout(() => {
      finished = { code: null, timedOut: true }
      child.kill('SIGKILL')
      notify()
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString()
      stdout += text
      pending.push({ type: 'assistant', text })
      notify()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      finished ??= { code: null, timedOut: false, spawnError: err.message }
      notify()
    })
    child.on('close', (code) => {
      finished ??= { code, timedOut: false }
      notify()
    })

    if (viaStdin) {
      child.stdin.on('error', () => {}) // a failed spawn destroys stdin; surfaced via 'error' above
      child.stdin.write(prompt)
      child.stdin.end()
    } else {
      child.stdin.end()
    }

    try {
      while (true) {
        while (pending.length > 0) yield pending.shift()!
        if (finished) break
        await new Promise<void>((res) => {
          wake = res
        })
      }
      while (pending.length > 0) yield pending.shift()!
      if (finished!.timedOut) {
        yield { type: 'result', ok: false, text: `CLI timed out after ${timeoutMs}ms` }
      } else if (finished!.spawnError !== undefined) {
        yield { type: 'result', ok: false, text: `CLI failed to start: ${finished!.spawnError}` }
      } else if (finished!.code !== 0) {
        yield { type: 'result', ok: false, text: `exit ${finished!.code}: ${stderr.slice(-STDERR_TAIL)}` }
      } else {
        yield { type: 'result', ok: true, text: stdout }
      }
    } finally {
      clearTimeout(timer)
      if (!finished) child.kill('SIGKILL')
    }
  }
}
