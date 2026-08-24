import { toast } from 'sonner'

import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import type { Finding, Severity } from '../types.js'

const SEVERITY_BAR: Record<Severity, string> = {
  high: 'before:bg-destructive',
  medium: 'before:bg-warning',
  low: 'before:bg-warning-400',
  info: 'before:bg-primary-400',
}

export function FindingCard({
  finding,
  index,
  checked,
  onToggle,
}: {
  finding: Finding
  index: number
  checked: boolean
  onToggle: (index: number) => void
}) {
  const location = `${finding.file}:${finding.line}`
  return (
    <Card
      shadow="sm"
      className={cn(
        // severity accent: an inset bar that stops short of the rounded corners, instead of
        // a border-left that bends around them
        'relative before:absolute before:top-4 before:bottom-4 before:left-0 before:w-0.5 before:rounded-full',
        SEVERITY_BAR[finding.severity],
        finding.verdict === 'unverified' && 'opacity-70',
      )}
    >
      <Card.Content className="flex items-start gap-3 py-4">
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggle(index)}
          className="mt-1 shrink-0"
          aria-label={`Select finding at ${location}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(location)
                toast.success('Copied')
              }}
              title="Copy file:line"
              className="bg-code-surface text-code-foreground font-family-mono hover:text-primary-400 cursor-pointer rounded px-1.5 py-0.5 text-xs transition-colors"
            >
              {location}
            </button>
            <span className="text-muted-foreground text-xs">
              {finding.category} · {finding.skills.join(', ')}
            </span>
            {finding.verdict === 'unverified' && (
              <Tooltip>
                <Tooltip.Trigger asChild>
                  <span className="bg-muted-200 text-muted-foreground cursor-default rounded px-1.5 py-0.5 text-xs">
                    unverified
                  </span>
                </Tooltip.Trigger>
                <Tooltip.Content>{finding.verifierReason ?? 'Not confirmed by the verifier'}</Tooltip.Content>
              </Tooltip>
            )}
          </div>
          <p className="font-medium">{finding.summary}</p>
          <p className="text-muted-foreground text-sm">{finding.detail}</p>
          {finding.example && (
            <pre className="bg-code-surface text-code-foreground font-family-mono overflow-x-auto rounded-md p-3 text-xs">
              {finding.example}
            </pre>
          )}
          {finding.suggestion && (
            <pre className="bg-code-surface text-code-foreground font-family-mono overflow-x-auto rounded-md p-3 text-xs">
              {finding.suggestion}
            </pre>
          )}
        </div>
      </Card.Content>
    </Card>
  )
}
