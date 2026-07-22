import { describe, it, expect } from 'vitest'
import { parsePrUrl } from '../src/bitbucket/parsePrUrl.js'

describe('parsePrUrl', () => {
  it('parses a standard Bitbucket PR URL', () => {
    expect(parsePrUrl('https://bitbucket.org/appswave/rsk/pull-requests/42')).toEqual({
      workspace: 'appswave',
      repo: 'rsk',
      id: 42,
    })
  })

  it('tolerates trailing path segments and whitespace', () => {
    expect(parsePrUrl('  https://bitbucket.org/ws/my-repo/pull-requests/7/diff  ')).toEqual({
      workspace: 'ws',
      repo: 'my-repo',
      id: 7,
    })
  })

  it('rejects non-PR URLs', () => {
    expect(() => parsePrUrl('https://bitbucket.org/ws/repo/src/main')).toThrow(/Invalid PR URL/)
    expect(() => parsePrUrl('https://github.com/a/b/pull/1')).toThrow(/Invalid PR URL/)
    expect(() => parsePrUrl('not a url')).toThrow(/Invalid PR URL/)
  })
})
