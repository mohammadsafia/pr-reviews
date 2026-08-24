import { describe, it, expect, vi, afterEach } from 'vitest'
import { timeAgo } from '../src/lib/time.js'

afterEach(() => vi.useRealTimers())

describe('timeAgo', () => {
  it('formats minutes, hours, and days with a just-now floor', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T12:00:00Z'))
    expect(timeAgo('2026-08-24T11:59:40Z')).toBe('just now')
    expect(timeAgo('2026-08-24T11:15:00Z')).toBe('45m ago')
    expect(timeAgo('2026-08-24T09:00:00Z')).toBe('3h ago')
    expect(timeAgo('2026-08-22T12:00:00Z')).toBe('2d ago')
  })
})
