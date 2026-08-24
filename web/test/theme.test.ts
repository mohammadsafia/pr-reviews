import { describe, it, expect } from 'vitest'
import { resolveTheme } from '../src/lib/theme.js'

describe('resolveTheme', () => {
  it('honors a stored explicit choice over the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
  it('follows the system preference when nothing valid is stored', () => {
    expect(resolveTheme(null, true)).toBe('dark')
    expect(resolveTheme(null, false)).toBe('light')
    expect(resolveTheme('bogus', true)).toBe('dark')
  })
})
