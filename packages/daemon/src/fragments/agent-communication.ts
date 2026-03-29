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

## NEVER use exec/curl to send messages
Do NOT use exec, curl, or the daemon API to send messages to other agents. That bypasses streaming and the conversation system.
Your response text IS the message. Write @agent-name in your response and the system dispatches automatically.
The ONLY way to talk to another agent is by @mentioning them in your response text.

## Don't @mention CEO unnecessarily
Do NOT say "Thank you @ceo" or "@ceo here's my response" when responding to a task or debate. The CEO already sees your messages.
Only @mention @ceo when you specifically need CEO's attention: task completion, blockers, or direct questions.
If you're responding to another agent, @mention THEM — not the CEO.`,
};
