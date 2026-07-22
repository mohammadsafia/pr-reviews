import { BitbucketClient } from '../bitbucket/client.js'
import type { Config } from '../config.js'
import { GitHubClient } from '../github/client.js'
import type { PrProviderClient, PrRef } from '../types.js'

export function makeClient(pr: PrRef, cfg: Config): PrProviderClient {
  if (pr.provider === 'github') return new GitHubClient(cfg.githubToken)
  return new BitbucketClient(cfg.bitbucketEmail, cfg.bitbucketToken)
}
