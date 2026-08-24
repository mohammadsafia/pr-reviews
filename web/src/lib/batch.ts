import type { createRun } from '../api.js'
import type { AutoSubmit } from '../types.js'

export type BatchOutcome =
  | { url: string; kind: 'started'; id: string }
  | { url: string; kind: 'oversized'; diffLines: number }
  | { url: string; kind: 'error'; message: string }

/** Submits one run per URL, sequentially — each POST makes the server fetch PR meta and
 * diff from the provider, so a serial loop keeps the burst polite. One URL's failure
 * never stops the rest. */
export async function submitBatch(
  urls: string[],
  opts: {
    skills: string[]
    focus?: string
    verify: boolean
    depth?: 'thorough' | 'balanced' | 'economy'
    profile?: string
    autoSubmit?: AutoSubmit
    force?: boolean
  },
  createRunFn: typeof createRun,
): Promise<BatchOutcome[]> {
  const out: BatchOutcome[] = []
  for (const url of urls) {
    const res = await createRunFn({ url, ...opts })
    if (res.id) out.push({ url, kind: 'started', id: res.id })
    else if (res.status === 409) out.push({ url, kind: 'oversized', diffLines: res.diffLines ?? 0 })
    else out.push({ url, kind: 'error', message: res.error ?? 'Failed to start run' })
  }
  return out
}
