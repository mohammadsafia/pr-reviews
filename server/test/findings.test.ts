import { describe, it, expect } from 'vitest'
import { extractFindings, FindingsParseError, countDiffLines } from '../src/review/findings.js'

// `valid` is the raw agent-output shape (matches FindingSchema, which keeps `skill: string`).
// `expected` is what extractFindings maps it to: `skill` -> `skills: [skill]`, plus a
// defaulted `verdict`.
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
const { skill: _validSkill, ...validRest } = valid
const expected = { ...validRest, example: '', skills: ['review-code'], verdict: 'confirmed' }

describe('extractFindings', () => {
  it('parses a fenced json block', () => {
    const text = 'Here is my review.\n```json\n' + JSON.stringify([valid]) + '\n```\nDone.'
    expect(extractFindings(text, ['review-code'])).toEqual([expected])
  })

  it('uses the LAST fenced block when several exist', () => {
    const text =
      '```json\n[]\n```\nrevised:\n```json\n' + JSON.stringify([valid]) + '\n```'
    expect(extractFindings(text, ['review-code'])).toHaveLength(1)
  })

  it('accepts a bare JSON array', () => {
    expect(extractFindings(JSON.stringify([valid]), ['review-code'])).toEqual([expected])
  })

  it('drops invalid items but keeps valid ones', () => {
    const text = '```json\n' + JSON.stringify([valid, { file: 'x' }]) + '\n```'
    expect(extractFindings(text, ['review-code'])).toEqual([expected])
  })

  it('throws FindingsParseError when no JSON array found', () => {
    expect(() => extractFindings('no json here', ['review-code'])).toThrow(FindingsParseError)
  })

  it('maps the schema skill string into skills[] and defaults verdict', () => {
    const raw = {
      file: 'a.ts', line: 3, severity: 'high', category: 'bug',
      summary: 's', detail: 'd', suggestion: 'fix', skill: 'review-code',
    }
    const out = extractFindings('```json\n' + JSON.stringify([raw]) + '\n```', ['review-code'])
    expect(out).toHaveLength(1)
    expect(out[0].skills).toEqual(['review-code'])
    expect(out[0].verdict).toBe('confirmed')
    expect(out[0].verifierReason).toBeUndefined()
  })
})

const base = {
  file: 'a.ts',
  line: 1,
  severity: 'low',
  category: 'style',
  summary: 's',
  detail: 'd',
  suggestion: 'x',
}

describe('extractFindings with validSkills', () => {
  it('keeps a skill label that is in validSkills', () => {
    const text = '```json\n' + JSON.stringify([{ ...base, skill: 'skill-b' }]) + '\n```'
    const [f] = extractFindings(text, ['skill-a', 'skill-b'])
    expect(f.skills).toEqual(['skill-b'])
  })

  it('reattributes an unknown skill label to the first valid skill', () => {
    const text = '```json\n' + JSON.stringify([{ ...base, skill: 'made-up' }]) + '\n```'
    const [f] = extractFindings(text, ['skill-a', 'skill-b'])
    expect(f.skills).toEqual(['skill-a'])
  })

  it('defaults example to empty string when the model omits it', () => {
    const text = '```json\n' + JSON.stringify([{ ...base, skill: 'skill-a' }]) + '\n```'
    const [f] = extractFindings(text, ['skill-a'])
    expect(f.example).toBe('')
  })

  it('passes example through when present', () => {
    const text =
      '```json\n' + JSON.stringify([{ ...base, skill: 'skill-a', example: '```ts\n// before\n```' }]) + '\n```'
    const [f] = extractFindings(text, ['skill-a'])
    expect(f.example).toBe('```ts\n// before\n```')
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
