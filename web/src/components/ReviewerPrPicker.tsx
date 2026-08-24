import { useEffect, useState } from 'react'
import { Inbox } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'

import { getReviewerPrs, type ReviewerPrsResult } from '../api.js'
import { timeAgo } from '../lib/time.js'

/** Dialog listing open PRs where the user is a requested reviewer (both providers).
 * Selected PRs are handed back as their canonical URLs for the URL textarea. */
export function ReviewerPrPicker({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (urls: string[]) => void
}) {
  const [result, setResult] = useState<ReviewerPrsResult | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setResult(null)
    setError('')
    setPicked(new Set())
    getReviewerPrs()
      .then((r) => {
        if (!cancelled) setResult(r)
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? 'Failed to load PRs')
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const toggle = (url: string) => {
    const next = new Set(picked)
    next.has(url) ? next.delete(url) : next.add(url)
    setPicked(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Panel>
        <Dialog.Header>
          <Dialog.Title>PRs awaiting your review</Dialog.Title>
          <Dialog.Description>Open pull requests where you are a requested reviewer.</Dialog.Description>
        </Dialog.Header>
        <Dialog.Content>
          {result === null && !error && (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
          {result && (
            <div className="flex flex-col gap-3">
              {result.errors.map((e) => (
                <p key={e.provider} className="text-warning text-xs">
                  {e.provider}: {e.message}
                </p>
              ))}
              {result.prs.length === 0 ? (
                <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-10">
                  <Inbox className="text-muted-foreground h-5 w-5" />
                  <p className="text-muted-foreground text-sm">No open PRs waiting on you.</p>
                </div>
              ) : (
                <ScrollArea className="max-h-96">
                  <div className="divide-border border-border divide-y rounded-lg border">
                    {result.prs.map((p) => (
                      <label
                        key={p.url}
                        className="hover:bg-primary/5 flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors"
                      >
                        <Checkbox checked={picked.has(p.url)} onCheckedChange={() => toggle(p.url)} className="shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{p.title}</span>
                          <span className="text-muted-foreground font-family-mono block truncate text-xs">
                            {p.workspace}/{p.repo}#{p.id} · {p.author}
                          </span>
                        </span>
                        <Badge variant="muted" size="xs" className="shrink-0">
                          {p.provider}
                        </Badge>
                        <span className="text-muted-foreground shrink-0 text-xs">{timeAgo(p.updatedAt)}</span>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          )}
        </Dialog.Content>
        <Dialog.Footer className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={picked.size === 0}
            onClick={() => {
              onAdd([...picked])
              onOpenChange(false)
            }}
          >
            Add {picked.size || ''} selected
          </Button>
        </Dialog.Footer>
      </Dialog.Panel>
    </Dialog>
  )
}
