import type { AutoSubmit, Config, ReviewerPr, RunEvent, RunRecord, SkillInfo } from './types.js'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(((await res.json()) as any).error ?? `HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export const getConfig = () => fetch('/api/config').then((r) => json<Config>(r))
export const putConfig = (c: Config) =>
  fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c),
  }).then((r) => json<{ ok: boolean }>(r).then(() => undefined))

export const getSkills = () => fetch('/api/skills').then((r) => json<SkillInfo[]>(r))

export interface ReviewerPrsResult {
  prs: ReviewerPr[]
  errors: { provider: 'bitbucket' | 'github'; message: string }[]
}

export const getReviewerPrs = () => fetch('/api/reviewer-prs').then((r) => json<ReviewerPrsResult>(r))
export const listRuns = () => fetch('/api/runs').then((r) => json<RunRecord[]>(r))
export const getRun = (id: string) => fetch(`/api/runs/${id}`).then((r) => json<RunRecord>(r))

export async function createRun(input: {
  url: string
  skills: string[]
  focus?: string
  verify?: boolean
  force?: boolean
  depth?: 'thorough' | 'balanced' | 'economy'
  profile?: string
  autoSubmit?: AutoSubmit
  parentRunId?: string
}): Promise<{ id?: string; error?: string; diffLines?: number; status: number }> {
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    let body: any = {}
    try {
      body = await res.json()
    } catch {
      body = { error: `Server returned a non-JSON response (HTTP ${res.status})` }
    }
    return { ...body, status: res.status }
  } catch (err: any) {
    return { error: err?.message ?? 'Network error', status: 0 }
  }
}

export interface PostCommentsResult {
  posted: number[]
  skipped: { index: number; reason: 'already-posted' | 'resolved' }[]
  failed: { index: number; error: string }[]
  dedupeChecked: boolean
}

export const postComments = (id: string, findingIndexes: number[]) =>
  fetch(`/api/runs/${id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findingIndexes }),
  }).then((r) => json<PostCommentsResult>(r))

export interface PostPreview {
  statuses: { index: number; status: 'new' | 'already-posted' | 'resolved' }[]
  dedupeChecked: boolean
}

export const getPostPreview = (id: string) =>
  fetch(`/api/runs/${id}/post-preview`).then((r) => json<PostPreview>(r))

export async function clearRepoCache(
  provider: 'bitbucket' | 'github',
  workspace: string,
  repo: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/cache/${provider}/${workspace}/${repo}`, { method: 'DELETE' })
    if (!res.ok) {
      let body: any = {}
      try {
        body = await res.json()
      } catch {
        // ignore non-JSON body
      }
      return { ok: false, error: body.error ?? `HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error' }
  }
}

export async function addGithubSkillSource(
  repo: string,
): Promise<{ dir?: string; skillCount?: number; error?: string }> {
  try {
    const res = await fetch('/api/skill-sources/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    })
    let body: any = {}
    try {
      body = await res.json()
    } catch {
      body = { error: `Server returned a non-JSON response (HTTP ${res.status})` }
    }
    if (!res.ok) return { error: body.error ?? `HTTP ${res.status}` }
    return body
  } catch (err: any) {
    return { error: err?.message ?? 'Network error' }
  }
}

export async function removeSkillSource(
  dir: string,
): Promise<{ ok: boolean; warning?: string; error?: string }> {
  try {
    const res = await fetch('/api/skill-sources', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    if (!res.ok) {
      let body: any = {}
      try {
        body = await res.json()
      } catch {
        // ignore non-JSON body
      }
      return { ok: false, error: body.error ?? `HTTP ${res.status}` }
    }
    let body: any = {}
    try {
      body = await res.json()
    } catch {
      // ignore non-JSON body
    }
    return { ok: true, warning: body.warning as string | undefined }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error' }
  }
}

export async function refreshSkillSource(
  dir: string,
): Promise<{ skillCount?: number; error?: string }> {
  try {
    const res = await fetch('/api/skill-sources/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    let body: any = {}
    try {
      body = await res.json()
    } catch {
      body = { error: `Server returned a non-JSON response (HTTP ${res.status})` }
    }
    if (!res.ok) return { error: body.error ?? `HTTP ${res.status}` }
    return body
  } catch (err: any) {
    return { error: err?.message ?? 'Network error' }
  }
}

export function subscribeRun(
  id: string,
  onEvent: (e: RunEvent) => void,
  onDone: () => void,
): () => void {
  const es = new EventSource(`/api/runs/${id}/events`)
  es.onmessage = (m) => onEvent(JSON.parse(m.data) as RunEvent)
  es.addEventListener('done', () => {
    es.close()
    onDone()
  })
  return () => es.close()
}
