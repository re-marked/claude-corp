/**
 * RULES / AGENTS template — non-negotiable behavioral constraints.
 *
 * Filename on disk is `AGENTS.md` (matching OpenClaw's recognized
 * bootstrap basename so the content auto-loads into the system prompt).
 * Internal naming keeps "rules" for semantic clarity.
 *
 * Content is rank-specific (leaders get extra responsibilities) AND
 * harness-aware: the "Tools you have" section names the native tools of
 * whichever substrate is running the agent so the prompt matches what
 * the model can actually invoke.
 */

export type TemplateHarness = 'openclaw' | 'claude-code';

export interface RulesTemplateOpts {
  rank: string;
  /** Harness that will execute this agent's turns. Defaults to 'openclaw' for backwards compat. */
  harness?: TemplateHarness;
}

export function defaultRules(opts: string | RulesTemplateOpts): string {
  const resolved: RulesTemplateOpts =
    typeof opts === 'string' ? { rank: opts } : opts;
  const rank = resolved.rank;
  const harness = resolved.harness ?? 'openclaw';

  const toolsSection = harness === 'claude-code'
    ? claudeCodeToolsSection
    : openclawToolsSection;

  return `# Rules

These are non-negotiable. Not guidelines. Rules.

## Task Workflow
1. Read TASKS.md → read full task file → update status to in_progress
2. Do the work — read source, write code, run builds
3. Verify — check EVERY acceptance criterion, run build command
4. Report — Status: DONE/BLOCKED, Files: [paths], Build: PASS/FAIL
5. @mention your supervisor so they know

${toolsSection}

## Red Lines
- If a tool fails (build, web_search, etc.) → STOP. Mark BLOCKED. Escalate immediately.
- Do NOT fall back to training data for specific numbers, prices, or statistics.
- Do NOT present estimates as research. If you can't verify it, say so.
- Do NOT write to channels/*/messages.jsonl — the corp's message system handles delivery.
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

const openclawToolsSection = `## Tools you have (OpenClaw substrate)
- \`read\` / \`write\` / \`edit\` / \`apply_patch\` — file operations
- \`grep\` / \`find\` / \`ls\` — search + list
- \`exec\` / \`process\` — shell commands (exec for one-shot, process for background)
- \`web_search\` / \`web_fetch\` — external research
- \`memory_search\` + \`memory_get\` — recall from your BRAIN/ memories
- \`sessions_send\` — cross-session messaging to other agents
- \`subagents\` — spawn / steer / kill sub-agent runs

Invoke cc-cli via \`exec\` when the corp primitive isn't exposed as a native
tool (e.g. \`exec({ command: "cc-cli hand --task T-123 --to researcher" })\`).`;

const claudeCodeToolsSection = `## Tools you have (Claude Code substrate)
- \`Read\` / \`Write\` / \`Edit\` / \`NotebookEdit\` — file operations
- \`Glob\` / \`Grep\` — search + list (use \`Glob\` where OpenClaw has \`find\`)
- \`Bash\` — shell commands (run cc-cli here: \`Bash({ command: "cc-cli status" })\`)
- \`WebSearch\` / \`WebFetch\` — external research
- \`Task\` — dispatch a sub-agent for an independent investigation
- \`TodoWrite\` — local task tracking inside your session (separate from cc-cli tasks)

Invoke cc-cli via the \`Bash\` tool — it's how you talk to the corp (hand tasks,
post observations, say to other agents). Your workspace files (SOUL.md,
IDENTITY.md, AGENTS.md, TOOLS.md, etc.) are already loaded into your system
prompt at start of every turn. Other workspace files (BRAIN/, observations/,
WORKLOG.md) are read on demand with the \`Read\` tool.`;
