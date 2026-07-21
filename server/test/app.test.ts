import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { saveConfig, loadConfig } from '../src/config.js'

function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prr-app-'))
  const skillsDir = join(dir, 'skills')
  mkdirSync(join(skillsDir, 'review-code'), { recursive: true })
  writeFileSync(
    join(skillsDir, 'review-code', 'SKILL.md'),
    '---\nname: review-code\ndescription: desc\n---\nbody',
  )
  const path = join(dir, 'config.json')
  const cfg = loadConfig(path)
  cfg.bitbucketToken = 'tok'
  cfg.bitbucketEmail = 'e@x.io'
  cfg.skillDirs = [skillsDir]
  cfg.runsDir = join(dir, 'runs')
  cfg.cacheDir = join(dir, 'repos')
  saveConfig(cfg, path)
  return path
}

describe('app', () => {
  it('GET /api/config masks the token', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.statusCode).toBe(200)
    expect(res.json().bitbucketToken).toBe('***')
  })

  it('PUT /api/config keeps existing token when masked value is sent', async () => {
    const path = tempConfig()
    const app = buildApp({ configPath: path })
    const body = { ...loadConfig(path), bitbucketToken: '***', model: 'claude-opus-4-8' }
    const res = await app.inject({ method: 'PUT', url: '/api/config', payload: body })
    expect(res.statusCode).toBe(200)
    expect(loadConfig(path).bitbucketToken).toBe('tok')
    expect(loadConfig(path).model).toBe('claude-opus-4-8')
  })

  it('GET /api/skills lists scanned skills', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({ method: 'GET', url: '/api/skills' })
    expect(res.json().map((s: any) => s.name)).toEqual(['review-code'])
  })

  it('POST /api/runs rejects an invalid URL with 400', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { url: 'https://github.com/a/b/pull/1', skills: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Invalid PR URL/)
  })

  it('GET /api/runs/:id returns 404 for unknown run', async () => {
    const app = buildApp({ configPath: tempConfig() })
    const res = await app.inject({ method: 'GET', url: '/api/runs/nope' })
    expect(res.statusCode).toBe(404)
  })
})
