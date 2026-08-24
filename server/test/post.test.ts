import { describe, it, expect } from 'vitest'
import { postFindingComments } from '../src/review/post.js'
import { commentMarker, fingerprint } from '../src/review/fingerprint.js'
import type { Finding, PrProviderClient, RunRecord } from '../src/types.js'

const pr = { provider: 'bitbucket' as const, workspace: 'ws', repo: 'r', id: 1 }

const mkFinding = (n: number): Finding => ({
  file: `f${n}.ts`, line: n + 1, severity: 'high', category: 'bug', summary: `finding ${n}`,
  detail: 'd', suggestion: 'x', skills: ['s'], verdict: 'confirmed',
})

function mkRun(findings: Finding[]): RunRecord {
  return {
    id: 'r1', pr, prTitle: 'T', skills: [], verify: true, status: 'completed',
    createdAt: 'now', findings, transcript: [], postedCommentIds: [], skillResults: [],
  } as RunRecord
}

function mkClient(overrides: Partial<PrProviderClient> = {}): { client: PrProviderClient; posted: any[] } {
  const posted: any[] = []
  const client: PrProviderClient = {
    getPullRequest: async () => ({ title: 'T', description: '', sourceBranch: 'f', destinationBranch: 'm', sourceCommit: '' }),
    getDiff: async () => '',
    postInlineComment: async (_pr, c) => {
      posted.push(c)
      return posted.length
    },
    listComments: async () => [],
    cloneUrl: () => '',
    ...overrides,
  }
  return { client, posted }
}

describe('postFindingComments', () => {
  it('posts new findings with the fingerprint marker and records ids', async () => {
    const run = mkRun([mkFinding(0), mkFinding(1)])
    const { client, posted } = mkClient()
    const saves: number[] = []
    const res = await postFindingComments(client, run, [0, 1], () => saves.push(1))
    expect(res.posted).toEqual([1, 2])
    expect(posted[0].text).toContain(commentMarker(fingerprint(pr, run.findings[0])))
    expect(run.postedCommentIds).toEqual([1, 2])
    expect(saves.length).toBe(2)
  })

  it('skips already-posted and resolved findings based on existing comments', async () => {
    const run = mkRun([mkFinding(0), mkFinding(1)])
    const { client, posted } = mkClient({
      listComments: async () => [
        { body: `x ${commentMarker(fingerprint(pr, run.findings[0]))}`, resolved: false },
        { body: `x ${commentMarker(fingerprint(pr, run.findings[1]))}`, resolved: true },
      ],
    })
    const res = await postFindingComments(client, run, [0, 1], () => {})
    expect(posted).toHaveLength(0)
    expect(res.skipped).toEqual([
      { index: 0, reason: 'already-posted' },
      { index: 1, reason: 'resolved' },
    ])
  })

  it('stops at the first posting failure and reports it', async () => {
    const run = mkRun([mkFinding(0), mkFinding(1)])
    const { client } = mkClient({
      postInlineComment: async () => {
        throw new Error('bitbucket down')
      },
    })
    const res = await postFindingComments(client, run, [0, 1], () => {})
    expect(res.posted).toEqual([])
    expect(res.failed).toEqual([{ index: 0, error: 'bitbucket down' }])
  })

  it('with requireDedupe, posts nothing when the comment read fails', async () => {
    const run = mkRun([mkFinding(0)])
    const { client, posted } = mkClient({
      listComments: async () => {
        throw new Error('read failed')
      },
    })
    const res = await postFindingComments(client, run, [0], () => {}, { requireDedupe: true })
    expect(res.dedupeChecked).toBe(false)
    expect(posted).toHaveLength(0)
    expect(res.posted).toEqual([])
  })

  it('without requireDedupe, a failed comment read still posts (manual-dialog behavior)', async () => {
    const run = mkRun([mkFinding(0)])
    const { client, posted } = mkClient({
      listComments: async () => {
        throw new Error('read failed')
      },
    })
    const res = await postFindingComments(client, run, [0], () => {})
    expect(res.dedupeChecked).toBe(false)
    expect(posted).toHaveLength(1)
  })
})
