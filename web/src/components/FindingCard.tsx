import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'

import type { Finding } from '../types.js'

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
  return (
    <Card shadow="sm">
      <Card.Content className="flex items-start gap-3 py-4">
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggle(index)}
          className="mt-1 shrink-0"
          aria-label={`Select finding at ${finding.file}:${finding.line}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="bg-code-surface text-code-foreground font-family-mono rounded px-1.5 py-0.5 text-xs">
              {finding.file}:{finding.line}
            </span>
            <span className="text-muted-foreground text-xs">
              {finding.category} · {finding.skills.join(', ')}
            </span>
            {finding.verdict === 'unverified' && (
              <span className="bg-muted-200 text-muted-foreground rounded px-1.5 py-0.5 text-xs">
                unverified
              </span>
            )}
          </div>
          <p className="font-medium">{finding.summary}</p>
          <p className="text-muted-foreground text-sm">{finding.detail}</p>
          {finding.verdict === 'unverified' && finding.verifierReason && (
            <p className="text-muted-foreground text-xs italic">{finding.verifierReason}</p>
          )}
          {finding.suggestion && (
            <pre className="bg-code-surface text-code-foreground overflow-x-auto rounded-md p-3 text-xs">
              {finding.suggestion}
            </pre>
          )}
        </div>
      </Card.Content>
    </Card>
  )
}
