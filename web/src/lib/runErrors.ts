import type { RunRecord } from '../types.js'

const LOGIN_EXPIRY = /failed to authenticate|oauth session expired|could not be refreshed/i

export function isLoginExpiryError(text: string | undefined): boolean {
  return text !== undefined && LOGIN_EXPIRY.test(text)
}

export function failedSkillNames(run: RunRecord): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of run.skillResults) {
    if (r.status !== 'failed') continue
    if (!run.skills.includes(r.skill)) continue // drops the synthetic "general" unit
    if (seen.has(r.skill)) continue
    seen.add(r.skill)
    out.push(r.skill)
  }
  return out
}

export function runHasLoginExpiry(run: RunRecord): boolean {
  return isLoginExpiryError(run.error) || run.skillResults.some((r) => isLoginExpiryError(r.error))
}
