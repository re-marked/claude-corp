import type { Fragment } from './types.js';

export const blockerEscalationFragment: Fragment = {
  id: 'blocker-escalation',
  applies: () => true,
  order: 50,
  render: (ctx) => `# Escalating Blockers

If you cannot complete a task, update its status to blocked and report:

BLOCKED: <task title>
Tried: <what you attempted, with commands and file paths>
Failed: <exact error message or unexpected result>
Need: <what you need to continue — access, decision, clarification>

@mention ${ctx.supervisorName ?? 'the CEO'} with this format.

Do NOT say "I'm blocked" without the details. Your supervisor cannot help without the error.`,
};
