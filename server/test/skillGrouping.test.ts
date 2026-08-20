import { describe, it, expect } from 'vitest'
import { groupSkills } from '../src/review/grouping.js'

const skills = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

describe('groupSkills', () => {
  it('thorough → one skill per group', () => {
    expect(groupSkills(skills(3), 'thorough')).toEqual([['s0'], ['s1'], ['s2']])
  })
  it('balanced → chunks of 3, remainder in the last group', () => {
    expect(groupSkills(skills(7), 'balanced')).toEqual([
      ['s0', 's1', 's2'],
      ['s3', 's4', 's5'],
      ['s6'],
    ])
  })
  it('economy → everything in one group', () => {
    expect(groupSkills(skills(5), 'economy')).toEqual([['s0', 's1', 's2', 's3', 's4']])
  })
  it('empty input → no groups, for every depth', () => {
    expect(groupSkills([], 'thorough')).toEqual([])
    expect(groupSkills([], 'balanced')).toEqual([])
    expect(groupSkills([], 'economy')).toEqual([])
  })
  it('single skill → one group of one, for every depth', () => {
    expect(groupSkills(['a'], 'balanced')).toEqual([['a']])
    expect(groupSkills(['a'], 'economy')).toEqual([['a']])
  })
})
