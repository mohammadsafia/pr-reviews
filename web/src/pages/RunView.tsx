import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'

import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { FindingCard } from '@/components/FindingCard'
import { ReviewConsole } from '@/components/ReviewConsole'
import { StatusBadge } from '@/components/StatusBadge'

import { createRun, getRun, postComments, subscribeRun, type PostCommentsResult } from '../api.js'
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
  return `**[AI review — ${f.severity}/${f.category}]** ${f.summary}\n\n${f.detail}\n\n**Suggestion:** ${f.suggestion}`
}

/**
 * Interprets a POST /api/runs/:id/comments result against the finding indexes that were
 * sent. The server processes `sentIndexes` in order and stops at the first failure, so the
 * first `posted.length` entries of `sentIndexes` are exactly the ones that succeeded — the
 * rest (the failed one and anything never attempted) stay checked so the user can retry them.
 */
export function applyPostResult(
  sentIndexes: number[],
  result: PostCommentsResult,
  checked: Set<number>,
): { message: string; remainingChecked: Set<number> } {
  const succeededIndexes = new Set(sentIndexes.slice(0, result.posted.length))
  const remainingChecked = new Set([...checked].filter((i) => !succeededIndexes.has(i)))
  const n = result.posted.length
  let message = `Posted ${n} comment${n === 1 ? '' : 's'}.`
  if (result.failed.length > 0) {
    message += ` Failed: ${result.failed.map((f) => `#${f.index} — ${f.error}`).join('; ')}.`
  }
  return { message, remainingChecked }
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
    const res = await createRun({
      url: `https://bitbucket.org/${run.pr.workspace}/${run.pr.repo}/pull-requests/${run.pr.id}`,
      skills: run.skills,
      focus: run.focus,
      force: true,
    })
    if (res.id) navigate(`/runs/${res.id}`)
  }

  async function post() {
    const sentIndexes = [...checked]
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

      {run.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <Alert.Title>Run failed</Alert.Title>
          <Alert.Description className="flex flex-col gap-2">
            <span>{run.error}</span>
            <Button variant="secondary" size="sm" className="w-fit" onClick={retry}>
              Retry run
            </Button>
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
            groupFindingsBySeverity(run.findings).map((g) => (
              <div key={g.severity} className="flex flex-col gap-3">
                <Badge variant={SEVERITY_VARIANT[g.severity]} size="sm" className="w-fit capitalize">
                  {g.severity}
                </Badge>
                <div className="flex flex-col gap-3">
                  {g.items.map(({ finding, index }) => (
                    <FindingCard
                      key={index}
                      finding={finding}
                      index={index}
                      checked={checked.has(index)}
                      onToggle={toggleFinding}
                    />
                  ))}
                </div>
              </div>
            ))
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
            <Dialog.Title>Post {checked.size} comments to Bitbucket?</Dialog.Title>
            <Dialog.Description>These comments will be created on the pull request.</Dialog.Description>
          </Dialog.Header>
          <Dialog.Content>
            <ul className="flex max-h-96 flex-col gap-4 overflow-y-auto">
              {selectedItems.map(({ finding, index }) => (
                <li key={index} className="border-muted-200 flex flex-col gap-2 border-b pb-4 text-sm last:border-0 last:pb-0">
                  <span className="bg-code-surface text-code-foreground font-family-mono w-fit rounded px-1.5 py-0.5 text-xs">
                    {finding.file}:{finding.line}
                  </span>
                  <pre className="font-family-sans whitespace-pre-wrap text-sm">{formatCommentBody(finding)}</pre>
                </li>
              ))}
            </ul>
          </Dialog.Content>
          <Dialog.Footer className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={post}>Post {checked.size} comments</Button>
          </Dialog.Footer>
        </Dialog.Panel>
      </Dialog>
    </main>
  )
}
