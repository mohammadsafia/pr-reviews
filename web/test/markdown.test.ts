import { describe, it, expect } from 'vitest'
import { extractFence, parseMarkdown } from '../src/lib/markdown.js'

describe('parseMarkdown', () => {
  it('renders plain text with no formatting as one paragraph, one part', () => {
    const segments = parseMarkdown('hello world')
    expect(segments).toEqual([{ type: 'paragraph', parts: [{ text: 'hello world', bold: false }] }])
  })

  it('splits a bold span out as its own part', () => {
    const segments = parseMarkdown('**Why:** it breaks')
    expect(segments).toEqual([
      {
        type: 'paragraph',
        parts: [
          { text: 'Why:', bold: true },
          { text: ' it breaks', bold: false },
        ],
      },
    ])
  })

  it('splits on blank lines into separate paragraph segments', () => {
    const segments = parseMarkdown('first para\n\nsecond para')
    expect(segments).toEqual([
      { type: 'paragraph', parts: [{ text: 'first para', bold: false }] },
      { type: 'paragraph', parts: [{ text: 'second para', bold: false }] },
    ])
  })

  it('renders a fenced code block as a code segment with the fence markers stripped', () => {
    const segments = parseMarkdown('```js\n// before\nconst x = 1\n```')
    expect(segments).toEqual([{ type: 'code', lang: 'js', code: '// before\nconst x = 1' }])
  })

  it('renders a fence with no language tag as an empty lang', () => {
    const segments = parseMarkdown('```\nplain text\n```')
    expect(segments).toEqual([{ type: 'code', lang: '', code: 'plain text' }])
  })

  it('preserves a blank line inside a fenced block instead of splitting it into paragraphs', () => {
    const segments = parseMarkdown('```js\n// before\n\n// after\n```')
    expect(segments).toEqual([{ type: 'code', lang: 'js', code: '// before\n\n// after' }])
  })

  it('orders prose, a fenced block, and trailing prose as three segments', () => {
    const segments = parseMarkdown('before para\n\n```js\ncode line\n```\n\nafter para')
    expect(segments).toEqual([
      { type: 'paragraph', parts: [{ text: 'before para', bold: false }] },
      { type: 'code', lang: 'js', code: 'code line' },
      { type: 'paragraph', parts: [{ text: 'after para', bold: false }] },
    ])
  })
})

describe('extractFence', () => {
  it('strips the fence markers off a fenced string', () => {
    expect(extractFence('```js\n// before\nconst x = 1\n```')).toEqual({ lang: 'js', code: '// before\nconst x = 1' })
  })

  it('falls back to the trimmed original text when there is no fence', () => {
    expect(extractFence('no fence here')).toEqual({ lang: '', code: 'no fence here' })
  })
})
