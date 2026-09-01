import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter, scanSkillDirs, readSkillContent } from '../src/skills/scanner.js'

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

describe('scanSkillDirs (root itself is a skill)', () => {
  it('treats a root whose own dir directly has SKILL.md as exactly one skill', () => {
    const singleSkillRoot = mkdtempSync(join(tmpdir(), 'prr-skills-single-'))
    writeFileSync(
      join(singleSkillRoot, 'SKILL.md'),
      '---\nname: single-skill\ndescription: A repo that is one skill\n---\n\n# Body\n',
    )
    const skills = scanSkillDirs([singleSkillRoot])
    expect(skills).toHaveLength(1)
    expect(skills[0].dir).toBe(singleSkillRoot)
    expect(skills[0].source).toBe(singleSkillRoot)
    expect(skills[0].name).toBe('single-skill')
  })
})

describe('scanSkillDirs (unreadable subdirectory)', () => {
  let unreadableRoot: string
  let lockedDir: string

  beforeAll(() => {
    unreadableRoot = mkdtempSync(join(tmpdir(), 'prr-skills-unreadable-'))
    mkdirSync(join(unreadableRoot, 'good-skill'))
    writeFileSync(
      join(unreadableRoot, 'good-skill', 'SKILL.md'),
      '---\nname: good-skill\ndescription: Still found\n---\n\n# Body\n',
    )
    lockedDir = join(unreadableRoot, 'locked')
    mkdirSync(lockedDir)
    writeFileSync(join(lockedDir, 'SKILL.md'), '---\nname: hidden\n---\n')
    chmodSync(lockedDir, 0o000)
  })

  afterAll(() => {
    // Restore permissions so the OS temp-dir cleanup (or test runner teardown) can remove it.
    chmodSync(lockedDir, 0o755)
  })

  it('skips a directory it cannot read instead of aborting the whole scan', () => {
    const skills = scanSkillDirs([unreadableRoot])
    const names = skills.map((s) => s.name)
    expect(names).toContain('good-skill')
    expect(names).not.toContain('hidden')
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

describe('parseFrontmatter', () => {
  it('parses name/description/category out of YAML frontmatter', () => {
    const md = '---\nname: my-skill\ndescription: does things\ncategory: review\n---\nbody'
    expect(parseFrontmatter(md)).toEqual({ name: 'my-skill', description: 'does things', category: 'review' })
  })

  it('returns an empty object when there is no frontmatter block', () => {
    expect(parseFrontmatter('just a body, no frontmatter')).toEqual({})
  })
})
