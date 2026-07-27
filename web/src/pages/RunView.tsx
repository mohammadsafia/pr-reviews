import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'

import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { FindingCard } from '@/components/FindingCard'
import { failedSkillNames, runHasLoginExpiry } from '@/lib/runErrors'
import { ReviewConsole } from '@/components/ReviewConsole'
import { StatusBadge } from '@/components/StatusBadge'

import {
  createRun,
  getPostPreview,
  getRun,
  postComments,
  subscribeRun,
  type PostCommentsResult,
  type PostPreview,
} from '../api.js'
import type { Finding, RunEvent, RunRecord, Severity } from '../types.js'

const ORDER: Severity[] = ['high', 'medium', 'low', 'info']

const SEVERITY_VARIANT: Record<Severity, 'destructive' | 'warning' | 'accent' | 'muted'> = {
  high: 'destructive',
  medium: 'warning',
  low: 'accent',
  info: 'muted',
}

/** Mirrors the exact comment body the server posts (see the comments route in app.ts), so
 * the confirm dialog shows the user precisely what will land on the pull request. */
export function formatCommentBody(f: Finding): string {
  return `**[AI review — ${f.severity}/${f.category} · ${f.skills.join(', ')}]** ${f.summary}\n\n${f.detail}\n\n**Suggestion:** ${f.suggestion}`
}

/**
 * Interprets a POST /api/runs/:id/comments result against the finding indexes that were
 * sent. The server processes `sentIndexes` in order, skipping some (preview-vs-post race:
 * already posted/resolved by the time the post lands) and posting others, stopping at the
 * first failure. Skipped indexes don't consume a "posted" slot, so the succeeded set is the
 * first `posted.length` entries of the *attempted* (non-skipped) indexes — not a raw
 * positional slice of `sentIndexes`. Both succeeded and skipped indexes are cleared from
 * checked (skipped ones already exist on the PR); the rest (failed / never attempted) stay
 * checked so the user can retry them.
 */
export function applyPostResult(
  sentIndexes: number[],
  result: PostCommentsResult,
  checked: Set<number>,
): { message: string; remainingChecked: Set<number> } {
  const skippedSet = new Set(result.skipped.map((s) => s.index))
  const attempted = sentIndexes.filter((i) => !skippedSet.has(i))
  const succeededIndexes = new Set(attempted.slice(0, result.posted.length))
  const remainingChecked = new Set(
    [...checked].filter((i) => !succeededIndexes.has(i) && !skippedSet.has(i)),
  )
  const n = result.posted.length
  let message = `Posted ${n} comment${n === 1 ? '' : 's'}.`
  if (result.skipped.length > 0) {
    const already = result.skipped.filter((s) => s.reason === 'already-posted').length
    const resolved = result.skipped.filter((s) => s.reason === 'resolved').length
    const parts = [already ? `${already} already posted` : '', resolved ? `${resolved} resolved` : '']
      .filter(Boolean)
      .join(', ')
    message += ` Skipped ${result.skipped.length} (${parts}).`
  }
  if (result.failed.length > 0) {
    message += ` Failed: ${result.failed.map((f) => `#${f.index} — ${f.error}`).join('; ')}.`
  }
  return { message, remainingChecked }
}

/** Splits findings into a confirmed partition and an unverified partition, each finding
 * paired with its real index in the original array. Confirmed findings render above
 * unverified ones regardless of severity (the approved "unverified sorts below confirmed"
 * decision) — severity grouping within each partition is applied separately via
 * groupFindingsBySeverity, which is left untouched. */
export function partitionFindingsByVerdict(
  findings: Finding[],
): {
  confirmed: { finding: Finding; index: number }[]
  unverified: { finding: Finding; index: number }[]
} {
  const indexed = findings.map((finding, index) => ({ finding, index }))
  return {
    confirmed: indexed.filter((x) => x.finding.verdict === 'confirmed'),
    unverified: indexed.filter((x) => x.finding.verdict !== 'confirmed'),
  }
}

/** Looks up the preview-computed status for a single finding index. Returns 'new' when the
 * preview hasn't loaded yet (null) or when the index isn't present in preview.statuses — the
 * latter also covers the dedupeChecked:false fallback, since that path always yields either an
 * empty statuses array (client-side network failure) or statuses that already mark everything
 * 'new' (server-side dedupe failure). */
export function statusForIndex(
  preview: PostPreview | null,
  index: number,
): 'new' | 'already-posted' | 'resolved' {
  if (!preview) return 'new'
  return preview.statuses.find((s) => s.index === index)?.status ?? 'new'
}

/** The checked indexes that are actually eligible to post — i.e. still 'new' per the preview.
 * This is what gets sent to postComments; already-posted/resolved findings are excluded even
 * if checked, since posting them again would just be skipped server-side. */
export function postableIndexes(checked: Set<number>, preview: PostPreview | null): number[] {
  return [...checked].filter((i) => statusForIndex(preview, i) === 'new')
}

export function groupFindingsBySeverity(
  findings: Finding[],
): { severity: Severity; items: { finding: Finding; index: number }[] }[] {
  return ORDER.map((severity) => ({
    severity,
    items: findings
      .map((finding, index) => ({ finding, index }))
      .filter((x) => x.finding.severity === severity),
  })).filter((g) => g.items.length > 0)
}

export function RunView() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [run, setRun] = useState<RunRecord | null>(null)
  const [live, setLive] = useState<RunEvent[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [postMessage, setPostMessage] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [preview, setPreview] = useState<PostPreview | null>(null)

  useEffect(() => {
    let cancelled = false
    let unsub = () => {}
    getRun(id)
      .then((r) => {
        if (cancelled) return
        setRun(r)
        setLive(r.transcript)
        if (r.status === 'running' || r.status === 'queued') {
          unsub = subscribeRun(
            id,
            (e) => {
              if (!cancelled) setLive((prev) => [...prev, e])
            },
            () => {
              if (!cancelled) {
                getRun(id)
                  .then((r2) => !cancelled && setRun(r2))
                  .catch(() => {
                    // The run already finished server-side (that's why onDone fired); a
                    // transient refetch failure shouldn't blow away the page the user is
                    // looking at. The live transcript/status already reflect completion.
                  })
              }
            },
          )
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e?.message ?? 'Failed to load run')
      })
    return () => {
      cancelled = true
      unsub()
    }
  }, [id])

  useEffect(() => {
    if (!confirming) return
    let cancelled = false
    setPreview(null)
    getPostPreview(id)
      .then((p) => {
        if (!cancelled) setPreview(p)
      })
      .catch(() => {
        // No preview available (e.g. the PR couldn't be reached) — the dialog falls back
        // to treating every selected finding as 'new' via the dedupeChecked === false path.
        if (!cancelled) setPreview({ statuses: [], dedupeChecked: false })
      })
    return () => {
      cancelled = true
    }
  }, [confirming, id])

  if (loadError) {
    return (
      <main>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <Alert.Title>Couldn't load run</Alert.Title>
          <Alert.Description>{loadError}</Alert.Description>
        </Alert>
      </main>
    )
  }
  if (!run) return <p className="text-muted-foreground text-sm">Loading…</p>

  const active = run.status === 'running' || run.status === 'queued'

  function toggleFinding(index: number) {
    const next = new Set(checked)
    next.has(index) ? next.delete(index) : next.add(index)
    setChecked(next)
  }

  async function retry() {
    if (!run) return
    const url =
      run.pr.provider === 'github'
        ? `https://github.com/${run.pr.workspace}/${run.pr.repo}/pull/${run.pr.id}`
        : `https://bitbucket.org/${run.pr.workspace}/${run.pr.repo}/pull-requests/${run.pr.id}`
    const res = await createRun({
      url,
      skills: run.skills,
      focus: run.focus,
      verify: run.verify,
      force: true,
    })
    if (res.id) navigate(`/runs/${res.id}`)
  }

  async function retryFailedSkills() {
    if (!run) return
    const url =
      run.pr.provider === 'github'
        ? `https://github.com/${run.pr.workspace}/${run.pr.repo}/pull/${run.pr.id}`
        : `https://bitbucket.org/${run.pr.workspace}/${run.pr.repo}/pull-requests/${run.pr.id}`
    const res = await createRun({
      url,
      skills: failedSkillNames(run),
      focus: run.focus,
      verify: run.verify,
      force: true,
    })
    if (res.id) navigate(`/runs/${res.id}`)
  }

  // Once the preview loads, every selected finding gets a New/Already posted/Resolved status;
  // while it's still loading (preview === null) or the server couldn't check the PR
  // (dedupeChecked === false), every finding is treated as 'new' — dedupeChecked === false
  // additionally surfaces a warning so the user knows nothing is being de-duplicated.
  const dedupeChecked = preview?.dedupeChecked ?? true

  async function post() {
    const sentIndexes = postableIndexes(checked, preview)
    try {
      const result = await postComments(id, sentIndexes)
      const { message, remainingChecked } = applyPostResult(sentIndexes, result, checked)
      setPostMessage(message)
      setChecked(remainingChecked)
    } catch (err: any) {
      setPostMessage(err?.message ?? 'Failed to post comments')
    } finally {
      setConfirming(false)
    }
  }

  const selectedItems = run.findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ index }) => checked.has(index))
  const newCount = postableIndexes(checked, preview).length

  const { confirmed, unverified } = partitionFindingsByVerdict(run.findings)

  return (
    <main className="flex flex-col gap-8 pb-8">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-family-display text-2xl">{run.prTitle}</h1>
          <StatusBadge status={run.status} />
        </div>
        <p className="text-muted-foreground font-family-mono text-sm">
          {run.pr.workspace}/{run.pr.repo}#{run.pr.id}
        </p>
        {run.skills.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {run.skills.map((s) => (
              <Badge key={s} variant="muted" size="xs">
                {s}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <ReviewConsole events={live} running={active} startedAt={run.createdAt} finishedAt={run.finishedAt} />

      {runHasLoginExpiry(run) && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <Alert.Title>Your Claude login appears to have expired</Alert.Title>
          <Alert.Description>
            The review agent authenticates with your Claude login. Re-authenticate (run{' '}
            <code>/login</code>, or restart the tool with a valid <code>ANTHROPIC_API_KEY</code>), then retry.
          </Alert.Description>
        </Alert>
      )}

      {run.status === 'completed' && failedSkillNames(run).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-sm">
            {failedSkillNames(run).length} skill{failedSkillNames(run).length === 1 ? '' : 's'} failed on this run.
          </span>
          <Button variant="secondary" size="sm" className="w-fit" onClick={retryFailedSkills}>
            Retry failed skills ({failedSkillNames(run).length})
          </Button>
        </div>
      )}

      {run.skillResults.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-sm font-medium">Skill runs</h2>
          <div className="flex flex-wrap items-center gap-2">
            {run.skillResults.map((r) => (
              <div key={r.skill} className="flex items-center gap-1.5">
                <Badge
                  variant={r.status === 'completed' ? 'success' : 'destructive'}
                  size="xs"
                  title={r.status === 'failed' ? r.error : undefined}
                >
                  {r.skill} · {r.findingCount}
                </Badge>
                {r.status === 'failed' && r.error && (
                  <span className="text-muted-foreground max-w-64 truncate text-xs" title={r.error}>
                    {r.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {run.status === 'completed' &&
        (run.verify ? (
          <p className="text-muted-foreground text-sm">
            {run.findings.length} findings ·{' '}
            {run.findings.filter((f) => f.verdict === 'confirmed').length} confirmed ·{' '}
            {run.findings.filter((f) => f.verdict === 'unverified').length} unverified
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">{run.findings.length} findings · verification skipped</p>
        ))}

      {run.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <Alert.Title>Run failed</Alert.Title>
          <Alert.Description className="flex flex-col gap-2">
            <span>{run.error}</span>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" className="w-fit" onClick={retry}>
                Retry run
              </Button>
              {failedSkillNames(run).length > 0 && (
                <Button variant="secondary" size="sm" className="w-fit" onClick={retryFailedSkills}>
                  Retry failed skills ({failedSkillNames(run).length})
                </Button>
              )}
            </div>
          </Alert.Description>
        </Alert>
      )}

      {run.status === 'completed' && (
        <div className="flex flex-col gap-6">
          <div className="flex items-baseline gap-2">
            <h2 className="font-family-display text-xl">Findings</h2>
            <span className="text-muted-foreground text-sm">({run.findings.length})</span>
          </div>

          {run.findings.length === 0 ? (
            <Alert variant="success">
              <CheckCircle2 className="h-4 w-4" />
              <Alert.Description>Nothing to flag. The agent reviewed this PR clean.</Alert.Description>
            </Alert>
          ) : (
            // Partition confirmed vs unverified FIRST, then group each partition by severity
            // — so every confirmed finding renders above every unverified one, honoring
            // "unverified sorts below confirmed" regardless of severity.
            [
              { findings: confirmed.map((x) => x.finding), indexes: confirmed.map((x) => x.index) },
              { findings: unverified.map((x) => x.finding), indexes: unverified.map((x) => x.index) },
            ].map(({ findings, indexes }, partition) =>
              groupFindingsBySeverity(findings).map((g) => (
                <div key={`${partition}-${g.severity}`} className="flex flex-col gap-3">
                  <Badge variant={SEVERITY_VARIANT[g.severity]} size="sm" className="w-fit capitalize">
                    {g.severity}
                    {partition === 1 ? ' · unverified' : ''}
                  </Badge>
                  <div className="flex flex-col gap-3">
                    {g.items.map(({ finding, index: localIndex }) => {
                      const index = indexes[localIndex]
                      return (
                        <FindingCard
                          key={index}
                          finding={finding}
                          index={index}
                          checked={checked.has(index)}
                          onToggle={toggleFinding}
                        />
                      )
                    })}
                  </div>
                </div>
              )),
            )
          )}

          {postMessage && <p className="text-success text-sm">{postMessage}</p>}
        </div>
      )}

      {checked.size > 0 && (
        <div className="bg-background border-muted-200 sticky bottom-0 z-40 -mx-6 flex items-center justify-between gap-4 border-t px-6 py-4 shadow-deep sm:-mx-10 sm:px-10">
          <span className="text-sm font-medium">{checked.size} selected</span>
          <Button onClick={() => setConfirming(true)}>Post to Bitbucket…</Button>
        </div>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <Dialog.Panel>
          <Dialog.Header>
            <Dialog.Title>Post {newCount} comments to Bitbucket?</Dialog.Title>
            <Dialog.Description>These comments will be created on the pull request.</Dialog.Description>
          </Dialog.Header>
          <Dialog.Content>
            {!dedupeChecked && (
              <p className="bg-muted-200 text-muted-foreground mb-3 rounded px-3 py-2 text-xs">
                Couldn't check the PR for existing comments — nothing will be de-duplicated.
              </p>
            )}
            <ul className="flex max-h-96 flex-col gap-4 overflow-y-auto">
              {selectedItems.map(({ finding, index }) => {
                const status = statusForIndex(preview, index)
                return (
                  <li
                    key={index}
                    className="border-muted-200 flex flex-col gap-2 border-b pb-4 text-sm last:border-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="bg-code-surface text-code-foreground font-family-mono w-fit rounded px-1.5 py-0.5 text-xs">
                        {finding.file}:{finding.line}
                      </span>
                      {status === 'already-posted' && (
                        <Badge variant="muted" size="xs">
                          already posted
                        </Badge>
                      )}
                      {status === 'resolved' && (
                        <Badge variant="muted" size="xs">
                          resolved
                        </Badge>
                      )}
                    </div>
                    <pre className="font-family-sans whitespace-pre-wrap text-sm">{formatCommentBody(finding)}</pre>
                  </li>
                )
              })}
            </ul>
          </Dialog.Content>
          <Dialog.Footer className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={post} disabled={!preview || newCount === 0}>
              Post {newCount} comment{newCount === 1 ? '' : 's'}
            </Button>
          </Dialog.Footer>
        </Dialog.Panel>
      </Dialog>
    </main>
  )
}
