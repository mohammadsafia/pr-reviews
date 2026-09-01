import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/StatusBadge'

import { listRuns } from '../api.js'
import { summarizeUsage } from '../lib/usageSummary.js'
import { shouldPoll } from '../lib/runsPolling.js'
import { timeAgo } from '../lib/time.js'
import type { RunRecord } from '../types.js'

const POLL_MS = 3000

function UsageSummaryBar({ runs }: { runs: RunRecord[] }) {
  const s = summarizeUsage(runs)
  const parts = [
    `${runs.length} run${runs.length === 1 ? '' : 's'}`,
    `${(s.totalInputTokens + s.totalOutputTokens).toLocaleString()} tokens`,
  ]
  if (s.totalCostUsd !== undefined) parts.push(`$${s.totalCostUsd.toFixed(2)}`)
  if (s.unmeasuredRuns > 0) parts.push(`${s.unmeasuredRuns} without cost data`)

  return (
    <Collapsible>
      <Collapsible.Trigger className="text-muted-foreground hover:text-foreground text-sm">
        {parts.join(' · ')}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="border-border mt-2 flex flex-col gap-1 rounded-lg border p-3">
          {s.byProfile.map((p) => (
            <div key={p.profile} className="flex items-center justify-between text-sm">
              <span className="font-family-mono">{p.profile}</span>
              <span className="text-muted-foreground">
                {p.runs} run{p.runs === 1 ? '' : 's'} · {(p.inputTokens + p.outputTokens).toLocaleString()} tokens ·{' '}
                {p.costUsd !== undefined ? `$${p.costUsd.toFixed(2)}` : '—'}
              </span>
            </div>
          ))}
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function Runs() {
  const [runs, setRuns] = useState<RunRecord[] | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () =>
      listRuns()
        .then((r) => {
          if (cancelled) return
          setRuns(r)
          if (shouldPoll(r)) timer = setTimeout(tick, POLL_MS)
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(tick, POLL_MS)
        })
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <Button asChild size="sm">
          <Link to="/">
            <Plus className="mr-1 h-4 w-4" /> New review
          </Link>
        </Button>
      </div>

      {runs !== null && runs.length > 0 && <UsageSummaryBar runs={runs} />}

      {runs === null ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="border-border flex flex-col items-center gap-3 rounded-lg border border-dashed py-16">
          <p className="text-muted-foreground text-sm">No reviews yet.</p>
          <Button asChild size="sm" variant="secondary">
            <Link to="/">Start your first review</Link>
          </Button>
        </div>
      ) : (
        <div className="border-border divide-border divide-y overflow-hidden rounded-lg border">
          {runs.map((r) => (
            <Link
              key={r.id}
              to={`/runs/${r.id}`}
              className="bg-card hover:bg-primary/5 flex items-center gap-4 px-4 py-3 transition-colors"
            >
              <StatusBadge status={r.status} className="w-28 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.prTitle}</p>
                <p className="text-muted-foreground font-family-mono truncate text-xs">
                  {r.pr.workspace}/{r.pr.repo}#{r.pr.id}
                </p>
              </div>
              <div className="hidden items-center gap-1.5 sm:flex">
                {r.reviewProfile && (
                  <Badge variant="muted" size="xs">
                    {r.reviewProfile}
                  </Badge>
                )}
                {r.depth && (
                  <Badge variant="muted" size="xs" className="capitalize">
                    {r.depth}
                  </Badge>
                )}
                {r.status === 'completed' && (
                  <Badge variant="accent" size="xs">
                    {r.findings.length} finding{r.findings.length === 1 ? '' : 's'}
                  </Badge>
                )}
              </div>
              <span className="text-muted-foreground shrink-0 text-xs">{timeAgo(r.createdAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
