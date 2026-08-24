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
      className={cn(
        status === 'running' &&
          '**:data-[slot=badge-dot]:motion-safe:animate-pulse **:data-[slot=badge-dot]:shadow-[0_0_8px_var(--primary)]',
        status === 'queued' &&
          '**:data-[slot=badge-dot]:border **:data-[slot=badge-dot]:border-current **:data-[slot=badge-dot]:bg-transparent',
        className,
      )}
    >
      {LABEL[status]}
    </Badge>
  )
}
