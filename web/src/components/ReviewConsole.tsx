import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Collapsible } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

import type { RunEvent } from '../types.js'

const GLYPH: Record<RunEvent['kind'], string> = {
  status: '›',
  tool: '⚙',
  text: '',
  error: '✕',
}

const GLYPH_CLASS: Record<RunEvent['kind'], string> = {
  status: 'text-primary-400',
  tool: 'text-code-muted',
  text: 'text-code-muted',
  error: 'text-destructive-400',
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function ConsoleBody({ events, running }: { events: RunEvent[]; running: boolean }) {
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [events])

  return (
    <div
      ref={feedRef}
      className="font-family-mono max-h-96 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed"
    >
      {events.map((e, i) => (
        <div key={i} className="flex gap-2">
          <span className={cn('w-4 shrink-0 select-none text-center', GLYPH_CLASS[e.kind])}>{GLYPH[e.kind]}</span>
          <span className="text-code-foreground min-w-0 flex-1 whitespace-pre-wrap break-words">{e.text}</span>
        </div>
      ))}
      {running && (
        <div className="flex gap-2">
          <span className="w-4 shrink-0" />
          <span className="text-code-foreground motion-safe:animate-pulse">▌</span>
        </div>
      )}
    </div>
  )
}

export function ReviewConsole({
  events,
  running,
  startedAt,
  finishedAt,
}: {
  events: RunEvent[]
  running: boolean
  startedAt: string
  finishedAt?: string
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  const elapsedMs = running
    ? now - new Date(startedAt).getTime()
    : finishedAt
      ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
      : 0
  const duration = formatDuration(elapsedMs)

  const panelClass = 'bg-code-surface overflow-hidden rounded-lg border border-code-muted/20'

  if (!running && events.length === 0) return null

  if (!running) {
    return (
      <Collapsible className={panelClass}>
        <Collapsible.Trigger className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left">
          <span className="text-code-muted font-family-mono truncate text-xs">
            Agent feed · {duration} · {events.length} events
          </span>
          <ChevronDown className="text-code-muted h-4 w-4 shrink-0" />
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div className="border-code-muted/20 border-t">
            <ConsoleBody events={events} running={false} />
          </div>
        </Collapsible.Content>
      </Collapsible>
    )
  }

  return (
    <div className={panelClass}>
      <div className="border-code-muted/20 flex items-center justify-between border-b px-4 py-2">
        <span className="text-code-muted font-family-mono text-xs lowercase tracking-wide">agent feed</span>
        <span className="text-code-muted font-family-mono text-xs">{duration}</span>
      </div>
      <ConsoleBody events={events} running={running} />
    </div>
  )
}
