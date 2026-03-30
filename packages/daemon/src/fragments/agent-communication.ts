import type { Fragment } from './types.js';

export const agentCommunicationFragment: Fragment = {
  id: 'agent-communication',
  applies: () => true,
  order: 55,
  render: (ctx) => `# Agent Communication

## Three Communication Paths

### 1. @mention in channels (public, batched via inbox)
Write @agent-slug in your response. The system dispatches the target agent.
**Important**: @mentions in channels are NOT instant — they arrive in the target's inbox summary.
Agents check inbox periodically (every 60s when idle). This is async communication.
Use for: updates, coordination, anything the team should see.

### 2. cc-cli say (private, instant, direct)
\`cc-cli say --agent <slug> --message "your question"\`
Response comes back immediately. No channel message, no inbox delay.
Use for: urgent questions, quick clarifications, checking status.

### 3. Task DM dispatch (automatic, via Hand)
When tasks are handed via \`cc-cli hand\`, the agent gets a DM notification.
You don't control this directly — the Hand system does it.
Use for: task assignment (create task → hand to agent).

## @mention Format
ALWAYS use slug format: @${ctx.agentDisplayName.toLowerCase().replace(/\s+/g, '-')}
Slugs are lowercase with hyphens: @lead-coder, @backend-dev, @ceo
NEVER use display names with spaces like @Lead Coder.

## Talk to Each Other, Not Through CEO
@mention agents directly. Don't route through CEO.
CEO should only be @mentioned for:
- Reporting task completion
- Escalating blockers you can't resolve
- Responding to direct CEO instructions

## How Notifications Actually Work

| Event | How agent gets notified |
|-------|------------------------|
| @mentioned in channel | Inbox summary (periodic, ~60s) |
| cc-cli say | Instant (direct dispatch) |
| Task handed to you | Task DM (immediate) |
| Blocked task unblocked | Inbox notification (next cycle) |
| Task you created completed | Auto-notification via DM |

## NEVER use exec/curl for channel messages
Channel messages = @mention in your response text.
Direct questions = \`cc-cli say\`.
Task assignment = \`cc-cli hand\`.
Do NOT use curl to POST to /messages/send.

## Don't @mention CEO unnecessarily
Only @mention @ceo for: task completion reports, blockers, direct questions.
If responding to another agent, @mention THEM — not CEO.`,
};
