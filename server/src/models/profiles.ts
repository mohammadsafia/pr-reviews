import { z } from 'zod'

export const ModelProfileSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1), label: z.string().min(1), kind: z.literal('claude'), model: z.string().min(1) }),
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.literal('cli'),
    command: z.string().min(1),
    args: z.array(z.string()),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.literal('openai'),
    baseUrl: z.string().min(1),
    apiKey: z.string(),
    model: z.string().min(1),
  }),
])

export type ModelProfile = z.infer<typeof ModelProfileSchema>

export const DEFAULT_PROFILES: ModelProfile[] = [
  { id: 'claude-sonnet', label: 'Claude Sonnet', kind: 'claude', model: 'claude-sonnet-5' },
  { id: 'claude-haiku', label: 'Claude Haiku', kind: 'claude', model: 'claude-haiku-4-5-20251001' },
]

/** Resolves a profile reference. Never throws: unknown/undefined ids fall back to the
 * first claude-kind profile, else the first profile, else the built-in default — a
 * dangling reference (deleted profile) must degrade, not crash a queued run. */
export function profileById(cfg: { modelProfiles: ModelProfile[] }, id: string | undefined): ModelProfile {
  const list = cfg.modelProfiles
  const found = id !== undefined ? list.find((p) => p.id === id) : undefined
  return found ?? list.find((p) => p.kind === 'claude') ?? list[0] ?? DEFAULT_PROFILES[0]
}
