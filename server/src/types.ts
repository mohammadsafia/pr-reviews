import type { DiffContextLine } from './review/diffContext.js'

export type Provider = 'bitbucket' | 'github'

export type Depth = 'thorough' | 'balanced' | 'economy'

export interface AutoSubmit {
  threshold: 'high' | 'medium' | 'all'
  confirmedOnly: boolean
}

export interface PrRef {
  provider: Provider
  workspace: string // Bitbucket workspace OR GitHub owner
  repo: string
  id: number
}

export interface ExistingComment {
  path?: string
  line?: number
  body: string
  resolved: boolean
}

/** Structural shape the app depends on for talking to a PR host — implemented by both
 * BitbucketClient and GitHubClient. Supersedes the old bitbucket-only `BitbucketLike`. */
export interface PrProviderClient {
  getPullRequest(pr: PrRef): Promise<PrMeta>
  getDiff(pr: PrRef): Promise<string>
  postInlineComment(pr: PrRef, c: { path: string; line: number; text: string }): Promise<number>
  listComments(pr: PrRef): Promise<ExistingComment[]>
  cloneUrl(pr: PrRef, protocol?: 'ssh' | 'https'): string
}

/** An open PR where the configured user is a requested reviewer, as listed by a provider. */
export interface ReviewerPr {
  provider: Provider
  workspace: string
  repo: string
  id: number
  title: string
  author: string
  updatedAt: string
  url: string
}

export type Severity = 'high' | 'medium' | 'low' | 'info'

export interface Finding {
  file: string
  line: number
  severity: Severity
  category: string
  summary: string
  detail: string
  suggestion: string
  /** Short fenced before/after code snippet. Empty/absent on legacy runs and when the
   * model omitted it — renderers must degrade gracefully. */
  example?: string
  /** A few lines of surrounding diff context, extracted from the diff at review time.
   * Absent when the line couldn't be located in the diff, and on runs recorded before this
   * field existed — renderers must degrade gracefully. */
  context?: DiffContextLine[]
  skills: string[]
  verdict: 'confirmed' | 'unverified'
  verifierReason?: string
}

export type RunStatus = 'running' | 'queued' | 'completed' | 'failed'

export interface RunEvent {
  kind: 'status' | 'text' | 'tool' | 'error' | 'usage'
  text: string
  at: string
  /** Which per-skill subagent produced this event. Absent for the shared prep phase
   * (checkout) events, which run before the fan-out and aren't attributable to any skill. */
  skill?: string
  /** Set only on kind:'usage' events. */
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

/** Outcome of one skill's subagent within a fanned-out run — one per review unit
 * (a selected skill, or the synthetic "general" unit when no skills were selected). */
export interface SkillRunResult {
  skill: string
  status: 'completed' | 'failed'
  findingCount: number
  error?: string
}

export interface RunRecord {
  id: string
  /** The run this one was created from via "Retry run"/"Retry failed skills". Absent for
   * a run started fresh from New Review. Not validated against an existing run — a stale
   * or missing parent is indistinguishable from having none at all. */
  parentRunId?: string
  pr: PrRef
  prTitle: string
  skills: string[]
  focus?: string
  verify: boolean
  /** Review depth used for this run. Absent on runs stored before depth modes existed. */
  depth?: Depth
  /** Model profile id this run reviewed with. Absent on runs stored before profiles existed. */
  reviewProfile?: string
  /** Auto-post options for this run; absent = off. */
  autoSubmit?: AutoSubmit
  /** Outcome of the auto-post step, set only when autoSubmit ran. */
  autoSubmitResult?: { posted: number; skipped: number; failed: number; dedupeChecked: boolean }
  status: RunStatus
  createdAt: string
  finishedAt?: string
  findings: Finding[]
  transcript: RunEvent[]
  error?: string
  postedCommentIds: number[]
  skillResults: SkillRunResult[]
  /** Accumulated token/cost totals across every session in this run. Absent when no
   * session reported usage (e.g. an all-CLI-profile run) — never a fabricated zero. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
  /** True for a run created via the skill test-run flow (an ad-hoc, unsaved skill tested
   * against a real PR) rather than a normal review. Excluded from GET /api/runs so test
   * iterations don't clutter run history; still individually fetchable by id. */
  isTest?: boolean
  /** The exact skill content that was tested, present only when isTest is true — lets a
   * later look at a test run show precisely what wording produced its findings. */
  testSkillContent?: string
}

export interface SkillInfo {
  name: string
  description: string
  dir: string
  source: string
  category?: string
}

export interface PrMeta {
  title: string
  description: string
  sourceBranch: string
  destinationBranch: string
  sourceCommit: string
}
