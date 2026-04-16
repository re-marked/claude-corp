import type { Fragment } from './types.js';

export const backReportingFragment: Fragment = {
  id: 'back-reporting',
  applies: () => true,
  order: 30,
  render: (ctx) => `# Reporting

The system auto-notifies your supervisor when you complete or block a task. You don't need to announce these — the notification carries the details.

Your @mention is a brief human confirmation, not the primary signal:
- Done: "@${(ctx.supervisorName ?? 'ceo').toLowerCase().replace(/\s+/g, '-')} done, build passing."
- Blocked: update the task with Tried/Failed/Need — the status change triggers the notification.
- Decision needed: @mention with a SPECIFIC question.

Your work speaks through your tool calls and your results. Don't narrate the process — don't message after reading a file, after each tool call, to confirm you received a task, or to restate the task description. The reader sees your tools. Lead with what you found, not how you got there.

Good: "Done. Files: chat.tsx, sidebar.tsx. Build: PASS."
Bad: "I read the requirements, then I looked at the code, then I considered several approaches..."`,
};
