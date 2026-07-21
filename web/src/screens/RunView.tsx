import { useEffect, useRef, useState } from 'react'
import { createRun, getRun, postComments, subscribeRun } from '../api.js'
import type { Finding, RunEvent, RunRecord, Severity } from '../types.js'

const ORDER: Severity[] = ['high', 'medium', 'low', 'info']

export function groupFindingsBySeverity(
  findings: Finding[],
): { severity: Severity; items: { finding: Finding; index: number }[] }[] {
  return ORDER.map((severity) => ({
    severity,
    items: findings
      .map((finding, index) => ({ finding, index }))
      .filter((x) => x.finding.severity === severity),
  })).filter((g) => g.items.length > 0)
}

export function RunView({ id }: { id: string }) {
  const [run, setRun] = useState<RunRecord | null>(null)
  const [live, setLive] = useState<RunEvent[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [posted, setPosted] = useState<number[] | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let unsub = () => {}
    getRun(id).then((r) => {
      if (cancelled) return
      setRun(r)
      setLive(r.transcript)
      if (r.status === 'running' || r.status === 'queued') {
        unsub = subscribeRun(
          id,
          (e) => {
            if (!cancelled) setLive((prev) => [...prev, e])
          },
          () => {
            if (!cancelled) getRun(id).then((r2) => !cancelled && setRun(r2))
          },
        )
      }
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [id])

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [live])

  if (!run) return <p>Loading…</p>
  const active = run.status === 'running' || run.status === 'queued'

  async function post() {
    const ids = await postComments(id, [...checked])
    setPosted(ids)
    setConfirming(false)
  }

  return (
    <main>
      <h2>
        {run.prTitle} <small>({run.status})</small>
      </h2>
      <p>
        {run.pr.workspace}/{run.pr.repo}#{run.pr.id} · skills: {run.skills.join(', ') || 'none'}
      </p>

      {(active || run.status === 'failed') && (
        <div className="feed" ref={feedRef}>
          {live.map((e, i) => (
            <p key={i} className={`ev-${e.kind}`}>
              {e.kind === 'tool' ? '🔧 ' : e.kind === 'error' ? '❌ ' : ''}
              {e.text}
            </p>
          ))}
        </div>
      )}
      {run.status === 'failed' && (
        <>
          <p className="error">Run failed: {run.error}</p>
          <button
            onClick={async () => {
              const res = await createRun({
                url: `https://bitbucket.org/${run.pr.workspace}/${run.pr.repo}/pull-requests/${run.pr.id}`,
                skills: run.skills,
                focus: run.focus,
                force: true,
              })
              if (res.id) window.location.hash = `#/runs/${res.id}`
            }}
          >
            Retry run
          </button>
        </>
      )}

      {run.status === 'completed' && (
        <>
          {run.findings.length === 0 && <p>✅ No findings — the agent had nothing to flag.</p>}
          {groupFindingsBySeverity(run.findings).map((g) => (
            <section key={g.severity}>
              <h3 className={`sev-${g.severity}`}>{g.severity}</h3>
              {g.items.map(({ finding, index }) => (
                <article key={index}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked.has(index)}
                      onChange={() => {
                        const next = new Set(checked)
                        next.has(index) ? next.delete(index) : next.add(index)
                        setChecked(next)
                      }}
                    />
                    <code>
                      {finding.file}:{finding.line}
                    </code>{' '}
                    [{finding.category} · {finding.skill}] {finding.summary}
                  </label>
                  <p>{finding.detail}</p>
                  <pre>{finding.suggestion}</pre>
                </article>
              ))}
            </section>
          ))}
          {run.findings.length > 0 && !confirming && (
            <button disabled={checked.size === 0} onClick={() => setConfirming(true)}>
              Post {checked.size} selected to Bitbucket…
            </button>
          )}
          {confirming && (
            <div className="confirm">
              <p>These comments will be created on the PR:</p>
              <ul>
                {[...checked].map((i) => (
                  <li key={i}>
                    <code>
                      {run.findings[i].file}:{run.findings[i].line}
                    </code>{' '}
                    — {run.findings[i].summary}
                  </li>
                ))}
              </ul>
              <button onClick={post}>Confirm — post to Bitbucket</button>
              <button onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          )}
          {posted && <p>✅ Posted {posted.length} comments.</p>}
        </>
      )}
    </main>
  )
}
