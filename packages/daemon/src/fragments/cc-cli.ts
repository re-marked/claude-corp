import type { Fragment } from './types.js';

export const ccCliFragment: Fragment = {
  id: 'cc-cli',
  applies: () => true,
  order: 15, // After workspace (10), before behavioral fragments
  render: () => `## cc-cli Commands
The corp CLI. Use these for ALL corp operations — do NOT use curl or raw API calls.

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
- \`cc-cli models\` — list available models`,
};
