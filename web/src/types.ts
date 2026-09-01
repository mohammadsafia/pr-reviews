export interface AutoSubmit {
  threshold: 'high' | 'medium' | 'all'
  confirmedOnly: boolean
}

export type ModelProfile =
  | { id: string; label: string; kind: 'claude'; model: string }
  | { id: string; label: string; kind: 'cli'; command: string; args: string[]; timeoutMs?: number }
  | { id: string; label: string; kind: 'openai'; baseUrl: string; apiKey: string; model: string }

export interface PrRef {
  provider: 'bitbucket' | 'github'
  workspace: string
  repo: string
  id: number
}

/** An open PR where the configured user is a requested reviewer, as listed by a provider. */
export interface ReviewerPr {
  provider: 'bitbucket' | 'github'
  workspace: string
  repo: string
  id: number
  title: string
  author: string
  updatedAt: string
  url: string
}

export type Severity = 'high' | 'medium' | 'low' | 'info'

export interface DiffContextLine {
  type: 'context' | 'add' | 'remove'
  text: string
  newLine?: number
  oldLine?: number
}

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
   * a run started fresh from New Review. */
  parentRunId?: string
  pr: PrRef
  prTitle: string
  skills: string[]
  focus?: string
  verify: boolean
  /** Review depth used for this run. Absent on runs stored before depth modes existed. */
  depth?: 'thorough' | 'balanced' | 'economy'
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
}

export interface SkillInfo {
  name: string
  description: string
  dir: string
  source: string
  category?: string
}

export interface Config {
  bitbucketEmail: string
  bitbucketToken: string
  bitbucketWorkspace: string
  githubToken: string
  cloneProtocol: 'ssh' | 'https'
  skillDirs: string[]
  model: string
  verifyModel: string
  defaultDepth: 'thorough' | 'balanced' | 'economy'
  maxConcurrentRuns: number
  modelProfiles: ModelProfile[]
  reviewProfile: string
  verifyProfile: string
  cacheDir: string
  runsDir: string
  diffWarnLines: number
}
