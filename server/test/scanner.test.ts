import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSkillDirs, readSkillContent } from '../src/skills/scanner.js'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'prr-skills-'))
  mkdirSync(join(root, 'review-code'))
  writeFileSync(
    join(root, 'review-code', 'SKILL.md'),
    '---\nname: review-code\ndescription: Review code against standards\n---\n\n# Body here\n',
  )
  mkdirSync(join(root, 'no-frontmatter'))
  writeFileSync(join(root, 'no-frontmatter', 'SKILL.md'), '# Just a body\n')
  mkdirSync(join(root, 'not-a-skill'))
  writeFileSync(join(root, 'not-a-skill', 'README.md'), 'nope')
  mkdirSync(join(root, 'audit-quality'))
  writeFileSync(
    join(root, 'audit-quality', 'SKILL.md'),
    '---\nname: audit-quality\ndescription: Audit for quality\ncategory: quality\n---\n\n# Body\n',
  )
})

describe('scanSkillDirs', () => {
  it('finds skills with SKILL.md and parses frontmatter', () => {
    const skills = scanSkillDirs([root, '/does/not/exist'])
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['audit-quality', 'no-frontmatter', 'review-code'])
    const rc = skills.find((s) => s.name === 'review-code')!
    expect(rc.description).toBe('Review code against standards')
    expect(rc.source).toBe(root)
    expect(rc.dir).toBe(join(root, 'review-code'))
  })

  it('reads full skill content', () => {
    const rc = scanSkillDirs([root]).find((s) => s.name === 'review-code')!
    expect(readSkillContent(rc)).toContain('# Body here')
  })

  it('surfaces an explicit category from frontmatter', () => {
    const aq = scanSkillDirs([root]).find((s) => s.name === 'audit-quality')!
    expect(aq.category).toBe('quality')
  })

  it('leaves category undefined when frontmatter omits it', () => {
    const rc = scanSkillDirs([root]).find((s) => s.name === 'review-code')!
    expect(rc.category).toBeUndefined()
  })
})
