import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_DEFS, runTool } from '../src/models/tools.js'

let cwd: string

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'prr-tools-'))
  execFileSync('git', ['init', '-q'], { cwd })
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'a.ts'), 'const needle = 1\nconst hay = 2\n')
  writeFileSync(join(cwd, 'b.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n'))
  execFileSync('git', ['add', '.'], { cwd })
})

describe('TOOL_DEFS', () => {
  it('declares the three tools as OpenAI function tools', () => {
    expect(TOOL_DEFS.map((t: any) => t.function.name).sort()).toEqual(['grep', 'list_files', 'read_file'])
    expect(TOOL_DEFS.every((t: any) => t.type === 'function')).toBe(true)
  })
})

describe('runTool', () => {
  it('read_file returns numbered content and honors offset/limit', () => {
    const r = runTool(cwd, 'read_file', { path: 'src/a.ts' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('needle')
    const window = runTool(cwd, 'read_file', { path: 'b.txt', offset: 100, limit: 2 })
    expect(window.content).toContain('line 100')
    expect(window.content).not.toContain('line 102')
  })

  it('read_file caps output at 2000 lines', () => {
    const r = runTool(cwd, 'read_file', { path: 'b.txt' })
    expect(r.ok).toBe(true)
    expect(r.content).not.toContain('line 2500')
  })

  it('rejects a path escaping the worktree without throwing', () => {
    const r = runTool(cwd, 'read_file', { path: '../../etc/passwd' })
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/outside/i)
  })

  it('grep finds matches and reports no-match cleanly', () => {
    expect(runTool(cwd, 'grep', { pattern: 'needle' }).content).toContain('src/a.ts')
    const none = runTool(cwd, 'grep', { pattern: 'zzz-not-here' })
    expect(none.ok).toBe(true)
    expect(none.content).toMatch(/no matches/i)
  })

  it('list_files lists tracked files, optionally filtered by glob', () => {
    expect(runTool(cwd, 'list_files', {}).content).toContain('src/a.ts')
    expect(runTool(cwd, 'list_files', { glob: '*.txt' }).content).toContain('b.txt')
  })

  it('unknown tool name returns an error result', () => {
    expect(runTool(cwd, 'rm_rf', {}).ok).toBe(false)
  })
})
