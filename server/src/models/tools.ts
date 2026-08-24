import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_LINES = 2000
const MAX_BYTES = 50_000

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the repository. Returns line-numbered content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the repo root' },
          offset: { type: 'number', description: '0-based line to start from' },
          limit: { type: 'number', description: 'Max lines to return' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with git grep. Returns file:line:match lines.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern' },
          glob: { type: 'string', description: 'Optional pathspec, e.g. src/**/*.ts' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List tracked files, optionally filtered by a glob pathspec.',
      parameters: {
        type: 'object',
        properties: { glob: { type: 'string', description: 'Optional pathspec, e.g. *.ts' } },
      },
    },
  },
] as const

function confined(cwd: string, path: string): string | undefined {
  const abs = resolve(cwd, path)
  const rel = relative(resolve(cwd), abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return abs
}

/** Executes one model-requested tool locally, confined to the worktree. Never throws —
 * every failure is an { ok: false } result the model can read and recover from. */
export function runTool(cwd: string, name: string, args: Record<string, unknown>): { ok: boolean; content: string } {
  try {
    if (name === 'read_file') {
      const abs = confined(cwd, String(args.path ?? ''))
      if (!abs) return { ok: false, content: `Path is outside the repository: ${String(args.path)}` }
      if (statSync(abs).size > 5_000_000) return { ok: false, content: 'File too large to read' }
      const lines = readFileSync(abs, 'utf8').split('\n')
      const offset = typeof args.offset === 'number' ? Math.max(0, args.offset) : 0
      const limit = Math.min(typeof args.limit === 'number' ? args.limit : MAX_LINES, MAX_LINES)
      const slice = lines.slice(offset, offset + limit).map((l, i) => `${offset + i}: ${l}`)
      let content = slice.join('\n')
      if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES) + '\n…(truncated)'
      return { ok: true, content }
    }
    if (name === 'grep') {
      const pattern = String(args.pattern ?? '')
      const spec = typeof args.glob === 'string' && args.glob !== '' ? ['--', args.glob] : []
      try {
        const out = execFileSync('git', ['grep', '-n', '-e', pattern, ...spec], { cwd, encoding: 'utf8' })
        return { ok: true, content: out.slice(0, MAX_BYTES) }
      } catch (err: any) {
        if (err.status === 1) return { ok: true, content: '(no matches)' }
        throw err
      }
    }
    if (name === 'list_files') {
      const spec = typeof args.glob === 'string' && args.glob !== '' ? ['--', args.glob] : []
      const out = execFileSync('git', ['ls-files', ...spec], { cwd, encoding: 'utf8' })
      return { ok: true, content: out.slice(0, MAX_BYTES) }
    }
    return { ok: false, content: `Unknown tool: ${name}` }
  } catch (err: any) {
    return { ok: false, content: `Tool failed: ${err.message}` }
  }
}
