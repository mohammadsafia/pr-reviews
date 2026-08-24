import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

import { filterSkills, inferCategory } from '../lib/skills.js'
import type { SkillInfo } from '../types.js'

export function SkillPicker({
  skills,
  selected,
  onToggle,
  onSelectAll,
  onDeselectAll,
}: {
  skills: SkillInfo[]
  selected: Set<string>
  onToggle: (name: string) => void
  onSelectAll: (visible: SkillInfo[]) => void
  onDeselectAll: (visible: SkillInfo[]) => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')

  const categories = useMemo(() => [...new Set(skills.map(inferCategory))].sort(), [skills])
  const visible = useMemo(() => filterSkills(skills, query, category), [skills, query, category])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Skills</h2>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => onDeselectAll(skills)}
              className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors"
            >
              {selected.size} selected <X className="h-3 w-3" />
            </button>
          )}
          <Button type="button" variant="ghost-muted" size="xs" disabled={visible.length === 0} onClick={() => onSelectAll(visible)}>
            Select all
          </Button>
          <Button type="button" variant="ghost-muted" size="xs" disabled={visible.length === 0} onClick={() => onDeselectAll(visible)}>
            None
          </Button>
        </div>
      </div>

      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
        <Input className="pl-9" placeholder="Search skills…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {['all', ...categories].map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setCategory(cat)}
            className={cn(
              'cursor-pointer rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize transition-colors',
              category === cat
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:border-primary hover:text-foreground',
            )}
          >
            {cat === 'all' ? 'All' : cat}
          </button>
        ))}
      </div>

      {skills.length > 0 && visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">No skills match your search.</p>
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <ScrollArea className="max-h-[360px]">
            <div className="divide-border divide-y">
              {visible.map((s) => (
                <label
                  key={s.dir}
                  title={s.description}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors',
                    selected.has(s.name) ? 'bg-primary/10' : 'hover:bg-primary/5',
                  )}
                >
                  <Checkbox checked={selected.has(s.name)} onCheckedChange={() => onToggle(s.name)} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{s.name}</span>
                    <span className="text-muted-foreground block truncate text-xs">{s.description}</span>
                  </span>
                  <Badge variant="muted" size="xs" className="hidden shrink-0 sm:inline-flex">
                    {s.source.split('/').filter(Boolean).pop()}
                  </Badge>
                </label>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
