/**
 * ENVIRONMENT / TOOLS template — workspace paths, tool usage, shell specifics.
 *
 * Filename on disk is `TOOLS.md` (matching OpenClaw's recognized bootstrap
 * basename so the content auto-loads into the system prompt). Internal
 * naming keeps "environment" for semantic clarity — the file describes the
 * agent's whole environment, not just its tools.
 *
 * Generated per agent with corp root, agent dir, platform, and (new in PR 4)
 * harness-aware tool usage. Claude Code agents get Claude-Code-native
 * invocation patterns; OpenClaw agents keep the exec-based style.
 */

export type EnvironmentHarness = 'openclaw' | 'claude-code';

export interface EnvironmentTemplateOpts {
  corpRoot: string;
  agentDir: string;
  projectName?: string;
  /** Harness that will execute the agent. Defaults to 'openclaw' for backcompat. */
  harness?: EnvironmentHarness;
}

export function defaultEnvironment(
  corpRootOrOpts: string | EnvironmentTemplateOpts,
  agentDir?: string,
  projectName?: string,
  harness: EnvironmentHarness = 'openclaw',
): string {
  // Support both positional (legacy) and options-object call styles.
  const opts: EnvironmentTemplateOpts = typeof corpRootOrOpts === 'string'
    ? { corpRoot: corpRootOrOpts, agentDir: agentDir ?? '', projectName, harness }
    : corpRootOrOpts;
  const resolvedHarness = opts.harness ?? 'openclaw';

  const projectSection = opts.projectName ? `
## Project
- Project: ${opts.projectName}
- Project root: ${opts.corpRoot}/projects/${opts.projectName}/
- Project tasks: ${opts.corpRoot}/projects/${opts.projectName}/tasks/
- Project deliverables: ${opts.corpRoot}/projects/${opts.projectName}/deliverables/
- You are scoped to this project. Focus your work here.
` : '';

  return `# Environment

Your tools and workspace specifics. Update this with anything that helps you work.

## Workspace
- Corp root: ${opts.corpRoot}
- Your directory: ${opts.agentDir}
- Tasks: ${opts.projectName ? `${opts.corpRoot}/projects/${opts.projectName}/tasks/` : `${opts.corpRoot}/tasks/`}
- Deliverables: ${opts.projectName ? `${opts.corpRoot}/projects/${opts.projectName}/deliverables/` : `${opts.corpRoot}/deliverables/`}
- Resources: ${opts.corpRoot}/resources/
${projectSection}

${resolvedHarness === 'claude-code' ? claudeCodeToolsSection : openclawToolsSection}

## cc-cli Commands
The corp CLI. Use these for all corp operations — do NOT use curl or raw API calls.
${resolvedHarness === 'claude-code'
    ? `\nInvoke via the \`Bash\` tool:\n  \`Bash({ command: "cc-cli status" })\`\n`
    : `\nInvoke via \`exec\`:\n  \`exec({ command: "cc-cli status" })\`\n`}
### Communication
- \`cc-cli say --agent <slug> --message "..."\` — direct private message to any agent (instant, bypasses inbox)
- \`cc-cli send --channel <name> --message "..."\` — send message to a channel

### Monitoring
- \`cc-cli status\` — all agent states (idle/busy/broken/offline)
- \`cc-cli agents\` — list all agents
- \`cc-cli members\` / \`cc-cli who\` — list all members (agents + founder)

### Tasks
- \`cc-cli tasks\` — list all tasks (add \`--status pending\` or \`--assigned <id>\` to filter)
- \`cc-cli task create --title "..." --priority high --assigned <agent-id>\` — create and assign a task

### Hiring
- \`cc-cli hire --name "agent-name" --rank worker\` — hire a new agent (add \`--model <model>\` for specific model, \`--harness claude-code\` for the Claude Code substrate)

### Agent Control
- \`cc-cli agent start --agent <slug>\` — start an offline agent
- \`cc-cli agent stop --agent <slug>\` — stop a running agent
- \`cc-cli agent set-harness --agent <slug> --harness <name>\` — switch an agent's execution substrate

### Harness Diagnostics
- \`cc-cli harness list\` — registered harnesses + status
- \`cc-cli harness health\` — per-harness diagnostic dump

### Info
- \`cc-cli channels\` — list all channels
- \`cc-cli hierarchy\` — show org chart
- \`cc-cli inspect --agent <slug>\` — detailed agent info
- \`cc-cli messages --channel <name> --last 10\` — read recent messages
- \`cc-cli stats\` — corp statistics
- \`cc-cli uptime\` — daemon uptime
- \`cc-cli models\` — list available models

## Shell — ${process.platform === 'win32' ? 'Windows (PowerShell)' : process.platform === 'darwin' ? 'macOS (zsh)' : 'Linux (bash)'}
${process.platform === 'win32' ? `**You are on Windows.** Your shell is PowerShell, NOT bash.
- Use \`Get-Content file.txt\` instead of \`cat file.txt\`
- Use \`dir\` instead of \`ls\` (or \`Get-ChildItem\`)
- Use semicolons \`;\` to chain commands, NOT \`&&\`
- Paths use backslashes: \`C:\\Users\\...\` but forward slashes often work too
- \`grep\` is not available — use \`Select-String -Pattern "..." file.txt\`
- \`rm -rf\` → \`Remove-Item -Recurse -Force\`
- \`tail -n 20\` → \`Get-Content file.txt -Tail 20\`
- **cc-cli commands work normally** — they are Node.js, not shell-dependent` : `Standard Unix shell. Use bash commands normally.`}

## Build & Test
- Build: \`cd ${opts.corpRoot.replace(/\\/g, '/')} && pnpm build\` (if codebase project)
- Always verify your work exists after writing it

## Notes
(Add environment-specific notes here.)
`;
}

const openclawToolsSection = `## Tools Available (OpenClaw substrate)
- **\`read\` / \`write\` / \`edit\` / \`apply_patch\`** — file operations
- **\`grep\` / \`find\` / \`ls\`** — search + list
- **\`exec\` / \`process\`** — shell commands (exec one-shot, process background)
- **\`web_search\` / \`web_fetch\`** — external research
- **\`memory_search\` / \`memory_get\`** — recall from your BRAIN/ memories
- **\`sessions_send\` / \`subagents\`** — cross-session + sub-agent orchestration
- **Skills** — check your skills/ directory for specialized capabilities`;

const claudeCodeToolsSection = `## Tools Available (Claude Code substrate)
- **\`Read\` / \`Write\` / \`Edit\` / \`NotebookEdit\`** — file operations
- **\`Glob\` / \`Grep\`** — search + list
- **\`Bash\`** — shell commands (also how you invoke \`cc-cli\`)
- **\`WebSearch\` / \`WebFetch\`** — external research
- **\`Task\`** — dispatch a sub-agent for independent investigations
- **\`TodoWrite\`** — in-session task tracking (local; doesn't affect corp TASKS.md)
- **Skills** — check your skills/ directory for specialized capabilities

Your workspace files (SOUL/IDENTITY/AGENTS/TOOLS/USER/MEMORY/STATUS/INBOX/
TASKS/HEARTBEAT) are loaded into your system prompt at the start of every
turn. Other workspace files (BRAIN/*, observations/*, WORKLOG.md) are read
on demand with your \`Read\` tool — follow MEMORY.md's wikilinks into BRAIN.`;
