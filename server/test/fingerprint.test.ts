import { describe, it, expect } from 'vitest'
import { fingerprint, commentMarker, parseFingerprint } from '../src/review/fingerprint.js'
import type { PrRef } from '../src/types.js'

const pr: PrRef = { provider: 'github', workspace: 'acme', repo: 'app', id: 7 }
const f = { file: 'src/a.ts', category: 'bug', summary: 'Null deref on user' }

describe('fingerprint', () => {
  it('is stable for identical inputs', () => {
    expect(fingerprint(pr, f)).toBe(fingerprint(pr, f))
  })
  it('is 12 lowercase hex chars', () => {
    expect(fingerprint(pr, f)).toMatch(/^[0-9a-f]{12}$/)
  })
  it('is line-independent (line is not an input) and summary-normalized', () => {
    // whitespace/case differences in summary must not change the fp
    expect(fingerprint(pr, { ...f, summary: '  null   DEREF on   user ' })).toBe(fingerprint(pr, f))
  })
  it('differs on file, category, summary, and PR identity', () => {
    const base = fingerprint(pr, f)
    expect(fingerprint(pr, { ...f, file: 'src/b.ts' })).not.toBe(base)
    expect(fingerprint(pr, { ...f, category: 'security' })).not.toBe(base)
    expect(fingerprint(pr, { ...f, summary: 'different' })).not.toBe(base)
    expect(fingerprint({ ...pr, repo: 'other' }, f)).not.toBe(base)
  })
})

describe('commentMarker / parseFingerprint', () => {
  it('round-trips a fingerprint through a marker', () => {
    const fp = fingerprint(pr, f)
    const body = `some comment text\n\n${commentMarker(fp)}`
    expect(parseFingerprint(body)).toBe(fp)
  })
  it('returns undefined when there is no marker', () => {
    expect(parseFingerprint('plain comment, no marker')).toBeUndefined()
  })
})
