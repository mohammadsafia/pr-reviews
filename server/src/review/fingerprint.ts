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
  // The real marker is always appended last by commentMarker; if the human-written portion
  // of a comment happens to quote a marker (e.g. replying to another comment), that decoy
  // would come first. Take the LAST match, not the first, so the real marker always wins.
  const matches = [...body.matchAll(/<!-- prr-fp:([0-9a-f]{12}) -->/g)]
  return matches.length > 0 ? matches[matches.length - 1][1] : undefined
}
