import { describe, it, expect } from 'vitest'
import { parsePrUrl } from '../src/providers/parsePrUrl.js'

describe('parsePrUrl', () => {
  it('parses a standard Bitbucket PR URL', () => {
    expect(parsePrUrl('https://bitbucket.org/appswave/rsk/pull-requests/42')).toEqual({
      provider: 'bitbucket',
      workspace: 'appswave',
      repo: 'rsk',
      id: 42,
    })
  })

  it('tolerates trailing path segments and whitespace for Bitbucket', () => {
    expect(parsePrUrl('  https://bitbucket.org/ws/my-repo/pull-requests/7/diff  ')).toEqual({
      provider: 'bitbucket',
      workspace: 'ws',
      repo: 'my-repo',
      id: 7,
    })
  })

  it('tolerates a trailing query string for Bitbucket', () => {
    expect(parsePrUrl('https://bitbucket.org/appswave/rsk/pull-requests/42?something')).toEqual({
      provider: 'bitbucket',
      workspace: 'appswave',
      repo: 'rsk',
      id: 42,
    })
  })

  it('parses a standard GitHub PR URL', () => {
    expect(parsePrUrl('https://github.com/appswave/rsk/pull/42')).toEqual({
      provider: 'github',
      workspace: 'appswave',
      repo: 'rsk',
      id: 42,
    })
  })

  it('tolerates trailing path segments and whitespace for GitHub', () => {
    expect(parsePrUrl('  https://github.com/ws/my-repo/pull/7/files  ')).toEqual({
      provider: 'github',
      workspace: 'ws',
      repo: 'my-repo',
      id: 7,
    })
  })

  it('tolerates a trailing query string for GitHub', () => {
    expect(parsePrUrl('https://github.com/appswave/rsk/pull/7?diff=split')).toEqual({
      provider: 'github',
      workspace: 'appswave',
      repo: 'rsk',
      id: 7,
    })
  })

  it('rejects non-PR URLs', () => {
    expect(() => parsePrUrl('https://bitbucket.org/ws/repo/src/main')).toThrow(/Invalid PR URL/)
    expect(() => parsePrUrl('not a url')).toThrow(/Invalid PR URL/)
  })

  it('rejects a github non-PR url', () => {
    expect(() => parsePrUrl('https://github.com/ws/repo/issues/1')).toThrow(/Invalid PR URL/)
  })

  it('error message names both accepted formats', () => {
    expect(() => parsePrUrl('nope')).toThrow(
      /bitbucket\.org.*pull-requests.*github\.com.*pull/,
    )
  })
})
