import { useEffect, useMemo, useState } from 'react'
import { Inbox, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import { getReviewerPrs, type ReviewerPrsResult } from '../api.js'
import { timeAgo } from '../lib/time.js'

type ProviderFilter = 'all' | 'github' | 'bitbucket'

/** Dialog listing open PRs where the user is a requested reviewer (both providers), with
 * text search and a provider filter. Selected PRs are handed back as canonical URLs. */
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
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState<ProviderFilter>('all')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setResult(null)
    setError('')
    setPicked(new Set())
    setQuery('')
    setProvider('all')
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

  const visible = useMemo(() => {
    if (!result) return []
    const q = query.trim().toLowerCase()
    return result.prs.filter((p) => {
      if (provider !== 'all' && p.provider !== provider) return false
      if (q === '') return true
      return `${p.title} ${p.workspace}/${p.repo}#${p.id} ${p.author}`.toLowerCase().includes(q)
    })
  }, [result, query, provider])

  const toggle = (url: string) => {
    const next = new Set(picked)
    next.has(url) ? next.delete(url) : next.add(url)
    setPicked(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Panel className="max-w-2xl">
        <Dialog.Header className="flex flex-col gap-3">
          <div>
            <Dialog.Title>PRs awaiting your review</Dialog.Title>
            <Dialog.Description>Open pull requests where you are a requested reviewer.</Dialog.Description>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative sm:flex-1">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                className="pl-9"
                placeholder="Search title, repo, author…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="flex shrink-0 gap-1.5">
              {(['all', 'github', 'bitbucket'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className={cn(
                    'cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                    provider === p
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-primary hover:text-foreground',
                  )}
                >
                  {p === 'all' ? 'All' : p}
                </button>
              ))}
            </div>
          </div>
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
              {visible.length === 0 ? (
                <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-10">
                  <Inbox className="text-muted-foreground h-5 w-5" />
                  <p className="text-muted-foreground text-sm">
                    {result.prs.length === 0 ? 'No open PRs waiting on you.' : 'No PRs match your filter.'}
                  </p>
                </div>
              ) : (
                <div className="divide-border border-border divide-y overflow-hidden rounded-lg border">
                  {visible.map((p) => (
                    <label
                      key={p.url}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors',
                        picked.has(p.url) ? 'bg-primary/10' : 'hover:bg-primary/5',
                      )}
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
                      <span className="text-muted-foreground w-14 shrink-0 text-right text-xs">{timeAgo(p.updatedAt)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </Dialog.Content>
        <Dialog.Footer className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">
            {result ? `${visible.length} of ${result.prs.length} PRs` : ''}
          </span>
          <div className="flex gap-2">
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
          </div>
        </Dialog.Footer>
      </Dialog.Panel>
    </Dialog>
  )
}
