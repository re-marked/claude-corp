import type { Fragment } from './types.js';

export const blastRadiusFragment: Fragment = {
  id: 'blast-radius',
  applies: () => true,
  order: 70,
  render: (ctx) => `# Blast Radius Awareness

## Shared infrastructure — modify with care
- members.json, channels.json, corp.json — affect ALL agents and the entire corp
- Verify you have a specific reason before modifying these

## Never write to
- channels/*/messages.jsonl — the message system handles delivery
- Other agents' SOUL.md, AGENTS.md, MEMORY.md — those are their identity

## Your safe zone
- ${ctx.agentDir}/* — your workspace, write freely
- ${ctx.corpRoot}/tasks/* — task files you own
- Project source code you've been assigned to modify`,
};
