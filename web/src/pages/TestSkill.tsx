import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import { createTestRun, getConfig } from '../api.js'
import type { ModelProfile } from '../types.js'

const URL_KEY = 'pr-reviewer.testSkill.url'
const CONTENT_KEY = 'pr-reviewer.testSkill.content'
const PROFILE_KEY = 'pr-reviewer.testSkill.profile'

export function TestSkill() {
  const navigate = useNavigate()
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) ?? '')
  const [skillContent, setSkillContent] = useState(() => localStorage.getItem(CONTENT_KEY) ?? '')
  const [profile, setProfile] = useState<string | null>(() => localStorage.getItem(PROFILE_KEY))
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [error, setError] = useState('')
  const [oversized, setOversized] = useState<{ diffLines: number } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getConfig()
      .then((c) => {
        setProfiles(c.modelProfiles)
        setProfile((cur) => cur ?? c.reviewProfile)
      })
      .catch(() => {})
  }, [])

  async function submit(force = false) {
    setBusy(true)
    setError('')
    setOversized(null)
    try {
      const res = await createTestRun({ url, skillContent, profile: profile ?? undefined, force })
      if (res.id) {
        navigate(`/runs/${res.id}`)
        return
      }
      if (res.status === 409 && res.diffLines !== undefined) {
        setOversized({ diffLines: res.diffLines })
        return
      }
      setError(res.error ?? 'Failed to start test run')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Test a skill</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Try a skill's draft wording against a real PR before saving it to disk. Results never post to the PR
          and won't appear in Runs history.
        </p>
      </div>

      <Card shadow="sm">
        <Card.Content className="flex flex-col gap-5 pt-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="test-pr-url">Pull request URL</Label>
            <Textarea
              id="test-pr-url"
              className="min-h-10 text-sm"
              placeholder="https://bitbucket.org/workspace/repo/pull-requests/123"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                localStorage.setItem(URL_KEY, e.target.value)
              }}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="test-skill-content">Skill content (SKILL.md)</Label>
            <Textarea
              id="test-skill-content"
              className="font-family-mono min-h-64 text-sm"
              placeholder={'---\nname: my-skill\ndescription: what it checks\n---\n\nReview instructions…'}
              value={skillContent}
              onChange={(e) => {
                setSkillContent(e.target.value)
                localStorage.setItem(CONTENT_KEY, e.target.value)
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Review model</Label>
            <Select
              value={profile ?? undefined}
              onValueChange={(v) => {
                setProfile(v)
                localStorage.setItem(PROFILE_KEY, v)
              }}
            >
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

          <Button disabled={busy || !url || !skillContent} onClick={() => submit()}>
            {busy ? 'Running…' : 'Run test'}
          </Button>

          {error && <p className="text-destructive text-sm">{error}</p>}
          {oversized && (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <Alert.Description className="flex flex-col gap-2">
                <span>{oversized.diffLines} changed lines — this may be slow and costly.</span>
                <Button variant="secondary" size="sm" className="w-fit" disabled={busy} onClick={() => submit(true)}>
                  Run anyway
                </Button>
              </Alert.Description>
            </Alert>
          )}
        </Card.Content>
      </Card>
    </div>
  )
}
