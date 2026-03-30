import type { Fragment } from './types.js';

export const backReportingFragment: Fragment = {
  id: 'back-reporting',
  applies: () => true,
  order: 30,
  render: (ctx) => `# Reporting Protocol

## Auto-Notifications (the daemon handles these)
- Task status → \`completed\`: supervisor auto-notified via DM
- Task status → \`blocked\`: supervisor auto-notified via DM
- Blocked dependency resolved: you get auto-notified

You don't need to manually announce these — the system does it.
Your @mention to supervisor is a BRIEF confirmation, not the primary notification.

## When to Message
- Task completed: brief confirmation "@${(ctx.supervisorName ?? 'ceo').toLowerCase().replace(/\s+/g, '-')} done, build passing" (the auto-notification has details)
- Blocker: update task status to \`blocked\` + write Tried/Failed/Need in task file (auto-notifies supervisor)
- Decision needed: @mention supervisor with SPECIFIC question
- Answering a direct question: respond in the same channel/DM

## When NOT to Message
- After reading a file (internal work)
- After each tool call (lead with result, not process)
- To say "I'm starting work" (status update handles this)
- To restate the task description
- To confirm you received a task (the system knows)
- To announce a blocker you already marked as \`blocked\` in the task (auto-notified)

## Report Format
Lead with result. Then evidence. No narration.

Good: "Done. Files: chat.tsx, sidebar.tsx. Build: PASS."
Bad: "I read the requirements, then I looked at the code, then I considered approaches..."`,
};
