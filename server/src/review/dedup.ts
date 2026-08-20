import type { Finding, Severity } from '../types.js'

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 }
const longer = (a: string, b: string): string => (b.length > a.length ? b : a)

export function dedupeFindings(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding>()
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.category}`
    const cur = groups.get(key)
    if (!cur) {
      groups.set(key, { ...f, skills: [...f.skills] })
      continue
    }
    if (RANK[f.severity] > RANK[cur.severity]) {
      cur.severity = f.severity
      cur.summary = f.summary
    }
    for (const sk of f.skills) if (!cur.skills.includes(sk)) cur.skills.push(sk)
    cur.detail = longer(cur.detail, f.detail)
    cur.suggestion = longer(cur.suggestion, f.suggestion)
    cur.example = longer(cur.example ?? '', f.example ?? '')
  }
  return [...groups.values()]
}
