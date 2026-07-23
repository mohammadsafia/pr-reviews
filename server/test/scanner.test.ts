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

let nestedRoot: string

beforeAll(() => {
  nestedRoot = mkdtempSync(join(tmpdir(), 'prr-skills-nested-'))
  // top-level skills/ dir with categories, no direct SKILL.md
  mkdirSync(join(nestedRoot, 'skills', 'engineering', 'code-review'), { recursive: true })
  writeFileSync(
    join(nestedRoot, 'skills', 'engineering', 'code-review', 'SKILL.md'),
    '---\nname: code-review\ndescription: Review engineering code\ncategory: engineering\n---\n\n# Body\n',
  )
  mkdirSync(join(nestedRoot, 'skills', 'productivity', 'daily-standup'), { recursive: true })
  writeFileSync(
    join(nestedRoot, 'skills', 'productivity', 'daily-standup', 'SKILL.md'),
    '---\nname: daily-standup\ndescription: Run a daily standup\ncategory: productivity\n---\n\n# Body\n',
  )
  // a README at the skills/ level that must not be mistaken for a skill
  writeFileSync(join(nestedRoot, 'skills', 'README.md'), '# not a skill\n')
  // a dotdir that must be ignored entirely, even if it contains a SKILL.md
  mkdirSync(join(nestedRoot, '.git', 'junk'), { recursive: true })
  writeFileSync(join(nestedRoot, '.git', 'junk', 'SKILL.md'), '---\nname: junk\n---\n')
  // a skill whose own subdir must not become a phantom nested skill
  mkdirSync(join(nestedRoot, 'skills', 'misc', 'foo', 'reference'), { recursive: true })
  writeFileSync(
    join(nestedRoot, 'skills', 'misc', 'foo', 'SKILL.md'),
    '---\nname: foo\ndescription: Foo skill\ncategory: misc\n---\n\n# Body\n',
  )
  writeFileSync(
    join(nestedRoot, 'skills', 'misc', 'foo', 'reference', 'SKILL.md'),
    '---\nname: reference-should-not-appear\n---\n',
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

describe('scanSkillDirs (nested/categorized layout)', () => {
  it('finds skills nested under category subdirectories, with source pointing at the configured root', () => {
    const skills = scanSkillDirs([nestedRoot])
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['code-review', 'daily-standup', 'foo'])
    const cr = skills.find((s) => s.name === 'code-review')!
    expect(cr.description).toBe('Review engineering code')
    expect(cr.dir).toBe(join(nestedRoot, 'skills', 'engineering', 'code-review'))
    expect(cr.source).toBe(nestedRoot)
  })

  it('ignores dotdirs even when they contain a SKILL.md', () => {
    const skills = scanSkillDirs([nestedRoot])
    expect(skills.some((s) => s.name === 'junk')).toBe(false)
  })

  it('does not descend into a skill directory once it has its own SKILL.md', () => {
    const skills = scanSkillDirs([nestedRoot])
    expect(skills.some((s) => s.name === 'reference-should-not-appear')).toBe(false)
    const foo = skills.find((s) => s.name === 'foo')!
    expect(foo.dir).toBe(join(nestedRoot, 'skills', 'misc', 'foo'))
  })
})
