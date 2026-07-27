import { describe, it, expect } from 'vitest'
import { isLoginExpiryError, failedSkillNames, runHasLoginExpiry } from '../src/lib/runErrors.js'
import type { RunRecord } from '../src/types.js'

const baseRun = (over: Partial<RunRecord>): RunRecord => ({
  id: 'r1',
  pr: { provider: 'bitbucket', workspace: 'w', repo: 'r', id: 1 },
  prTitle: 'T',
  skills: ['review-code', 'audit-a11y'],
  status: 'failed',
  createdAt: '2026-07-27T00:00:00.000Z',
  findings: [],
  transcript: [],
  postedCommentIds: [],
  skillResults: [],
  verify: true,
  ...over,
})

describe('isLoginExpiryError', () => {
  it('matches the three login-expiry signatures, any casing', () => {
    expect(isLoginExpiryError('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true)
    expect(isLoginExpiryError('oauth session EXPIRED')).toBe(true)
    expect(isLoginExpiryError('token Could Not Be Refreshed')).toBe(true)
  })
  it('rejects generic errors and undefined', () => {
    expect(isLoginExpiryError('Bitbucket API error 502')).toBe(false)
    expect(isLoginExpiryError('git clone failed: repository not found')).toBe(false)
    expect(isLoginExpiryError(undefined)).toBe(false)
  })
})

describe('failedSkillNames', () => {
  it('returns only failed selected skills, drops general, dedupes, preserves order', () => {
    const run = baseRun({
      skills: ['review-code', 'audit-a11y'],
      skillResults: [
        { skill: 'review-code', status: 'failed', findingCount: 0, error: 'x' },
        { skill: 'audit-a11y', status: 'completed', findingCount: 2 },
        { skill: 'general', status: 'failed', findingCount: 0, error: 'x' }, // not a selected skill → dropped
        { skill: 'review-code', status: 'failed', findingCount: 0, error: 'x' }, // dupe → collapsed
      ],
    })
    expect(failedSkillNames(run)).toEqual(['review-code'])
  })
  it('returns [] when nothing failed', () => {
    expect(failedSkillNames(baseRun({ skillResults: [{ skill: 'review-code', status: 'completed', findingCount: 1 }] }))).toEqual([])
  })
})

describe('runHasLoginExpiry', () => {
  it('true when a skillResult error looks like login expiry', () => {
    expect(runHasLoginExpiry(baseRun({ skillResults: [{ skill: 'review-code', status: 'failed', findingCount: 0, error: 'OAuth session expired' }] }))).toBe(true)
  })
  it('true when the run-level error looks like login expiry', () => {
    expect(runHasLoginExpiry(baseRun({ error: 'Failed to authenticate' }))).toBe(true)
  })
  it('false for generic failures', () => {
    expect(runHasLoginExpiry(baseRun({ error: 'All 2 skill reviews failed', skillResults: [{ skill: 'review-code', status: 'failed', findingCount: 0, error: 'git clone failed' }] }))).toBe(false)
  })
})
