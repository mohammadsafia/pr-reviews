import { describe, it, expect } from 'vitest'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '../src/config.js'

describe('config', () => {
  it('returns defaults when file is missing', () => {
    const cfg = loadConfig(join(tmpdir(), 'nope', 'config.json'))
    expect(cfg.model).toBe('claude-sonnet-5')
    expect(cfg.diffWarnLines).toBe(8000)
    expect(cfg.bitbucketToken).toBe('')
    expect(cfg.cacheDir.endsWith('/.pr-reviewer/repos')).toBe(true)
    expect(cfg.cloneProtocol).toBe('ssh')
  })

  it('round-trips save and load, with 0600 permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
    const path = join(dir, 'deep', 'config.json')
    const cfg = loadConfig(path)
    cfg.bitbucketEmail = 'fe@appswave.io'
    cfg.bitbucketToken = 'secret'
    cfg.skillDirs = ['/tmp/skills']
    saveConfig(cfg, path)
    const loaded = loadConfig(path)
    expect(loaded.bitbucketEmail).toBe('fe@appswave.io')
    expect(loaded.skillDirs).toEqual(['/tmp/skills'])
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('enforces 0600 permissions when saving over existing file with loose permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, '{}')
    chmodSync(path, 0o644)
    const cfg = loadConfig(path)
    cfg.bitbucketToken = 'secret'
    saveConfig(cfg, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('falls back to defaults on corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, '{not json')
    expect(loadConfig(path).model).toBe('claude-sonnet-5')
  })

  it('degrades per-field: an invalid field falls back to its default without wiping other valid fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prr-cfg-'))
    const path = join(dir, 'config.json')
    writeFileSync(
      path,
      JSON.stringify({
        bitbucketEmail: 'ok@x.io',
        bitbucketToken: 'sekret',
        cloneProtocol: 'ftp', // invalid: not 'ssh' | 'https'
        diffWarnLines: 500,
      }),
    )
    const cfg = loadConfig(path)
    expect(cfg.bitbucketEmail).toBe('ok@x.io')
    expect(cfg.bitbucketToken).toBe('sekret')
    expect(cfg.diffWarnLines).toBe(500)
    expect(cfg.cloneProtocol).toBe('ssh')
  })
})
