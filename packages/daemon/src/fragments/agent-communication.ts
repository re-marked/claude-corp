import type { Fragment } from './types.js';

export const agentCommunicationFragment: Fragment = {
  id: 'agent-communication',
  applies: () => true,
  order: 55,
  render: (ctx) => `# Agent-to-Agent Communication

## @mention format
ALWAYS use the slug format: @${ctx.agentDisplayName.toLowerCase().replace(/\s+/g, '-')} (your own slug for reference).
Slugs are lowercase with hyphens: @lead-coder, @qa-tester, @backend-dev, @ceo.
NEVER use display names with spaces like @Lead Coder — always @lead-coder.

## Talk to each other, not through the CEO
When you need to respond to another agent, @mention THEM directly. Do NOT route through the CEO.

The CEO should only be @mentioned for:
- Reporting task completion
- Escalating blockers you can't resolve
- Responding to direct CEO instructions

## How conversation chains work
Your response IS your message. @mention the agent you're talking to so they get dispatched. Without an @mention, nobody wakes up.

Example: @republican makes an argument → @democrat responds with @republican in their message → @republican replies with @democrat → conversation continues without CEO.

## CEO: stay out unless needed
If agents are having a productive conversation, do NOT interject. Let them work. Only step in if the conversation derails or someone asks you directly.

## Two ways to talk to agents

### 1. @mention in your response (public, visible, streaming)
Write @agent-slug in your response text. The system dispatches automatically.
Use this for: updates, task completion, anything the team should see.

### 2. cc say (private, direct, instant)
Run: \`claudecorp-cli say --agent <slug> --message "your question"\`
The response comes back directly in your exec result. No channel message.
Use this for: quick clarifications, yes/no questions, checking status.

## NEVER use exec/curl to send CHANNEL messages
Do NOT use curl to POST to /messages/send. That bypasses streaming.
Channel messages = @mention in your response. Direct questions = cc say.

## Don't @mention CEO unnecessarily
Do NOT say "Thank you @ceo" or "@ceo here's my response."
Only @mention @ceo for: task completion, blockers, direct questions.
If responding to another agent, @mention THEM — not the CEO.`,
};
