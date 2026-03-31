import type { Fragment } from './types.js';

export const ccCliFragment: Fragment = {
  id: 'cc-cli',
  applies: () => true,
  order: 15, // After workspace (10), before behavioral fragments
  render: () => `## cc-cli — Corp Command Line
Use these for ALL corp operations. Do NOT use curl or raw API calls.

### Tasks (Hand = when work begins)
- \`cc-cli task create --title "..." --priority high\` — create task (PLANNING only, no dispatch)
- \`cc-cli task create --title "..." --to <agent-slug>\` — create AND hand (starts work immediately)
- \`cc-cli hand --task <id> --to <agent-slug>\` — hand existing task to agent (THIS is when work begins)
- \`cc-cli tasks\` — list all tasks (\`--status pending\`, \`--assigned <id>\` to filter)

### Communication
- \`cc-cli say --agent <slug> --message "..."\` — instant private message (bypasses inbox, direct dispatch)
- \`cc-cli send --channel <name> --message "..."\` — send to a channel (goes through inbox for agents)

### Monitoring
- \`cc-cli status\` — all agent states (idle/busy/broken/offline)
- \`cc-cli agents\` — list all agents with status
- \`cc-cli activity\` / \`cc-cli feed\` — corp-wide dashboard (agents, tasks, events, problems)
- \`cc-cli clock\` — all registered clocks with fire counts, timing, errors
- \`cc-cli members\` / \`cc-cli who\` — all members (agents + founder)

### Hiring
- \`cc-cli hire --name "agent-name" --rank worker\` — hire corp-level agent
- \`cc-cli hire --name "agent-name" --rank worker --project <name>\` — hire into a project

### Agent Control
- \`cc-cli agent start --agent <slug>\` — start an offline agent
- \`cc-cli agent stop --agent <slug>\` — stop a running agent

### Contracts (inside projects — bundles of tasks with a goal)
- \`cc-cli contract create --project <name> --title "..." --goal "..." --lead @<slug>\` — create a contract
- \`cc-cli contract list [--project <name>] [--status active]\` — list contracts with progress %
- \`cc-cli contract show --id <id> --project <name>\` — full contract detail
- \`cc-cli contract activate --id <id> --project <name>\` — draft → active (work begins)

### Blueprints (playbooks — follow step by step)
- \`cc-cli blueprint list\` — show available workflow playbooks
- \`cc-cli blueprint show --name <name>\` — read a blueprint with cc-cli commands

### Planning
- \`cc-cli plan --goal "Build JWT authentication system"\` — deep planning mode. You research, think deeply, and produce a structured plan saved to plans/<id>.md. The Founder reviews and approves before you execute.
- Plans are markdown files in \`plans/\` at corp root. Read them with \`cat\`.

### Loops (interval-based recurring commands)
- \`cc-cli loop create --interval "5m" --command "cc-cli status"\` — run a command every 5 minutes
- \`cc-cli loop create --interval "5m" --agent ceo --command "Check health"\` — dispatch to agent every 5m
- \`cc-cli loop create --interval "1m" --agent ceo --command "Check deploy" --task bold-fox\` — **loop drives a task**: when the loop completes, the task auto-completes. When the task is completed, the loop auto-stops.
- \`cc-cli loop list\` — show active loops
- \`cc-cli loop complete --name <slug>\` — mark loop as done (linked task also completes)
- \`cc-cli loop dismiss --name <slug>\` — not needed anymore (task stays open)
- \`cc-cli loop delete --name <slug>\` — permanently remove

### Crons (scheduled jobs — calendar-based)
- \`cc-cli cron create --schedule "@daily" --agent herald --command "Write summary"\` — daily job
- \`cc-cli cron create --schedule "@weekly" --agent atlas --command "Bug audit" --spawn-task --task-title "Bug audit — {date}"\` — **each fire spawns a fresh task** with a dated title, assigned to the agent. Independent tasks.
- \`cc-cli cron create --schedule "0 9 * * 1" --command "Weekly report"\` — every Monday at 9am
- \`cc-cli cron list\` — show active crons
- \`cc-cli cron complete --name <slug>\` — mark cron as done
- \`cc-cli cron dismiss --name <slug>\` — not needed anymore

### Projects
- \`cc-cli projects create --name "..." --type workspace\` — create a project
- \`cc-cli projects list\` — list all projects

### Info
- \`cc-cli channels\` — list all channels
- \`cc-cli hierarchy\` — show org chart
- \`cc-cli inspect --agent <slug>\` — detailed agent info
- \`cc-cli messages --channel <name> --last 10\` — read channel messages
- \`cc-cli stats\` — corp statistics
- \`cc-cli uptime\` — daemon uptime
- \`cc-cli models\` — available models`,
};
