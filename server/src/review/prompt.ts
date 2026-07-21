import type { PrMeta } from '../types.js'

export function buildReviewPrompt(input: {
  meta: PrMeta
  diff: string
  skills: { name: string; content: string }[]
  focus?: string
}): string {
  const { meta, diff, skills, focus } = input
  const skillSections = skills
    .map((s) => `## Skill: ${s.name}\n\n${s.content}`)
    .join('\n\n')

  return `You are performing a code review of a Bitbucket pull request.
The repository is checked out at your working directory at the PR's head commit.
Use Read/Grep/Glob to inspect surrounding code — do not limit yourself to the diff.

# Pull request
Title: ${meta.title}
Description: ${meta.description || '(none)'}
Source branch: ${meta.sourceBranch} → Destination: ${meta.destinationBranch}

# Mandatory review instructions
Apply EVERY skill below. Each is mandatory, not optional.

${skillSections || '(no extra skills selected — perform a general code review)'}
${focus ? `\n# Reviewer focus\n${focus}\n` : ''}
# Diff under review
\`\`\`diff
${diff}
\`\`\`

# Output contract (strict)
After your investigation, end your reply with ONE fenced \`\`\`json block containing a JSON array.
Each element must be exactly:
{
  "file": "path relative to repo root",
  "line": <positive integer — line in the NEW file version>,
  "severity": "high" | "medium" | "low" | "info",
  "category": "bug" | "security" | "performance" | "a11y" | "rtl" | "style" | "convention",
  "summary": "one sentence",
  "detail": "explanation with reasoning",
  "suggestion": "concrete fix, may include code",
  "skill": "name of the skill that produced this finding"
}
Only report findings on files changed in the diff. An empty array [] is a valid result.
Do not put any text after the json block.`
}
