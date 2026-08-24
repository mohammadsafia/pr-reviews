import { describe, it, expect } from 'vitest'
import { DEFAULT_PROFILES, ModelProfileSchema, profileById, type ModelProfile } from '../src/models/profiles.js'

const cli: ModelProfile = { id: 'codex', label: 'Codex', kind: 'cli', command: 'codex', args: ['exec', '--cd', '{cwd}', '-'] }
const openai: ModelProfile = { id: 'kimi', label: 'Kimi', kind: 'openai', baseUrl: 'https://api.moonshot.ai/v1', apiKey: 'k', model: 'kimi-k2' }

describe('ModelProfileSchema', () => {
  it('accepts all three kinds', () => {
    expect(ModelProfileSchema.safeParse(DEFAULT_PROFILES[0]).success).toBe(true)
    expect(ModelProfileSchema.safeParse(cli).success).toBe(true)
    expect(ModelProfileSchema.safeParse(openai).success).toBe(true)
  })
  it('rejects an unknown kind and missing kind-specific fields', () => {
    expect(ModelProfileSchema.safeParse({ id: 'x', label: 'x', kind: 'magic' }).success).toBe(false)
    expect(ModelProfileSchema.safeParse({ id: 'x', label: 'x', kind: 'openai', model: 'm' }).success).toBe(false)
  })
})

describe('profileById', () => {
  const cfg = { modelProfiles: [cli, ...DEFAULT_PROFILES, openai] }
  it('finds a profile by id', () => {
    expect(profileById(cfg, 'kimi')).toBe(openai)
  })
  it('falls back to the first claude profile for unknown or undefined ids', () => {
    expect(profileById(cfg, 'deleted-one').id).toBe('claude-sonnet')
    expect(profileById(cfg, undefined).id).toBe('claude-sonnet')
  })
  it('falls back to the first profile when no claude profile exists', () => {
    expect(profileById({ modelProfiles: [cli, openai] }, 'nope')).toBe(cli)
  })
  it('falls back to the built-in default when the list is empty', () => {
    expect(profileById({ modelProfiles: [] }, 'nope').id).toBe('claude-sonnet')
  })
})
