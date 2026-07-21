export interface PrRef {
  workspace: string
  repo: string
  id: number
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
  skill: string
}

export type RunStatus = 'running' | 'queued' | 'completed' | 'failed'

export interface RunEvent {
  kind: 'status' | 'text' | 'tool' | 'error'
  text: string
  at: string
}

export interface RunRecord {
  id: string
  pr: PrRef
  prTitle: string
  skills: string[]
  focus?: string
  status: RunStatus
  createdAt: string
  finishedAt?: string
  findings: Finding[]
  transcript: RunEvent[]
  error?: string
  postedCommentIds: number[]
}

export interface SkillInfo {
  name: string
  description: string
  dir: string
  source: string
}

export interface Config {
  bitbucketEmail: string
  bitbucketToken: string
  skillDirs: string[]
  model: string
  cacheDir: string
  runsDir: string
  diffWarnLines: number
}
