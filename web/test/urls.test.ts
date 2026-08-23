import { describe, it, expect } from 'vitest'
import { parsePrUrlLines } from '../src/lib/urls.js'

describe('parsePrUrlLines', () => {
  it('splits lines, trims whitespace, and drops empties', () => {
    expect(parsePrUrlLines('  https://a/1  \n\nhttps://b/2\n   \n')).toEqual(['https://a/1', 'https://b/2'])
  })
  it('dedupes preserving first-seen order', () => {
    expect(parsePrUrlLines('https://a/1\nhttps://b/2\nhttps://a/1')).toEqual(['https://a/1', 'https://b/2'])
  })
  it('returns [] for empty input', () => {
    expect(parsePrUrlLines('')).toEqual([])
    expect(parsePrUrlLines('  \n \n')).toEqual([])
  })
})
