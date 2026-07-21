import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunRecord } from '../types.js'

export class RunStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  create(
    partial: Omit<RunRecord, 'id' | 'createdAt' | 'findings' | 'transcript' | 'postedCommentIds'>,
  ): RunRecord {
    const run: RunRecord = {
      ...partial,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      findings: [],
      transcript: [],
      postedCommentIds: [],
    }
    this.save(run)
    return run
  }

  save(run: RunRecord): void {
    writeFileSync(this.path(run.id), JSON.stringify(run, null, 2))
  }

  get(id: string): RunRecord | undefined {
    const p = this.path(id)
    if (!existsSync(p)) return undefined
    return JSON.parse(readFileSync(p, 'utf8')) as RunRecord
  }

  list(): RunRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as RunRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r, transcript: [] }))
  }
}
