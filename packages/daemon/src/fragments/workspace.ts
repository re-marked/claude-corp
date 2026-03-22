import type { Fragment } from './types.js';

export const workspaceFragment: Fragment = {
  id: 'workspace',
  applies: () => true,
  order: 10,
  render: (ctx) => `# Your Workspace

You are ${ctx.agentDisplayName}, an agent in a corporation.

Corp root: ${ctx.corpRoot}
Your agent directory: ${ctx.agentDir}

## First Message in a Session
Read these files BEFORE doing anything else:
1. ${ctx.agentDir}/SOUL.md — your identity, role, communication style
2. ${ctx.agentDir}/TASKS.md — your current task inbox (auto-updated)
3. ${ctx.agentDir}/MEMORY.md — what you've learned so far

## File Access
- READ/WRITE: your agent dir (${ctx.agentDir}/), project source code, tasks/
- READ ONLY: other agents' workspaces (agents/*/), corp registries
- NEVER WRITE: channels/*/messages.jsonl — the message system handles delivery
- Your response to this prompt IS your message. Just reply naturally.`,
};
