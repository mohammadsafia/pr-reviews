import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs } from '@/components/ui/tabs'
import { FindingCard } from '@/components/FindingCard'
import { parseMarkdown } from '@/lib/markdown'
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

const SEVERITY_EMOJI: Record<Severity, string> = { high: '🔴', medium: '🟠', low: '🟡', info: 'ℹ️' }
const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }

/** Mirrors the exact comment body the server posts (formatComment in
 * server/src/review/comment.ts), so the confirm dialog shows the user precisely what will
 * land on the pull request. Keep the two in sync. */
export function formatCommentBody(f: Finding): string {
  const parts = [
    `**${SEVERITY_EMOJI[f.severity]} ${SEVERITY_LABEL[f.severity]} · ${f.category}** — ${f.summary}`,
    `**Why:** ${f.detail}`,
  ]
  if (f.example) parts.push(f.example)
  if (f.suggestion) parts.push(`**Fix:** ${f.suggestion}`)
  return parts.join('\n\n')
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

/** Renders formatCommentBody()'s output as formatted markdown instead of showing its literal
 * `**`/``` syntax — the dialog's promise is to show precisely what will post, and raw markdown
 * source doesn't read as "precisely what will post" to a human. */
function CommentPreview({ body }: { body: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {parseMarkdown(body).map((segment, i) =>
        segment.type === 'code' ? (
          <pre key={i} className="bg-code-surface text-code-foreground font-family-mono overflow-x-auto rounded-md p-3 text-xs">
            {segment.code}
          </pre>
        ) : (
          <p key={i}>
            {segment.parts.map((part, j) => (part.bold ? <strong key={j}>{part.text}</strong> : <span key={j}>{part.text}</span>))}
          </p>
        ),
      )}
    </div>
  )
}

export function RunView() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [run, setRun] = useState<RunRecord | null>(null)
  const [live, setLive] = useState<RunEvent[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [preview, setPreview] = useState<PostPreview | null>(null)
  const [tab, setTab] = useState<'findings' | 'console'>('findings')

  useEffect(() => {
    let cancelled = false
    let unsub = () => {}
    getRun(id)
      .then((r) => {
        if (cancelled) return
        setRun(r)
        setLive(r.transcript)
        if (r.status === 'running' || r.status === 'queued') {
          setTab('console')
          unsub = subscribeRun(
            id,
            (e) => {
              if (!cancelled) setLive((prev) => [...prev, e])
            },
            () => {
              if (!cancelled) {
                getRun(id)
                  .then((r2) => {
                    if (cancelled) return
                    setRun(r2)
                    if (r2.status === 'completed') {
                      setTab('findings')
                      const n = r2.findings.length
                      toast.success(`Review complete — ${n} finding${n === 1 ? '' : 's'}`)
                    }
                  })
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
      <div>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <Alert.Title>Couldn't load run</Alert.Title>
          <Alert.Description>{loadError}</Alert.Description>
        </Alert>
      </div>
    )
  }
  if (!run) return <p className="text-muted-foreground text-sm">Loading…</p>

  const active = run.status === 'running' || run.status === 'queued'
  const failed = failedSkillNames(run)

  function toggleFinding(index: number) {
    const next = new Set(checked)
    next.has(index) ? next.delete(index) : next.add(index)
    setChecked(next)
  }

  function prUrl(r: RunRecord): string {
    return r.pr.provider === 'github'
      ? `https://github.com/${r.pr.workspace}/${r.pr.repo}/pull/${r.pr.id}`
      : `https://bitbucket.org/${r.pr.workspace}/${r.pr.repo}/pull-requests/${r.pr.id}`
  }

  async function retry() {
    if (!run) return
    const res = await createRun({
      url: prUrl(run),
      skills: run.skills,
      focus: run.focus,
      verify: run.verify,
      depth: run.depth,
      profile: run.reviewProfile,
      force: true,
      parentRunId: run.id,
    })
    if (res.id) navigate(`/runs/${res.id}`)
  }

  async function retryFailedSkills() {
    if (!run) return
    const failedNames = failedSkillNames(run)
    if (failedNames.length === 0) return
    const res = await createRun({
      url: prUrl(run),
      skills: failedNames,
      focus: run.focus,
      verify: run.verify,
      depth: run.depth,
      profile: run.reviewProfile,
      force: true,
      parentRunId: run.id,
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
      if (result.failed.length > 0) toast.error(message)
      else toast.success(message)
      setChecked(remainingChecked)
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to post comments')
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
    <div className="flex flex-col gap-6 pb-24">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{run.prTitle}</h1>
            <StatusBadge status={run.status} />
          </div>
          <div className="flex shrink-0 gap-2">
            {run.status === 'failed' && (
              <Button variant="secondary" size="sm" onClick={retry}>
                Retry run
              </Button>
            )}
            {failed.length > 0 && (run.status === 'completed' || run.status === 'failed') && (
              <Button variant="secondary" size="sm" onClick={retryFailedSkills}>
                Retry failed skills ({failed.length})
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="muted" size="xs" className="font-family-mono">
            {run.pr.workspace}/{run.pr.repo}#{run.pr.id}
          </Badge>
          {run.reviewProfile && (
            <Badge variant="muted" size="xs">
              {run.reviewProfile}
            </Badge>
          )}
          {run.depth && (
            <Badge variant="muted" size="xs" className="capitalize">
              {run.depth}
            </Badge>
          )}
          <Badge variant={run.verify ? 'accent' : 'muted'} size="xs">
            {run.verify ? 'verified' : 'unverified run'}
          </Badge>
          {run.usage ? (
            <Badge variant="muted" size="xs">
              {(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tokens
              {run.usage.costUsd !== undefined && ` · $${run.usage.costUsd.toFixed(2)}`}
            </Badge>
          ) : (
            run.status === 'completed' && (
              <Badge variant="muted" size="xs">
                cost unavailable
              </Badge>
            )
          )}
          {run.skills.map((s) => (
            <Badge key={s} variant="muted" size="xs">
              {s}
            </Badge>
          ))}
        </div>
      </div>

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

      {run.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <Alert.Title>Run failed</Alert.Title>
          <Alert.Description>{run.error}</Alert.Description>
        </Alert>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'findings' | 'console')}>
        <Tabs.List>
          <Tabs.Trigger value="findings">
            Findings{run.status === 'completed' ? ` (${run.findings.length})` : ''}
          </Tabs.Trigger>
          <Tabs.Trigger value="console">Console</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="findings">
          <div className="flex flex-col gap-5">
            {run.skillResults.length > 0 && (
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
            )}

            {run.autoSubmitResult && (
              <p className="text-muted-foreground text-sm">
                {run.autoSubmitResult.dedupeChecked
                  ? `Auto-posted ${run.autoSubmitResult.posted} comment${run.autoSubmitResult.posted === 1 ? '' : 's'}` +
                    (run.autoSubmitResult.skipped > 0 ? ` · ${run.autoSubmitResult.skipped} skipped` : '') +
                    (run.autoSubmitResult.failed > 0 ? ` · ${run.autoSubmitResult.failed} failed` : '')
                  : 'Auto-post skipped — existing comments could not be checked.'}
              </p>
            )}

            {run.status === 'completed' && run.verify && (
              <p className="text-muted-foreground text-sm">
                {run.findings.filter((f) => f.verdict === 'confirmed').length} confirmed ·{' '}
                {run.findings.filter((f) => f.verdict === 'unverified').length} unverified
              </p>
            )}

            {run.status === 'completed' && run.findings.length === 0 ? (
              <Alert variant="success">
                <CheckCircle2 className="h-4 w-4" />
                <Alert.Description>Nothing to flag. The agent reviewed this PR clean.</Alert.Description>
              </Alert>
            ) : active ? (
              <p className="text-muted-foreground text-sm">Review in progress — findings appear when the run completes.</p>
            ) : (
              // Partition confirmed vs unverified FIRST, then group each partition by severity
              // — so every confirmed finding renders above every unverified one.
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
          </div>
        </Tabs.Content>

        <Tabs.Content value="console">
          <ReviewConsole events={live} running={active} startedAt={run.createdAt} finishedAt={run.finishedAt} />
        </Tabs.Content>
      </Tabs>

      {checked.size > 0 && (
        <div className="animate-in slide-in-from-bottom-4 border-border bg-popover fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-full border py-2 pr-2 pl-5 shadow-deep">
          <span className="text-sm font-medium">{checked.size} selected</span>
          <Button size="sm" className="rounded-full" onClick={() => setConfirming(true)}>
            Post to PR…
          </Button>
        </div>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <Dialog.Panel>
          <Dialog.Header>
            <Dialog.Title>Post {newCount} comments?</Dialog.Title>
            <Dialog.Description>These comments will be created on the pull request.</Dialog.Description>
          </Dialog.Header>
          <Dialog.Content>
            {!dedupeChecked && (
              <p className="bg-muted-200 text-muted-foreground mb-3 rounded px-3 py-2 text-xs">
                Couldn't check the PR for existing comments — nothing will be de-duplicated.
              </p>
            )}
            <ScrollArea className="max-h-96">
              <ul className="flex flex-col gap-4">
                {selectedItems.map(({ finding, index }) => {
                  const status = statusForIndex(preview, index)
                  return (
                    <li
                      key={index}
                      className="border-border flex flex-col gap-2 border-b pb-4 text-sm last:border-0 last:pb-0"
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
                      <CommentPreview body={formatCommentBody(finding)} />
                    </li>
                  )
                })}
              </ul>
            </ScrollArea>
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
    </div>
  )
}
