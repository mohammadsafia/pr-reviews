import type { RunStatus } from '../types.js'

/** Poll the runs list only while something can still change. */
export function shouldPoll(runs: { status: RunStatus }[]): boolean {
  return runs.some((r) => r.status === 'queued' || r.status === 'running')
}
