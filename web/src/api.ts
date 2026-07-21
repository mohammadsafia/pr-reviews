import type { Config, RunEvent, RunRecord, SkillInfo } from './types.js'

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
export const listRuns = () => fetch('/api/runs').then((r) => json<RunRecord[]>(r))
export const getRun = (id: string) => fetch(`/api/runs/${id}`).then((r) => json<RunRecord>(r))

export async function createRun(input: {
  url: string
  skills: string[]
  focus?: string
  force?: boolean
}): Promise<{ id?: string; error?: string; diffLines?: number; status: number }> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json()) as any
  return { ...body, status: res.status }
}

export const postComments = (id: string, findingIndexes: number[]) =>
  fetch(`/api/runs/${id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findingIndexes }),
  })
    .then((r) => json<{ posted: number[] }>(r))
    .then((r) => r.posted)

export const clearRepoCache = (workspace: string, repo: string) =>
  fetch(`/api/cache/${workspace}/${repo}`, { method: 'DELETE' }).then(() => undefined)

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
