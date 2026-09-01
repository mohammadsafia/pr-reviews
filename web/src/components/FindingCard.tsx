import { toast } from 'sonner'

import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible } from '@/components/ui/collapsible'
import { Tooltip } from '@/components/ui/tooltip'
import { extractFence } from '@/lib/markdown'
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
  isNew,
  selectable = true,
}: {
  finding: Finding
  index: number
  checked: boolean
  onToggle: (index: number) => void
  isNew?: boolean
  selectable?: boolean
}) {
  const location = `${finding.file}:${finding.line}`
  const example = finding.example ? extractFence(finding.example) : null
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
        {selectable && (
          <Checkbox
            checked={checked}
            onCheckedChange={() => onToggle(index)}
            className="mt-1 shrink-0"
            aria-label={`Select finding at ${location}`}
          />
        )}
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
            {isNew && (
              <span className="bg-primary-15 text-primary rounded px-1.5 py-0.5 text-xs">new</span>
            )}
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
          {example && (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs font-medium">Example fix</span>
              <pre className="bg-code-surface text-code-foreground font-family-mono overflow-x-auto rounded-md p-3 text-xs">
                {example.code}
              </pre>
            </div>
          )}
          {finding.suggestion && (
            <p className="text-sm">
              <span className="font-medium">Fix: </span>
              {finding.suggestion}
            </p>
          )}
          {finding.context && finding.context.length > 0 && (
            <Collapsible>
              <Collapsible.Trigger className="text-muted-foreground hover:text-foreground w-fit text-xs">
                Show context
              </Collapsible.Trigger>
              <Collapsible.Content>
                <pre className="bg-code-surface text-code-foreground font-family-mono mt-1 overflow-x-auto rounded-md p-3 text-xs">
                  {finding.context.map((l, i) => (
                    <div
                      key={i}
                      className={cn(
                        'flex gap-2',
                        l.type === 'add' && 'text-success',
                        l.type === 'remove' && 'text-destructive',
                      )}
                    >
                      <span className="text-muted-foreground w-8 shrink-0 text-right select-none">
                        {l.type === 'remove' ? l.oldLine : l.newLine}
                      </span>
                      <span className="w-3 shrink-0 select-none">
                        {l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ''}
                      </span>
                      <span className="whitespace-pre">{l.text}</span>
                    </div>
                  ))}
                </pre>
              </Collapsible.Content>
            </Collapsible>
          )}
        </div>
      </Card.Content>
    </Card>
  )
}
