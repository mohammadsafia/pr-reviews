import { describe, it, expect } from 'vitest'
import { extractFindings, FindingsParseError, countDiffLines } from '../src/review/findings.js'

const valid = {
  file: 'src/a.ts',
  line: 3,
  severity: 'high',
  category: 'bug',
  summary: 's',
  detail: 'd',
  suggestion: 'fix',
  skill: 'review-code',
}

describe('extractFindings', () => {
  it('parses a fenced json block', () => {
    const text = 'Here is my review.\n```json\n' + JSON.stringify([valid]) + '\n```\nDone.'
    expect(extractFindings(text)).toEqual([valid])
  })

  it('uses the LAST fenced block when several exist', () => {
    const text =
      '```json\n[]\n```\nrevised:\n```json\n' + JSON.stringify([valid]) + '\n```'
    expect(extractFindings(text)).toHaveLength(1)
  })

  it('accepts a bare JSON array', () => {
    expect(extractFindings(JSON.stringify([valid]))).toEqual([valid])
  })

  it('drops invalid items but keeps valid ones', () => {
    const text = '```json\n' + JSON.stringify([valid, { file: 'x' }]) + '\n```'
    expect(extractFindings(text)).toEqual([valid])
  })

  it('throws FindingsParseError when no JSON array found', () => {
    expect(() => extractFindings('no json here')).toThrow(FindingsParseError)
  })
})

describe('countDiffLines', () => {
  it('counts changed lines, ignoring file headers', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' ctx',
    ].join('\n')
    expect(countDiffLines(diff)).toBe(2)
  })
})
