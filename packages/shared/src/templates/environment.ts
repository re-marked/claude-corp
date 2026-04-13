/**
 * ENVIRONMENT.md template — workspace paths, tools, shell specifics.
 * Generated dynamically per agent based on corp root, agent dir, platform.
 */
export function defaultEnvironment(corpRoot: string, agentDir: string, projectName?: string): string {
  const projectSection = projectName ? `
## Project
- Project: ${projectName}
- Project root: ${corpRoot}/projects/${projectName}/
- Project tasks: ${corpRoot}/projects/${projectName}/tasks/
- Project deliverables: ${corpRoot}/projects/${projectName}/deliverables/
- You are scoped to this project. Focus your work here.
` : '';

  return `# Environment

Your tools and workspace specifics. Update this with anything that helps you work.

## Workspace
- Corp root: ${corpRoot}
- Your directory: ${agentDir}
- Tasks: ${projectName ? `${corpRoot}/projects/${projectName}/tasks/` : `${corpRoot}/tasks/`}
- Deliverables: ${projectName ? `${corpRoot}/projects/${projectName}/deliverables/` : `${corpRoot}/deliverables/`}
- Resources: ${corpRoot}/resources/
${projectSection}

## Tools Available
- **File read/write** — read any file, write to your workspace and deliverables
- **Bash/exec** — run commands, build, test
- **web_search** — research current data, verify numbers, find sources
- **Skills** — check your skills/ directory for specialized capabilities

## cc-cli Commands
The corp CLI. Use these for all corp operations — do NOT use curl or raw API calls.

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
- \`cc-cli hire --name "agent-name" --rank worker\` — hire a new agent (add \`--model <model>\` for specific model)

### Agent Control
- \`cc-cli agent start --agent <slug>\` — start an offline agent
- \`cc-cli agent stop --agent <slug>\` — stop a running agent

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
- Build: \`cd ${corpRoot.replace(/\\/g, '/')} && pnpm build\` (if codebase project)
- Always verify your work exists after writing it

## Notes
(Add environment-specific notes here.)
`;
}
