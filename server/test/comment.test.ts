import { describe, it, expect } from 'vitest'
import { formatComment } from '../src/review/comment.js'
import type { Finding } from '../src/types.js'

const base: Finding = {
  file: 'a.ts',
  line: 3,
  severity: 'high',
  category: 'bug',
  summary: 'socket leaks on unmount',
  detail: 'Each remount opens a new connection.',
  suggestion: 'Return a cleanup from the effect.',
  example: '```tsx\n// before\nuseEffect(() => { s.connect() }, [])\n// after\nuseEffect(() => { s.connect(); return () => s.disconnect() }, [])\n```',
  skills: ['react-hooks'],
  verdict: 'confirmed',
}

describe('formatComment', () => {
  it('renders header, why, example, and fix in the compact template', () => {
    const c = formatComment(base)
    expect(c).toBe(
      '**🔴 High · bug** — socket leaks on unmount\n\n' +
        '**Why:** Each remount opens a new connection.\n\n' +
        base.example +
        '\n\n**Fix:** Return a cleanup from the effect.',
    )
  })

  it('uses the right emoji per severity', () => {
    expect(formatComment({ ...base, severity: 'medium' })).toContain('**🟠 Medium · bug**')
    expect(formatComment({ ...base, severity: 'low' })).toContain('**🟡 Low · bug**')
    expect(formatComment({ ...base, severity: 'info' })).toContain('**ℹ️ Info · bug**')
  })

  it('omits the example block when example is empty or absent (legacy findings)', () => {
    const noExample = formatComment({ ...base, example: '' })
    expect(noExample).not.toContain('```tsx')
    const legacy = formatComment({ ...base, example: undefined })
    expect(legacy).toContain('**Fix:**')
  })

  it('omits the fix line when suggestion is empty', () => {
    expect(formatComment({ ...base, suggestion: '' })).not.toContain('**Fix:**')
  })
})
