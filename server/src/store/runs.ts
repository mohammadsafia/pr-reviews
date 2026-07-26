import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunRecord } from '../types.js'

/** Migrates a run parsed from disk into the current shape: pre-verify runs default
 * `verify` to true (verification didn't exist, so treat legacy runs as if it ran), and
 * pre-skills[] findings had a single `skill: string` field which is renamed to `skills: []`
 * with a defaulted `verdict` (verification didn't exist, so treat them as confirmed). */
export function normalizeRun(raw: any): RunRecord {
  const run = raw as RunRecord
  if (run.verify === undefined) run.verify = true
  if (Array.isArray(run.findings)) {
    for (const f of run.findings as any[]) {
      if (f.skills === undefined) f.skills = f.skill !== undefined ? [f.skill] : []
      delete f.skill
      if (f.verdict === undefined) f.verdict = 'confirmed'
    }
  }
  return run
}

/** Parses a run record file, returning undefined (instead of throwing) if it's corrupt —
 * one bad file should never take down get()/list() for every other run. */
function readRun(path: string): RunRecord | undefined {
  try {
    return normalizeRun(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

export class RunStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  create(
    partial: Omit<
      RunRecord,
      'id' | 'createdAt' | 'findings' | 'transcript' | 'postedCommentIds' | 'skillResults'
    >,
  ): RunRecord {
    const run: RunRecord = {
      ...partial,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      findings: [],
      transcript: [],
      postedCommentIds: [],
      skillResults: [],
    }
    this.save(run)
    return run
  }

  save(run: RunRecord): void {
    const target = this.path(run.id)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(run, null, 2))
    renameSync(tmp, target)
  }

  get(id: string): RunRecord | undefined {
    const p = this.path(id)
    if (!existsSync(p)) return undefined
    return readRun(p)
  }

  list(): RunRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.json.tmp'))
      .map((f) => readRun(join(this.dir, f)))
      .filter((r): r is RunRecord => r !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r, transcript: [] }))
  }
}
