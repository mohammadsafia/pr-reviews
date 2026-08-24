import { describe, it, expect } from 'vitest'
import { queryFor } from '../src/models/resolve.js'

describe('queryFor', () => {
  it('returns a function for claude profiles', () => {
    const q = queryFor({ id: 'c', label: 'C', kind: 'claude', model: 'claude-sonnet-5' })
    expect(typeof q).toBe('function')
  })
  it('returns a function for cli and openai profiles', () => {
    expect(typeof queryFor({ id: 'c', label: 'C', kind: 'cli', command: 'x', args: [] })).toBe('function')
    expect(typeof queryFor({ id: 'k', label: 'K', kind: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'm' })).toBe('function')
  })
})
