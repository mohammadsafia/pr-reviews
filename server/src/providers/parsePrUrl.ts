import type { PrRef } from '../types.js'

const BITBUCKET_RE = /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:\/|$|\?)/
const GITHUB_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$|\?)/

const INVALID_MESSAGE =
  'Invalid PR URL. Expected https://bitbucket.org/<workspace>/<repo>/pull-requests/<id> ' +
  'or https://github.com/<owner>/<repo>/pull/<id>'

export function parsePrUrl(url: string): PrRef {
  const trimmed = url.trim()

  const bb = BITBUCKET_RE.exec(trimmed)
  if (bb) return { provider: 'bitbucket', workspace: bb[1], repo: bb[2], id: Number(bb[3]) }

  const gh = GITHUB_RE.exec(trimmed)
  if (gh) return { provider: 'github', workspace: gh[1], repo: gh[2], id: Number(gh[3]) }

  throw new Error(INVALID_MESSAGE)
}
