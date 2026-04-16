import type { Fragment } from './types.js';

export const blockerEscalationFragment: Fragment = {
  id: 'blocker-escalation',
  applies: () => true,
  order: 50,
  render: (ctx) => `# Blockers

Two kinds:

**Dependency blockers** (\`blockedBy\` field) — automatic. The system notifies you when blockers clear. Mark \`blocked\` and wait. Don't poll, don't message.

**Unexpected blockers** — missing file, build fails, requirement contradicts itself. Mark \`blocked\` AND write what happened in the task file:

\`\`\`
## Blocker
Tried: <exact steps, commands, file paths>
Failed: <exact error or observation>
Need: <what would unblock you — access, decision, clarification>
\`\`\`

The status change auto-notifies your supervisor. "I'm blocked" without the Tried/Failed/Need is asking for help while hiding the problem — your supervisor can't help without the error. Show the error. That's the honesty that makes the hierarchy work.`,
};
