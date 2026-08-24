import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_PROFILES, ModelProfileSchema, type ModelProfile } from './models/profiles.js'

const home = homedir()

export const ConfigSchema = z.object({
  bitbucketEmail: z.string().default(''),
  bitbucketToken: z.string().default(''),
  githubToken: z.string().default(''),
  cloneProtocol: z.enum(['ssh', 'https']).default('ssh'),
  skillDirs: z
    .array(z.string())
    .default([join(home, 'Desktop/projects/forge-skills/skills'), join(home, '.claude/skills')]),
  model: z.string().default('claude-sonnet-5'),
  verifyModel: z.string().default('claude-haiku-4-5-20251001'),
  defaultDepth: z.enum(['thorough', 'balanced', 'economy']).default('balanced'),
  maxConcurrentRuns: z.number().int().min(1).default(2),
  modelProfiles: z.array(ModelProfileSchema).default(DEFAULT_PROFILES),
  reviewProfile: z.string().default('claude-sonnet'),
  verifyProfile: z.string().default('claude-haiku'),
  cacheDir: z.string().default(join(home, '.pr-reviewer', 'repos')),
  runsDir: z.string().default(join(home, '.pr-reviewer', 'runs')),
  diffWarnLines: z.number().int().positive().default(8000),
})

export type Config = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG_PATH = join(home, '.pr-reviewer', 'config.json')

/** Legacy model/verifyModel strings predate profiles. When no modelProfiles were stored
 * but the legacy fields were customized, synthesize claude profiles from them so tuned
 * settings never silently reset to defaults. */
function migrateLegacyModels(cfg: Config, raw: Record<string, unknown>): Config {
  if (raw.modelProfiles !== undefined) return cfg
  const out: Config = { ...cfg, modelProfiles: [...cfg.modelProfiles] }
  if (typeof raw.model === 'string' && raw.model !== 'claude-sonnet-5') {
    out.modelProfiles = [
      { id: 'legacy-model', label: `Claude (${raw.model})`, kind: 'claude', model: raw.model } as ModelProfile,
      ...out.modelProfiles,
    ]
    out.reviewProfile = 'legacy-model'
  }
  if (typeof raw.verifyModel === 'string' && raw.verifyModel !== 'claude-haiku-4-5-20251001') {
    out.modelProfiles = [
      ...out.modelProfiles,
      { id: 'legacy-verify', label: `Claude verify (${raw.verifyModel})`, kind: 'claude', model: raw.verifyModel } as ModelProfile,
    ]
    out.verifyProfile = 'legacy-verify'
  }
  return out
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): Config {
  let raw: unknown = {}
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      raw = {}
    }
  }
  const rawForMigration = (
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  ) as Record<string, unknown>
  const parsed = ConfigSchema.safeParse(raw)
  if (parsed.success) return migrateLegacyModels(parsed.data, rawForMigration)

  // Degrade per-field: a single invalid/missing field should not wipe the rest of a
  // stored config back to all-defaults. Validate each field against its own schema and
  // only fall back to that field's default when it individually fails to parse.
  const rawObj: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const shape = ConfigSchema.shape
  const merged = {} as Config
  for (const key of Object.keys(shape) as (keyof Config)[]) {
    const fieldSchema = shape[key]
    const fieldParsed = fieldSchema.safeParse(rawObj[key])
    ;(merged as any)[key] = fieldParsed.success ? fieldParsed.data : fieldSchema.parse(undefined)
  }
  return migrateLegacyModels(merged, rawForMigration)
}

export function saveConfig(cfg: Config, path: string = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
}
