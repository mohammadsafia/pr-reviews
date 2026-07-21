import type { PrRef } from '../types.js'

const PR_URL_RE = /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/

export function parsePrUrl(url: string): PrRef {
  const m = PR_URL_RE.exec(url.trim())
  if (!m) {
    throw new Error(
      'Invalid PR URL. Expected https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>',
    )
  }
  return { workspace: m[1], repo: m[2], id: Number(m[3]) }
}
