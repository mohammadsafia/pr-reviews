import { useEffect, useMemo, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { StatusBadge } from '@/components/StatusBadge'
import { cn } from '@/lib/utils'

import { createRun, getConfig, getSkills, listRuns } from '../api.js'
import { submitBatch, type BatchOutcome } from '../lib/batch.js'
import { filterSkills, inferCategory } from '../lib/skills.js'
import { timeAgo } from '../lib/time.js'
import { parsePrUrlLines } from '../lib/urls.js'
import type { ModelProfile, RunRecord, SkillInfo } from '../types.js'

export function groupSkillsBySource(skills: SkillInfo[]): Map<string, SkillInfo[]> {
  const g = new Map<string, SkillInfo[]>()
  for (const s of skills) {
    if (!g.has(s.source)) g.set(s.source, [])
    g.get(s.source)!.push(s)
  }
  return g
}

const LAST_SKILLS_KEY = 'pr-reviewer.lastSkills'
const VERIFY_KEY = 'pr-reviewer.verify'
const DEPTH_KEY = 'pr-reviewer.depth'
const PROFILE_KEY = 'pr-reviewer.profile'
const AUTO_SUBMIT_KEY = 'pr-reviewer.autoSubmit'
const AUTO_THRESHOLD_KEY = 'pr-reviewer.autoSubmitThreshold'
const AUTO_CONFIRMED_KEY = 'pr-reviewer.autoSubmitConfirmedOnly'

type Depth = 'thorough' | 'balanced' | 'economy'
const DEPTH_OPTIONS: { value: Depth; label: string; hint: string }[] = [
  { value: 'thorough', label: 'Thorough', hint: 'One agent per skill — highest quality, highest cost.' },
  { value: 'balanced', label: 'Balanced', hint: 'Groups of 3 skills per agent — solid quality at roughly a third of the cost.' },
  { value: 'economy', label: 'Economy', hint: 'All skills in a single agent — cheapest, lighter per-skill attention.' },
]

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
  const [verify, setVerify] = useState<boolean>(
    () => JSON.parse(localStorage.getItem(VERIFY_KEY) ?? 'true'),
  )
  const [depth, setDepth] = useState<Depth | null>(
    () => localStorage.getItem(DEPTH_KEY) as Depth | null,
  )
  const [profile, setProfile] = useState<string | null>(() => localStorage.getItem(PROFILE_KEY))
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [autoSubmitOn, setAutoSubmitOn] = useState<boolean>(
    () => JSON.parse(localStorage.getItem(AUTO_SUBMIT_KEY) ?? 'false'),
  )
  const [threshold, setThreshold] = useState<'high' | 'medium' | 'all'>(
    () => (localStorage.getItem(AUTO_THRESHOLD_KEY) as 'high' | 'medium' | 'all') ?? 'medium',
  )
  const [confirmedOnly, setConfirmedOnly] = useState<boolean>(
    () => JSON.parse(localStorage.getItem(AUTO_CONFIRMED_KEY) ?? 'true'),
  )
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [error, setError] = useState('')
  const [results, setResults] = useState<BatchOutcome[]>([])
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')

  useEffect(() => {
    getSkills().then(setSkills).catch((e) => setError(e.message))
    listRuns().then(setRuns).catch(() => {})
  }, [])

  // Load profiles for the model picker; on a first-ever visit (no stored choice) also
  // preselect the configured defaults for depth and profile.
  useEffect(() => {
    getConfig()
      .then((c) => {
        setProfiles(c.modelProfiles)
        setDepth((cur) => cur ?? c.defaultDepth)
        setProfile((cur) => cur ?? c.reviewProfile)
      })
      .catch(() => {
        setDepth((cur) => cur ?? 'balanced')
      })
  }, [])

  function pickDepth(d: Depth) {
    setDepth(d)
    localStorage.setItem(DEPTH_KEY, d)
  }

  function pickProfile(id: string) {
    setProfile(id)
    localStorage.setItem(PROFILE_KEY, id)
  }

  function toggle(name: string) {
    const next = new Set(selected)
    next.has(name) ? next.delete(name) : next.add(name)
    setSelected(next)
    localStorage.setItem(LAST_SKILLS_KEY, JSON.stringify([...next]))
  }

  function persistSelection(next: Set<string>) {
    setSelected(next)
    localStorage.setItem(LAST_SKILLS_KEY, JSON.stringify([...next]))
  }

  function selectAll(visible: SkillInfo[]) {
    const next = new Set(selected)
    for (const s of visible) next.add(s.name)
    persistSelection(next)
  }

  function deselectAll(visible: SkillInfo[]) {
    const next = new Set(selected)
    for (const s of visible) next.delete(s.name)
    persistSelection(next)
  }

  const categories = useMemo(
    () => [...new Set(skills.map(inferCategory))].sort(),
    [skills],
  )
  const visibleSkills = useMemo(
    () => filterSkills(skills, query, category),
    [skills, query, category],
  )
  const visibleGroups = useMemo(() => groupSkillsBySource(visibleSkills), [visibleSkills])
  const urls = useMemo(() => parsePrUrlLines(url), [url])

  async function submit(forceUrl?: string) {
    setBusy(true)
    setError('')
    const targets = forceUrl ? [forceUrl] : urls
    try {
      const opts = {
        skills: [...selected],
        focus: focus || undefined,
        verify,
        depth: depth ?? undefined,
        profile: profile ?? undefined,
        autoSubmit: autoSubmitOn ? { threshold, confirmedOnly } : undefined,
        force: forceUrl !== undefined,
      }
      const outcomes = await submitBatch(targets, opts, createRun)
      if (!forceUrl && urls.length === 1 && outcomes[0].kind === 'started') {
        navigate(`/runs/${outcomes[0].id}`)
        return
      }
      // merge: a forced resubmit replaces that URL's previous row
      setResults((prev) => [...prev.filter((r) => !targets.includes(r.url)), ...outcomes])
      listRuns().then(setRuns).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="font-family-display text-3xl">Review a pull request.</h1>
        <p className="text-muted-foreground text-sm">
          Paste a Bitbucket or GitHub PR link, pick the skills to run, and we'll take it from there.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Textarea
            className="min-h-24 font-family-mono text-sm sm:flex-1"
            placeholder={'https://bitbucket.org/workspace/repo/pull-requests/123\nhttps://bitbucket.org/workspace/repo/pull-requests/124'}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button
            size="lg"
            className="h-12 shrink-0"
            disabled={busy || urls.length === 0}
            onClick={() => submit()}
          >
            {busy ? 'Starting…' : urls.length > 1 ? `Run ${urls.length} reviews` : 'Run review'}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          One Bitbucket or GitHub PR URL per line · {urls.length} PR{urls.length === 1 ? '' : 's'} ·{' '}
          {selected.size} of {skills.length} skills selected
        </p>
        {error && <p className="text-destructive text-sm">{error}</p>}
        {results.length > 0 && (
          <div className="flex flex-col gap-2">
            {results.map((r) => (
              <div key={r.url} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-family-mono min-w-0 truncate text-xs">{r.url}</span>
                {r.kind === 'started' && (
                  <Link to={`/runs/${r.id}`} className="text-primary text-xs font-medium">
                    started — view run
                  </Link>
                )}
                {r.kind === 'oversized' && (
                  <>
                    <span className="text-muted-foreground text-xs">
                      {r.diffLines} changed lines — large diff
                    </span>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => submit(r.url)}>
                      Run anyway
                    </Button>
                  </>
                )}
                {r.kind === 'error' && <span className="text-destructive text-xs">{r.message}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">Skills to apply</h2>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative sm:max-w-xs sm:flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              className="pl-9"
              placeholder="Search skills…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={visibleSkills.length === 0}
              onClick={() => selectAll(visibleSkills)}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="outline-muted"
              size="sm"
              disabled={visibleSkills.length === 0}
              onClick={() => deselectAll(visibleSkills)}
            >
              Deselect all
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setCategory('all')}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              category === 'all'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-muted-200 text-muted-foreground hover:border-primary hover:text-primary',
            )}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors',
                category === cat
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted-200 text-muted-foreground hover:border-primary hover:text-primary',
              )}
            >
              {cat}
            </button>
          ))}
        </div>

        {skills.length > 0 && visibleSkills.length === 0 ? (
          <p className="text-muted-foreground text-sm">No skills match your search.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {[...visibleGroups].map(([source, group]) => {
              const allVisibleSelected = group.every((s) => selected.has(s.name))
              return (
                <Card key={source} shadow="sm">
                  <Card.Header className="flex flex-row items-start justify-between gap-3 pb-2">
                    <div>
                      <Card.Title className="text-base">{sourceLabel(source)}</Card.Title>
                      <Card.Description className="truncate">{source}</Card.Description>
                    </div>
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="sm"
                      className="shrink-0"
                      onClick={() => (allVisibleSelected ? deselectAll(group) : selectAll(group))}
                    >
                      {allVisibleSelected ? 'Deselect all' : 'Select all'}
                    </Button>
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
              )
            })}
          </div>
        )}
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

      <label className="flex w-fit items-start gap-2">
        <Checkbox
          checked={verify}
          onCheckedChange={(v) => {
            const nv = v === true
            setVerify(nv)
            localStorage.setItem(VERIFY_KEY, JSON.stringify(nv))
          }}
          className="mt-0.5 shrink-0"
        />
        <span className="text-sm">Verify findings (double-check each with a second agent)</span>
      </label>

      <div className="flex flex-col gap-2">
        <label className="flex w-fit items-start gap-2">
          <Checkbox
            checked={autoSubmitOn}
            onCheckedChange={(v) => {
              const nv = v === true
              setAutoSubmitOn(nv)
              localStorage.setItem(AUTO_SUBMIT_KEY, JSON.stringify(nv))
            }}
            className="mt-0.5 shrink-0"
          />
          <span className="text-sm">Auto-post findings to the PR when the run completes</span>
        </label>
        {autoSubmitOn && (
          <div className="flex flex-wrap items-center gap-3 pl-6">
            <select
              aria-label="Auto-post severity threshold"
              value={threshold}
              onChange={(e) => {
                setThreshold(e.target.value as 'high' | 'medium' | 'all')
                localStorage.setItem(AUTO_THRESHOLD_KEY, e.target.value)
              }}
              className="border-muted-200 bg-background rounded-md border p-2 text-xs outline-none"
            >
              <option value="high">High only</option>
              <option value="medium">Medium and up</option>
              <option value="all">All severities</option>
            </select>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={confirmedOnly}
                onCheckedChange={(v) => {
                  const nv = v === true
                  setConfirmedOnly(nv)
                  localStorage.setItem(AUTO_CONFIRMED_KEY, JSON.stringify(nv))
                }}
                className="shrink-0"
              />
              Confirmed findings only
            </label>
            {!verify && confirmedOnly && (
              <p className="text-muted-foreground text-xs">
                Verification is off, so every finding counts as confirmed — this filter has no effect.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Review depth</h2>
        <div className="flex flex-wrap gap-2">
          {DEPTH_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => pickDepth(o.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                depth === o.value
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted-200 text-muted-foreground hover:border-primary hover:text-primary',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          {DEPTH_OPTIONS.find((o) => o.value === depth)?.hint ?? 'Loading default…'}
        </p>
      </div>

      {profiles.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Review model</h2>
          <div className="flex flex-wrap gap-2">
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => pickProfile(p.id)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  profile === p.id
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-200 text-muted-foreground hover:border-primary hover:text-primary',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

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
