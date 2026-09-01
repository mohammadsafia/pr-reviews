import type { Finding } from '../types.js'

function findingKey(f: Finding): string {
  return `${f.file}|${f.category}|${f.summary.toLowerCase().replace(/\s+/g, ' ').trim()}`
}

export interface FindingDelta {
  newFindings: Finding[]
  stillOpen: Finding[]
  resolved: Finding[]
}

/** Diffs a child run's findings against its parent's, using the same identity rule
 * review/fingerprint.ts uses server-side for comment idempotency — file + category +
 * normalized summary — as a plain string key instead of a hash, since this only needs Set
 * membership. Call scopeToRetriedSkills on the parent findings first when the child came
 * from "Retry failed skills", so a skill that wasn't re-run is never counted as resolved. */
export function diffFindings(parentFindings: Finding[], childFindings: Finding[]): FindingDelta {
  const parentKeys = new Set(parentFindings.map(findingKey))
  const childKeys = new Set(childFindings.map(findingKey))
  return {
    newFindings: childFindings.filter((f) => !parentKeys.has(findingKey(f))),
    stillOpen: childFindings.filter((f) => parentKeys.has(findingKey(f))),
    resolved: parentFindings.filter((f) => !childKeys.has(findingKey(f))),
  }
}

/** Scopes a parent run's findings down to only those sharing at least one skill with the
 * child run's skill list. Required before diffFindings when the child came from "Retry
 * failed skills", which only re-runs a subset of skills — without this filter, every
 * untouched skill's findings would wrongly show up as "resolved" just because the child
 * never re-evaluated them. A full retry keeps the same skills as its parent, so this is a
 * no-op there. */
export function scopeToRetriedSkills(parentFindings: Finding[], childSkills: string[]): Finding[] {
  const retried = new Set(childSkills)
  return parentFindings.filter((f) => f.skills.some((s) => retried.has(s)))
}
