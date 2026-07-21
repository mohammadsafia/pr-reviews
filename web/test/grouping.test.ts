import { describe, it, expect } from 'vitest'
import { parseRoute } from '../src/App.js'
import { groupSkillsBySource } from '../src/screens/NewReview.js'

describe('parseRoute', () => {
  it('routes hashes to screens', () => {
    expect(parseRoute('')).toEqual({ screen: 'new' })
    expect(parseRoute('#/')).toEqual({ screen: 'new' })
    expect(parseRoute('#/runs/abc')).toEqual({ screen: 'run', id: 'abc' })
    expect(parseRoute('#/settings')).toEqual({ screen: 'settings' })
    expect(parseRoute('#/junk')).toEqual({ screen: 'new' })
  })
})

describe('groupSkillsBySource', () => {
  it('groups by source dir preserving order', () => {
    const a = { name: 'x', description: '', dir: '/s1/x', source: '/s1' }
    const b = { name: 'y', description: '', dir: '/s2/y', source: '/s2' }
    const c = { name: 'z', description: '', dir: '/s1/z', source: '/s1' }
    const g = groupSkillsBySource([a, b, c])
    expect([...g.keys()]).toEqual(['/s1', '/s2'])
    expect(g.get('/s1')!.map((s) => s.name)).toEqual(['x', 'z'])
  })
})
