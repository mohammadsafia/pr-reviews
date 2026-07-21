import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const home = homedir()

const ConfigSchema = z.object({
  bitbucketEmail: z.string().default(''),
  bitbucketToken: z.string().default(''),
  skillDirs: z
    .array(z.string())
    .default([join(home, 'Desktop/projects/forge-skills/skills'), join(home, '.claude/skills')]),
  model: z.string().default('claude-sonnet-5'),
  cacheDir: z.string().default(join(home, '.pr-reviewer', 'repos')),
  runsDir: z.string().default(join(home, '.pr-reviewer', 'runs')),
  diffWarnLines: z.number().int().positive().default(8000),
})

export type Config = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG_PATH = join(home, '.pr-reviewer', 'config.json')

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): Config {
  let raw: unknown = {}
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      raw = {}
    }
  }
  const parsed = ConfigSchema.safeParse(raw)
  return parsed.success ? parsed.data : ConfigSchema.parse({})
}

export function saveConfig(cfg: Config, path: string = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
}
