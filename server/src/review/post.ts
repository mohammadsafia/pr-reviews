import { formatComment } from './comment.js'
import { commentMarker, fingerprint, parseFingerprint } from './fingerprint.js'
import type { PrProviderClient, PrRef, RunRecord } from '../types.js'

/** Reads existing PR comments and returns fp→resolved plus whether the read succeeded. */
export async function readExistingFingerprints(
  client: PrProviderClient,
  pr: PrRef,
): Promise<{ fps: Map<string, boolean>; dedupeChecked: boolean }> {
  const fps = new Map<string, boolean>()
  try {
    for (const c of await client.listComments(pr)) {
      const fp = parseFingerprint(c.body)
      if (fp === undefined) continue
      fps.set(fp, (fps.get(fp) ?? false) || c.resolved)
    }
    return { fps, dedupeChecked: true }
  } catch {
    return { fps, dedupeChecked: false }
  }
}

/** The comment-posting loop shared by the manual route and auto-submit. Idempotent via
 * fingerprints; stops at the first failure. With requireDedupe (auto-submit), a failed
 * comment read posts NOTHING — no human is watching the "couldn't verify" warning. */
export async function postFindingComments(
  client: PrProviderClient,
  run: RunRecord,
  findingIndexes: number[],
  save: (run: RunRecord) => void,
  opts: { requireDedupe?: boolean } = {},
): Promise<{
  posted: number[]
  skipped: { index: number; reason: 'already-posted' | 'resolved' }[]
  failed: { index: number; error: string }[]
  dedupeChecked: boolean
}> {
  const { fps, dedupeChecked } = await readExistingFingerprints(client, run.pr)
  const posted: number[] = []
  const skipped: { index: number; reason: 'already-posted' | 'resolved' }[] = []
  const failed: { index: number; error: string }[] = []
  if (opts.requireDedupe && !dedupeChecked) return { posted, skipped, failed, dedupeChecked }
  for (const i of findingIndexes) {
    const f = run.findings[i]
    if (!f) continue
    const fp = fingerprint(run.pr, f)
    if (fps.has(fp)) {
      skipped.push({ index: i, reason: fps.get(fp) ? 'resolved' : 'already-posted' })
      continue
    }
    const text = `${formatComment(f)}\n\n${commentMarker(fp)}`
    try {
      const commentId = await client.postInlineComment(run.pr, { path: f.file, line: f.line, text })
      posted.push(commentId)
      run.postedCommentIds.push(commentId)
      save(run)
      // Record the fingerprint as posted (open, i.e. not resolved) so a later finding in
      // this same batch with an identical fingerprint is skipped instead of double-posting.
      fps.set(fp, false)
    } catch (err: any) {
      failed.push({ index: i, error: err.message })
      break
    }
  }
  return { posted, skipped, failed, dedupeChecked }
}
