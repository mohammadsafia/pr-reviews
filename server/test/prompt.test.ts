import { describe, it, expect } from 'vitest'
import { buildReviewPrompt } from '../src/review/prompt.js'

const meta = {
  title: 'Fix rounding',
  description: 'Rounds totals correctly',
  sourceBranch: 'feat/round',
  destinationBranch: 'develop',
  sourceCommit: 'abc',
}

describe('buildReviewPrompt', () => {
  it('embeds PR context, skills, diff, focus, and the output contract', () => {
    const p = buildReviewPrompt({
      meta,
      diff: 'diff --git a/x b/x\n+new line',
      skills: [{ name: 'review-code', content: 'ALWAYS check naming.' }],
      focus: 'watch date handling',
    })
    expect(p).toContain('Fix rounding')
    expect(p).toContain('feat/round')
    expect(p).toContain('## Skill: review-code')
    expect(p).toContain('ALWAYS check naming.')
    expect(p).toContain('+new line')
    expect(p).toContain('watch date handling')
    expect(p).toContain('"severity"')
    expect(p).toContain('```json')
  })

  it('omits the focus section when not given', () => {
    const p = buildReviewPrompt({ meta, diff: 'd', skills: [] })
    expect(p).not.toContain('Reviewer focus')
  })
})
