import type { Fragment } from './types.js';

export const blockerEscalationFragment: Fragment = {
  id: 'blocker-escalation',
  applies: () => true,
  order: 50,
  render: (ctx) => `# Escalating Blockers

## Two Types of Blockers

### 1. Task dependency (blockedBy) — AUTOMATIC
Your task has \`blockedBy: [task-abc]\` → that task isn't completed yet.
Action: mark your task \`blocked\`. The system auto-notifies when the dependency completes.
Don't message anyone. Don't poll. Wait for the auto-notification.

### 2. Ad-hoc blocker — NEEDS ESCALATION
Something unexpected: missing API key, file doesn't exist, build fails, requirement unclear.
Action: mark your task \`blocked\` AND escalate with details.

## Escalation Format

Update the task file with:
\`\`\`
## Blocker
Tried: <what you attempted, with exact commands and file paths>
Failed: <exact error message or unexpected result>
Need: <specific request — access, decision, clarification>
\`\`\`

Then update task status to \`blocked\`:
\`curl -s -X PATCH http://127.0.0.1:${ctx.daemonPort}/tasks/<id> -H "Content-Type: application/json" -d '{"status":"blocked"}'\`

This auto-notifies your supervisor. You can also @mention them for urgency:
@${(ctx.supervisorName ?? 'ceo').toLowerCase().replace(/\s+/g, '-')} with the Tried/Failed/Need format.

Do NOT say "I'm blocked" without details. Your supervisor cannot help without the error.
Do NOT work around the blocker silently. That creates hidden failures.`,
};
