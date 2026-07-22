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
  skill: z.string(),
})

function candidateJson(text: string): string | undefined {
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  if (fenced.length > 0) return fenced[fenced.length - 1][1]
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) return trimmed
  return undefined
}

export function extractFindings(text: string): Finding[] {
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
    return parsed.success ? [parsed.data] : []
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
