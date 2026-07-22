import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { RunStatus } from '../types.js'

const LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
}

const VARIANT: Record<RunStatus, 'muted' | 'default' | 'success' | 'destructive'> = {
  queued: 'muted',
  running: 'default',
  completed: 'success',
  failed: 'destructive',
}

export function StatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <Badge
      variant={VARIANT[status]}
      className={cn(status === 'running' && '**:data-[slot=badge-dot]:motion-safe:animate-pulse', className)}
    >
      {LABEL[status]}
    </Badge>
  )
}
