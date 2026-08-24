import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Collapsible } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ReviewerPrPicker } from '@/components/ReviewerPrPicker'
import { SkillPicker } from '@/components/SkillPicker'
import { cn } from '@/lib/utils'

import { createRun, getConfig, getSkills } from '../api.js'
import { submitBatch, type BatchOutcome } from '../lib/batch.js'
import { parsePrUrlLines } from '../lib/urls.js'
import type { ModelProfile, SkillInfo } from '../types.js'

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

export function NewReview() {
  const navigate = useNavigate()
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem(LAST_SKILLS_KEY) ?? '[]')),
  )
  const [url, setUrl] = useState('')
  const [focus, setFocus] = useState('')
  const [verify, setVerify] = useState<boolean>(() => JSON.parse(localStorage.getItem(VERIFY_KEY) ?? 'true'))
  const [depth, setDepth] = useState<Depth | null>(() => localStorage.getItem(DEPTH_KEY) as Depth | null)
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
  const [error, setError] = useState('')
  const [results, setResults] = useState<BatchOutcome[]>([])
  const [busy, setBusy] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    getSkills()
      .then(setSkills)
      .catch((e) => setError(e.message))
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

  function persistSelection(next: Set<string>) {
    setSelected(next)
    localStorage.setItem(LAST_SKILLS_KEY, JSON.stringify([...next]))
  }

  function toggle(name: string) {
    const next = new Set(selected)
    next.has(name) ? next.delete(name) : next.add(name)
    persistSelection(next)
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

  function pickDepth(d: Depth) {
    setDepth(d)
    localStorage.setItem(DEPTH_KEY, d)
  }

  function pickProfile(id: string) {
    setProfile(id)
    localStorage.setItem(PROFILE_KEY, id)
  }

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
      if (targets.length === 1 && outcomes[0].kind === 'started') {
        navigate(`/runs/${outcomes[0].id}`)
        return
      }
      if (targets.length === 1) {
        // single URL that did not start: keep the outcome inline (oversized alert / error)
        if (outcomes[0].kind === 'error') setError(outcomes[0].message)
        setResults(outcomes)
        return
      }
      // batch: toast each outcome, then monitor on the runs page
      let started = 0
      for (const o of outcomes) {
        if (o.kind === 'started') {
          started++
          toast.success(`${o.url.split('/').slice(-3).join('/')} started`)
        } else if (o.kind === 'oversized') {
          toast.warning(`${o.url} — ${o.diffLines} changed lines`, {
            action: { label: 'Run anyway', onClick: () => submit(o.url) },
          })
        } else {
          toast.error(`${o.url}: ${o.message}`)
        }
      }
      setResults([])
      if (started > 0) navigate('/runs')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New review</h1>
        <p className="text-muted-foreground mt-1 text-sm">Paste PR links, pick skills, configure the run.</p>
      </div>

      <ReviewerPrPicker
        open={browsing}
        onOpenChange={setBrowsing}
        onAdd={(picked) => setUrl((cur) => [...parsePrUrlLines(cur), ...picked].join('\n'))}
      />

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        {/* LEFT: what to review */}
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="pr-urls">Pull request URLs</Label>
              <Button type="button" variant="ghost-primary" size="xs" onClick={() => setBrowsing(true)}>
                Browse PRs awaiting your review
              </Button>
            </div>
            <Textarea
              id="pr-urls"
              className="font-family-mono min-h-24 text-sm"
              placeholder={'https://bitbucket.org/workspace/repo/pull-requests/123\nhttps://github.com/owner/repo/pull/456'}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {urls.length} PR{urls.length === 1 ? '' : 's'} · one per line
            </p>
          </div>

          <SkillPicker
            skills={skills}
            selected={selected}
            onToggle={toggle}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
          />

          <Collapsible>
            <Collapsible.Trigger className="text-muted-foreground hover:text-foreground w-fit text-sm">
              + Add reviewer focus
            </Collapsible.Trigger>
            <Collapsible.Content>
              <Textarea
                className="mt-2"
                placeholder='e.g. "pay attention to date handling"'
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
              />
            </Collapsible.Content>
          </Collapsible>
        </div>

        {/* RIGHT: sticky run configuration */}
        <div className="lg:sticky lg:top-8 lg:self-start">
          <Card shadow="sm">
            <Card.Header>
              <Card.Title className="text-base">Run configuration</Card.Title>
            </Card.Header>
            <Card.Content className="flex flex-col gap-5 pt-0">
              <div className="flex flex-col gap-1.5">
                <Label>Review model</Label>
                <Select value={profile ?? undefined} onValueChange={pickProfile}>
                  <Select.Trigger>
                    <Select.Value placeholder="Loading…" />
                  </Select.Trigger>
                  <Select.Content>
                    {profiles.map((p) => (
                      <Select.Item key={p.id} value={p.id}>
                        {p.label} · {p.kind}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Depth</Label>
                <div className="border-border bg-background grid grid-cols-3 gap-1 rounded-lg border p-1">
                  {DEPTH_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => pickDepth(o.value)}
                      className={cn(
                        'cursor-pointer rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                        depth === o.value
                          ? 'bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
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

              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>Verify findings</Label>
                  <p className="text-muted-foreground text-xs">Second agent re-checks each finding</p>
                </div>
                <Switch
                  checked={verify}
                  onCheckedChange={(v) => {
                    setVerify(v)
                    localStorage.setItem(VERIFY_KEY, JSON.stringify(v))
                  }}
                />
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>Auto-post findings</Label>
                    <p className="text-muted-foreground text-xs">Comment on the PR when the run completes</p>
                  </div>
                  <Switch
                    checked={autoSubmitOn}
                    onCheckedChange={(v) => {
                      setAutoSubmitOn(v)
                      localStorage.setItem(AUTO_SUBMIT_KEY, JSON.stringify(v))
                    }}
                  />
                </div>
                {autoSubmitOn && (
                  <div className="border-border flex flex-col gap-3 rounded-md border border-dashed p-3">
                    <Select
                      value={threshold}
                      onValueChange={(v) => {
                        setThreshold(v as 'high' | 'medium' | 'all')
                        localStorage.setItem(AUTO_THRESHOLD_KEY, v)
                      }}
                    >
                      <Select.Trigger aria-label="Auto-post severity threshold">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="high">High only</Select.Item>
                        <Select.Item value="medium">Medium and up</Select.Item>
                        <Select.Item value="all">All severities</Select.Item>
                      </Select.Content>
                    </Select>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs">Confirmed findings only</span>
                      <Switch
                        checked={confirmedOnly}
                        onCheckedChange={(v) => {
                          setConfirmedOnly(v)
                          localStorage.setItem(AUTO_CONFIRMED_KEY, JSON.stringify(v))
                        }}
                      />
                    </div>
                    {!verify && confirmedOnly && (
                      <p className="text-muted-foreground text-xs">
                        Verification is off, so every finding counts as confirmed — this filter has no effect.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <Button
                size="lg"
                className="glow-primary w-full"
                disabled={busy || urls.length === 0}
                onClick={() => submit()}
              >
                {busy
                  ? 'Starting…'
                  : urls.length > 1
                    ? `Run ${urls.length} reviews`
                    : urls.length === 1
                      ? 'Run review'
                      : 'Add a PR URL'}
              </Button>
              {error && <p className="text-destructive text-sm">{error}</p>}
              {results.length === 1 && results[0].kind === 'oversized' && (
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <Alert.Description className="flex flex-col gap-2">
                    <span>{results[0].diffLines} changed lines — this may be slow and costly.</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-fit"
                      disabled={busy}
                      onClick={() => submit(results[0].url)}
                    >
                      Run anyway
                    </Button>
                  </Alert.Description>
                </Alert>
              )}
            </Card.Content>
          </Card>
        </div>
      </div>
    </div>
  )
}
