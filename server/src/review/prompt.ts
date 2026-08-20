import type { PrMeta } from '../types.js'

export function buildReviewPrompt(input: {
  meta: PrMeta
  skills: { name: string; content: string }[]
  focus?: string
}): string {
  const { meta, skills, focus } = input
  const skillSections = skills
    .map((s) => `## Skill: ${s.name}\n\n${s.content}`)
    .join('\n\n')
  const skillNames = skills.length > 0 ? skills.map((s) => s.name) : ['general']

  return `You are performing a code review of a pull request.
The repository is checked out at your working directory at the PR's head commit.

READ FIRST (with the Read tool):
- .pr-review/pr.md — the PR's title, description, and changed-file list with per-file line counts
- .pr-review/diff.patch — the full diff. Read ONLY the sections relevant to your skills; use the changed-file list in pr.md to decide which files to skip entirely.

Use Read/Grep/Glob to inspect surrounding code — do not limit yourself to the diff.

# Pull request
Title: ${meta.title}
Source branch: ${meta.sourceBranch} → Destination: ${meta.destinationBranch}

# Mandatory review instructions
Apply EVERY skill below. Each is mandatory, not optional.

${skillSections || '(no extra skills selected — perform a general code review)'}
${focus ? `\n# Reviewer focus\n${focus}\n` : ''}
# Output contract (strict)
After your investigation, end your reply with ONE fenced \`\`\`json block containing a JSON array.
Each element must be exactly:
{
  "file": "path relative to repo root",
  "line": <positive integer — line in the NEW file version>,
  "severity": "high" | "medium" | "low" | "info",
  "category": "bug" | "security" | "performance" | "a11y" | "rtl" | "style" | "convention",
  "summary": "one sentence",
  "detail": "the reasoning, AT MOST two sentences",
  "suggestion": "concrete fix in one or two sentences",
  "example": "a short fenced code block showing the fix as // before and // after, or \\"\\" if no code example applies",
  "skill": <the skill that produced this finding — MUST be one of ${JSON.stringify(skillNames)}>
}
Only report findings on files listed in .pr-review/pr.md, on lines changed in the diff.
An empty array [] is a valid result.
Do not put any text after the json block.`
}
