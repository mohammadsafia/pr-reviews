import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
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
    <main>
      <h2>New Review</h2>
      <input
        placeholder="https://bitbucket.org/workspace/repo/pull-requests/123"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      {[...groupSkillsBySource(skills)].map(([source, group]) => (
        <fieldset key={source}>
          <legend>{source}</legend>
          {group.map((s) => (
            <label key={s.dir} title={s.description}>
              <input
                type="checkbox"
                checked={selected.has(s.name)}
                onChange={() => toggle(s.name)}
              />
              {s.name}
            </label>
          ))}
        </fieldset>
      ))}
      <textarea
        placeholder={'Optional focus, e.g. "pay attention to date handling"'}
        value={focus}
        onChange={(e) => setFocus(e.target.value)}
      />
      <button disabled={busy || !url} onClick={() => submit()}>
        {busy ? 'Starting…' : 'Run Review'}
      </button>
      {error && <p className="error">{error}</p>}
      {oversized !== null && (
        <p className="warn">
          Large diff ({oversized} changed lines) — this may be slow and costly.{' '}
          <button disabled={busy} onClick={() => submit(true)}>Proceed anyway</button>
        </p>
      )}
      <h3>Recent runs</h3>
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            <Link to={`/runs/${r.id}`}>
              [{r.status}] {r.prTitle} — {r.pr.workspace}/{r.pr.repo}#{r.pr.id}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
