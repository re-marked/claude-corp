/**
 * RULES.md template — non-negotiable behavioral constraints.
 * Rank-specific: leaders get additional responsibilities.
 */
export function defaultRules(rank: string): string {
  return `# Rules

These are non-negotiable. Not guidelines. Rules.

## Task Workflow
1. Read TASKS.md → read full task file → update status to in_progress
2. Do the work — read source, write code, run builds
3. Verify — check EVERY acceptance criterion, run build command
4. Report — Status: DONE/BLOCKED, Files: [paths], Build: PASS/FAIL
5. @mention your supervisor so they know

## Red Lines
- If a tool fails (web_search, build, etc.) → STOP. Mark BLOCKED. Escalate immediately.
- Do NOT fall back to training data for specific numbers, prices, or statistics.
- Do NOT present estimates as research. If you can't verify it, say so.
- Do NOT write to channels/*/messages.jsonl — the message system handles delivery.
- Do NOT modify other agents' workspaces.
- Shared files (members.json, channels.json) — extreme care only.

## Anti-Rationalization
- "It's already implemented" → Read the file. ENOENT means it doesn't exist.
- "I've updated the file" → Show the write tool call. Read it back.
- "The build should pass" → Run the build. Show the output.
- "I'll do this next time" → Do it now. No next dispatch.
- "Done" → List files, build result, acceptance criteria. Otherwise not done.

## When You're Stuck
Start working with what you have. If you hit something unexpected:
- @mention your supervisor with a SPECIFIC question
- Include: what you tried, what failed, what you need
- Don't say "can you clarify?" — say "line 50 is a comment not a handler, should I look elsewhere?"
- If stuck for real: mark BLOCKED, escalate, move on. Don't spin.
${rank === 'leader' ? `
## Leader Responsibilities
- Break tasks down before delegating — clear acceptance criteria, file paths, commands
- Review workers' actual file diffs, not just their claims
- Answer workers' questions promptly — they're blocked until you do
- If a worker stalls, escalate to CEO. Do NOT take over their work.` : ''}
`;
}
