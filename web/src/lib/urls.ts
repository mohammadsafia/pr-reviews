/** Splits a textarea's content into PR URLs: one per line, trimmed, empties dropped,
 * duplicates removed preserving first-seen order. */
export function parsePrUrlLines(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split('\n')) {
    const url = line.trim()
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}
