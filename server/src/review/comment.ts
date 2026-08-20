import type { Finding, Severity } from '../types.js'

const EMOJI: Record<Severity, string> = { high: '🔴', medium: '🟠', low: '🟡', info: 'ℹ️' }
const LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }

/** Compact PR comment body: header, why, optional before/after example, optional fix.
 * The invisible fingerprint marker is NOT included — the posting route appends it. Keep
 * this in sync with formatCommentBody in web/src/pages/RunView.tsx (the preview mirror). */
export function formatComment(f: Finding): string {
  const parts = [
    `**${EMOJI[f.severity]} ${LABEL[f.severity]} · ${f.category}** — ${f.summary}`,
    `**Why:** ${f.detail}`,
  ]
  if (f.example) parts.push(f.example)
  if (f.suggestion) parts.push(`**Fix:** ${f.suggestion}`)
  return parts.join('\n\n')
}
