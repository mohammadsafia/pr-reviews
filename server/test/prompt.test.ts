import { describe, it, expect } from 'vitest'
import { buildReviewPrompt } from '../src/review/prompt.js'
import type { PrMeta } from '../src/types.js'

const meta: PrMeta = {
  title: 'T',
  description: 'D',
  sourceBranch: 'feat/x',
  destinationBranch: 'main',
  sourceCommit: 'abc',
}

describe('buildReviewPrompt', () => {
  it('points at the context pack and never embeds a diff', () => {
    const p = buildReviewPrompt({ meta, skills: [{ name: 'sec', content: 'check auth' }] })
    expect(p).toContain('.pr-review/pr.md')
    expect(p).toContain('.pr-review/diff.patch')
    expect(p).not.toContain('```diff')
  })

  it('embeds every skill section and constrains the skill field to session names', () => {
    const p = buildReviewPrompt({
      meta,
      skills: [
        { name: 'sec', content: 'check auth' },
        { name: 'perf', content: 'check loops' },
      ],
    })
    expect(p).toContain('## Skill: sec')
    expect(p).toContain('check auth')
    expect(p).toContain('## Skill: perf')
    expect(p).toContain('["sec","perf"]')
  })

  it('falls back to a general review with skill name "general" when no skills are given', () => {
    const p = buildReviewPrompt({ meta, skills: [] })
    expect(p).toContain('general code review')
    expect(p).toContain('["general"]')
  })

  it('includes the focus section only when focus is set', () => {
    expect(buildReviewPrompt({ meta, skills: [], focus: 'dates' })).toContain('# Reviewer focus\ndates')
    expect(buildReviewPrompt({ meta, skills: [] })).not.toContain('# Reviewer focus')
  })

  it('demands the example field and the two-sentence detail cap in the output contract', () => {
    const p = buildReviewPrompt({ meta, skills: [] })
    expect(p).toContain('"example"')
    expect(p).toContain('// before')
    expect(p).toMatch(/two sentences/i)
  })
})
