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
  skills: string[]
  verdict: 'confirmed' | 'unverified'
  verifierReason?: string
}

export type RunStatus = 'running' | 'queued' | 'completed' | 'failed'

export interface RunEvent {
  kind: 'status' | 'text' | 'tool' | 'error'
  text: string
  at: string
  /** Which per-skill subagent produced this event. Absent for the shared prep phase
   * (checkout) events, which run before the fan-out and aren't attributable to any skill. */
  skill?: string
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
