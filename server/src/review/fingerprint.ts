import { createHash } from 'node:crypto'
import type { PrRef } from '../types.js'

function normalizeSummary(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function fingerprint(
  pr: PrRef,
  f: { file: string; category: string; summary: string },
): string {
  const key = `${pr.provider}|${pr.workspace}|${pr.repo}|${f.file}|${f.category}|${normalizeSummary(f.summary)}`
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

export function commentMarker(fp: string): string {
  return `<!-- prr-fp:${fp} -->`
}

export function parseFingerprint(body: string): string | undefined {
  const m = /<!-- prr-fp:([0-9a-f]{12}) -->/.exec(body)
  return m ? m[1] : undefined
}
