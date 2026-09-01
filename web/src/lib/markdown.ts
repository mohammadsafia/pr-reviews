export type InlinePart = { text: string; bold: boolean }
export type Segment =
  | { type: 'paragraph'; parts: InlinePart[] }
  | { type: 'code'; lang: string; code: string }

function parseParts(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  const boldPattern = /\*\*(.+?)\*\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = boldPattern.exec(text))) {
    if (match.index > lastIndex) parts.push({ text: text.slice(lastIndex, match.index), bold: false })
    parts.push({ text: match[1], bold: true })
    lastIndex = boldPattern.lastIndex
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), bold: false })
  return parts
}

function parseProse(text: string): Segment[] {
  return text
    .split('\n\n')
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => ({ type: 'paragraph', parts: parseParts(paragraph) }))
}

/** Parses the small markdown subset this app itself produces (formatComment/formatCommentBody):
 * `**bold**` spans and ```-fenced code blocks, both possibly interleaved with plain prose
 * paragraphs. Not a general markdown parser — just enough to render our own output instead of
 * showing its literal `**`/``` syntax to the user. Fenced blocks are extracted first (via a
 * single global regex pass) so a blank line inside a fence doesn't get mistaken for a paragraph
 * break. */
export function parseMarkdown(text: string): Segment[] {
  const fencePattern = /```(\w*)\n([\s\S]*?)```/g
  const segments: Segment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = fencePattern.exec(text))) {
    segments.push(...parseProse(text.slice(lastIndex, match.index)))
    segments.push({ type: 'code', lang: match[1], code: match[2].replace(/\n$/, '') })
    lastIndex = fencePattern.lastIndex
  }
  segments.push(...parseProse(text.slice(lastIndex)))
  return segments
}

/** Extracts the single fenced code block a string is expected to contain (e.g. a finding's
 * `example` field, which the review prompt defines as "a short fenced code block"). Falls back
 * to the trimmed original text with an empty lang when no fence is present, so a non-compliant
 * model response still renders as something rather than nothing. */
export function extractFence(text: string): { lang: string; code: string } {
  const code = parseMarkdown(text).find((s): s is Extract<Segment, { type: 'code' }> => s.type === 'code')
  return code ? { lang: code.lang, code: code.code } : { lang: '', code: text.trim() }
}
