export interface DiffContextLine {
  type: 'context' | 'add' | 'remove'
  text: string
  newLine?: number
  oldLine?: number
}

/** Groups a unified diff's raw lines by file, keyed by the b/ (destination) path — the
 * same rename convention parseDiffStats (contextPack.ts) uses: the b/ path wins. */
function splitByFile(diff: string): Map<string, string[]> {
  const files = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (header) {
      current = []
      files.set(header[2], current)
      continue
    }
    current?.push(line)
  }
  return files
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Parses one file's diff lines into hunks of typed, line-numbered content. Context lines
 * increment both old/new counters; additions increment only new; removals increment only
 * old — standard unified diff semantics. */
function parseHunks(lines: string[]): DiffContextLine[][] {
  const hunks: DiffContextLine[][] = []
  let oldLine = 0
  let newLine = 0
  let current: DiffContextLine[] | undefined
  for (const line of lines) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      current = []
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith(' ')) {
      current.push({ type: 'context', text: line.slice(1), oldLine, newLine })
      oldLine++
      newLine++
    } else if (line.startsWith('+')) {
      current.push({ type: 'add', text: line.slice(1), newLine })
      newLine++
    } else if (line.startsWith('-')) {
      current.push({ type: 'remove', text: line.slice(1), oldLine })
      oldLine++
    }
  }
  return hunks
}

/** Extracts up to `radius` lines of diff context on each side of `file`'s line `line`
 * (matched against the new-file/post-PR line number). Returns undefined when the file or
 * line can't be located — never throws. The returned slice is clamped to the hunk the
 * match falls in; it never extends into a neighboring hunk, since the diff omits the
 * unchanged gap between hunks and flattening them would misrepresent unrelated code as
 * adjacent. */
export function extractDiffContext(
  diff: string,
  file: string,
  line: number,
  radius = 3,
): DiffContextLine[] | undefined {
  const fileLines = splitByFile(diff).get(file)
  if (!fileLines) return undefined
  for (const hunk of parseHunks(fileLines)) {
    const idx = hunk.findIndex((l) => l.newLine === line)
    if (idx === -1) continue
    const start = Math.max(0, idx - radius)
    const end = Math.min(hunk.length, idx + radius + 1)
    return hunk.slice(start, end)
  }
  return undefined
}
