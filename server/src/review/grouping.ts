import type { Depth } from '../types.js'

/** Chunks skills into session groups by review depth. Order-preserving. */
export function groupSkills<T>(items: T[], depth: Depth): T[][] {
  if (items.length === 0) return []
  const size = depth === 'thorough' ? 1 : depth === 'balanced' ? 3 : items.length
  const groups: T[][] = []
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size))
  return groups
}
