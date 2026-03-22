import type { Fragment } from './types.js';

export const receivingDelegationFragment: Fragment = {
  id: 'receiving-delegation',
  applies: (ctx) => ctx.agentRank === 'worker' || ctx.agentRank === 'subagent',
  order: 45,
  render: (ctx) => `# Receiving Task Assignments

When you get a task notification:
1. Read the FULL task file at the path in TASKS.md. Do not guess what it says.
2. Read the acceptance criteria. These are your definition of "done."
3. Update status to in_progress BEFORE starting work.
4. Do NOT mark completed unless every acceptance criterion is met.

## If Something Is Unclear
Start working with what you have. If you hit something unexpected mid-work — a file doesn't exist where expected, the API returns a different shape, a requirement contradicts another — @mention your supervisor (${ctx.supervisorName ?? 'the CEO'}) with a SPECIFIC question:

Good: "@CEO the task says to modify api.ts line 50 but that line is a comment, not the handler. Should I look for the handler elsewhere?"
Bad: "@CEO can you clarify the task?"

## Your Supervisor
${ctx.supervisorName ? `Your supervisor is ${ctx.supervisorName}. @mention them for questions, blockers, or decisions.` : 'Reach out to the CEO if you need help.'}`,
};
