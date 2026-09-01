import { z } from 'zod'
import type { Finding } from '../types.js'

export class FindingsParseError extends Error {
  constructor() {
    super('Could not find a valid JSON findings array in the agent output.')
    this.name = 'FindingsParseError'
  }
}

export const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(['high', 'medium', 'low', 'info']),
  category: z.string().min(1),
  summary: z.string().min(1),
  detail: z.string(),
  suggestion: z.string(),
  example: z.string().default(''),
  skill: z.string(),
})

function candidateJson(text: string): string | undefined {
  // The closing fence must sit at the start of a line: findings may embed ``` sequences
  // inside JSON string values (the `example` field), and those are never preceded by a raw
  // newline — JSON escapes newlines inside strings — so this anchor skips right past them.
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  if (fenced.length > 0) return fenced[fenced.length - 1][1]
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) return trimmed
  return undefined
}

export function extractFindings(text: string, validSkills: string[]): Finding[] {
  const raw = candidateJson(text)
  if (raw === undefined) throw new FindingsParseError()
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    throw new FindingsParseError()
  }
  if (!Array.isArray(arr)) throw new FindingsParseError()
  return arr.flatMap((item) => {
    const parsed = FindingSchema.safeParse(item)
    if (!parsed.success) return []
    const { skill, ...rest } = parsed.data
    // Never discard a real finding over a labeling error: unknown labels fall back to the
    // session's first skill.
    const attributed = validSkills.includes(skill) ? skill : validSkills[0]
    return [{ ...rest, skills: [attributed], verdict: 'confirmed' as const }]
  })
}

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 }

/** Confirmed findings sort before unverified ones regardless of severity; within each
 * verdict, higher severity sorts first. Mutates and returns the input array (matches the
 * in-place .sort() this replaces at its one call site). */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((a, b) => {
    if (a.verdict !== b.verdict) return a.verdict === 'confirmed' ? -1 : 1
    return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
  })
}

export function countDiffLines(diff: string): number {
  return diff
    .split('\n')
    .filter(
      (l) =>
        (l.startsWith('+') || l.startsWith('-')) &&
        !l.startsWith('+++') &&
        !l.startsWith('---'),
    ).length
}
