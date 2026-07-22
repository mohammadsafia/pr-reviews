import { describe, it, expect } from 'vitest'
import { makeClient } from '../src/providers/factory.js'
import { BitbucketClient } from '../src/bitbucket/client.js'
import { GitHubClient } from '../src/github/client.js'
import { loadConfig } from '../src/config.js'

describe('makeClient', () => {
  it('returns a BitbucketClient for a bitbucket PrRef', () => {
    const cfg = loadConfig('/nonexistent/config.json')
    cfg.bitbucketEmail = 'e@x.io'
    cfg.bitbucketToken = 'tok'
    const client = makeClient({ provider: 'bitbucket', workspace: 'ws', repo: 'r', id: 1 }, cfg)
    expect(client).toBeInstanceOf(BitbucketClient)
  })

  it('returns a GitHubClient for a github PrRef', () => {
    const cfg = loadConfig('/nonexistent/config.json')
    cfg.githubToken = 'ghtok'
    const client = makeClient({ provider: 'github', workspace: 'acme', repo: 'r', id: 1 }, cfg)
    expect(client).toBeInstanceOf(GitHubClient)
  })
})
