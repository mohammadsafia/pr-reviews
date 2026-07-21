import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { StatusBadge } from '@/components/StatusBadge'

import { createRun, getSkills, listRuns } from '../api.js'
import type { RunRecord, SkillInfo } from '../types.js'

export function groupSkillsBySource(skills: SkillInfo[]): Map<string, SkillInfo[]> {
  const g = new Map<string, SkillInfo[]>()
  for (const s of skills) {
    if (!g.has(s.source)) g.set(s.source, [])
    g.get(s.source)!.push(s)
  }
  return g
}

const LAST_SKILLS_KEY = 'pr-reviewer.lastSkills'

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function sourceLabel(source: string): string {
  return source.split('/').filter(Boolean).pop() ?? source
}

export function NewReview() {
  const navigate = useNavigate()
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem(LAST_SKILLS_KEY) ?? '[]')),
  )
  const [url, setUrl] = useState('')
  const [focus, setFocus] = useState('')
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [error, setError] = useState('')
  const [oversized, setOversized] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getSkills().then(setSkills).catch((e) => setError(e.message))
    listRuns().then(setRuns).catch(() => {})
  }, [])

  function toggle(name: string) {
    const next = new Set(selected)
    next.has(name) ? next.delete(name) : next.add(name)
    setSelected(next)
    localStorage.setItem(LAST_SKILLS_KEY, JSON.stringify([...next]))
  }

  async function submit(force = false) {
    setBusy(true)
    setError('')
    setOversized(null)
    try {
      const res = await createRun({ url, skills: [...selected], focus: focus || undefined, force })
      if (res.id) navigate(`/runs/${res.id}`)
      else if (res.status === 409) setOversized(res.diffLines ?? 0)
      else setError(res.error ?? 'Failed to start run')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="font-family-display text-3xl">Review a pull request.</h1>
        <p className="text-muted-foreground text-sm">
          Paste a Bitbucket PR link, pick the skills to run, and we'll take it from there.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            className="h-12 font-family-mono text-sm sm:flex-1"
            placeholder="https://bitbucket.org/workspace/repo/pull-requests/123"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button
            size="lg"
            className="h-12 shrink-0"
            disabled={busy || !url}
            onClick={() => submit()}
          >
            {busy ? 'Starting…' : 'Run review'}
          </Button>
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
        {oversized !== null && (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <Alert.Title>Large diff</Alert.Title>
            <Alert.Description className="flex flex-col gap-2">
              <span>{oversized} changed lines — this may be slow and costly.</span>
              <Button
                variant="secondary"
                size="sm"
                className="w-fit"
                disabled={busy}
                onClick={() => submit(true)}
              >
                Run anyway
              </Button>
            </Alert.Description>
          </Alert>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">Skills to apply</h2>
        <div className="flex flex-col gap-4">
          {[...groupSkillsBySource(skills)].map(([source, group]) => (
            <Card key={source} shadow="sm">
              <Card.Header className="pb-2">
                <Card.Title className="text-base">{sourceLabel(source)}</Card.Title>
                <Card.Description className="truncate">{source}</Card.Description>
              </Card.Header>
              <Card.Content className="grid grid-cols-1 gap-x-6 gap-y-3 pt-0 sm:grid-cols-2">
                {group.map((s) => (
                  <label key={s.dir} className="flex min-w-0 items-start gap-2" title={s.description}>
                    <Checkbox
                      checked={selected.has(s.name)}
                      onCheckedChange={() => toggle(s.name)}
                      className="mt-0.5 shrink-0"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="min-w-0 truncate text-sm font-medium">{s.name}</span>
                      <span className="text-muted-foreground min-w-0 truncate text-xs">{s.description}</span>
                    </span>
                  </label>
                ))}
              </Card.Content>
            </Card>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="focus">Anything specific to watch for? (optional)</Label>
        <Textarea
          id="focus"
          placeholder='e.g. "pay attention to date handling"'
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No reviews yet. Paste a PR link above to run your first.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-muted-200">
            {runs.map((r) => (
              <Link
                key={r.id}
                to={`/runs/${r.id}`}
                className="flex items-center justify-between gap-4 py-3 text-sm hover:text-primary"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <StatusBadge status={r.status} />
                  <span className="min-w-0 flex-1 truncate">{r.prTitle}</span>
                </span>
                <span className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs">
                  <span className="font-family-mono">
                    {r.pr.workspace}/{r.pr.repo}#{r.pr.id}
                  </span>
                  <span>{timeAgo(r.createdAt)}</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
