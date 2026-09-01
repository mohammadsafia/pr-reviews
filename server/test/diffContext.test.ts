import { describe, it, expect } from 'vitest'
import { extractDiffContext } from '../src/review/diffContext.js'

describe('extractDiffContext', () => {
  it('returns undefined when the file is not in the diff', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n')
    expect(extractDiffContext(diff, 'b.ts', 1)).toBeUndefined()
  })

  it('returns undefined when the line is not found in any hunk', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n')
    expect(extractDiffContext(diff, 'a.ts', 999)).toBeUndefined()
  })

  it('returns undefined for an empty diff without throwing', () => {
    expect(extractDiffContext('', 'a.ts', 1)).toBeUndefined()
  })

  it('centers radius lines of context around a matched new-file line', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,10 +1,10 @@',
      ' line1',
      ' line2',
      ' line3',
      ' line4',
      ' line5',
      ' line6',
      ' line7',
      ' line8',
      ' line9',
      ' line10',
    ].join('\n')
    expect(extractDiffContext(diff, 'f.ts', 5, 3)).toEqual([
      { type: 'context', text: 'line2', oldLine: 2, newLine: 2 },
      { type: 'context', text: 'line3', oldLine: 3, newLine: 3 },
      { type: 'context', text: 'line4', oldLine: 4, newLine: 4 },
      { type: 'context', text: 'line5', oldLine: 5, newLine: 5 },
      { type: 'context', text: 'line6', oldLine: 6, newLine: 6 },
      { type: 'context', text: 'line7', oldLine: 7, newLine: 7 },
      { type: 'context', text: 'line8', oldLine: 8, newLine: 8 },
    ])
  })

  it('clamps the radius at the start of a hunk instead of padding', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,10 +1,10 @@',
      ' line1',
      ' line2',
      ' line3',
      ' line4',
      ' line5',
    ].join('\n')
    expect(extractDiffContext(diff, 'f.ts', 1, 3)).toEqual([
      { type: 'context', text: 'line1', oldLine: 1, newLine: 1 },
      { type: 'context', text: 'line2', oldLine: 2, newLine: 2 },
      { type: 'context', text: 'line3', oldLine: 3, newLine: 3 },
      { type: 'context', text: 'line4', oldLine: 4, newLine: 4 },
    ])
  })

  it('clamps the radius at the end of a hunk instead of padding', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,10 +1,10 @@',
      ' line1',
      ' line2',
      ' line3',
      ' line4',
      ' line5',
    ].join('\n')
    expect(extractDiffContext(diff, 'f.ts', 5, 3)).toEqual([
      { type: 'context', text: 'line2', oldLine: 2, newLine: 2 },
      { type: 'context', text: 'line3', oldLine: 3, newLine: 3 },
      { type: 'context', text: 'line4', oldLine: 4, newLine: 4 },
      { type: 'context', text: 'line5', oldLine: 5, newLine: 5 },
    ])
  })

  it('never crosses into a second hunk in the same file, even when radius would reach it', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,3 +1,3 @@',
      ' a1',
      ' a2',
      ' a3',
      '@@ -50,3 +50,3 @@',
      ' b1',
      ' b2',
      ' b3',
    ].join('\n')
    // a3 is the last line of hunk 1; radius 3 would reach 3 lines into hunk 2 if hunks
    // were flattened together. It must not.
    expect(extractDiffContext(diff, 'f.ts', 3, 3)).toEqual([
      { type: 'context', text: 'a1', oldLine: 1, newLine: 1 },
      { type: 'context', text: 'a2', oldLine: 2, newLine: 2 },
      { type: 'context', text: 'a3', oldLine: 3, newLine: 3 },
    ])
  })

  it('classifies add and remove lines, and picks the requested file out of a multi-file diff', () => {
    const diff = [
      'diff --git a/first.ts b/first.ts',
      '--- a/first.ts',
      '+++ b/first.ts',
      '@@ -1,1 +1,1 @@',
      '-old first',
      '+new first',
      'diff --git a/second.ts b/second.ts',
      '--- a/second.ts',
      '+++ b/second.ts',
      '@@ -1,1 +1,1 @@',
      '-old second',
      '+new second',
    ].join('\n')
    expect(extractDiffContext(diff, 'second.ts', 1, 3)).toEqual([
      { type: 'remove', text: 'old second', oldLine: 1 },
      { type: 'add', text: 'new second', newLine: 1 },
    ])
  })
})
