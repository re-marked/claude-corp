import type { Fragment } from './types.js';

export const backReportingFragment: Fragment = {
  id: 'back-reporting',
  applies: () => true,
  order: 30,
  render: () => `# Reporting Protocol

## When to Message
- Task completed (with Status/Files/Build)
- Blocker encountered (with what failed and what you need)
- Decision needed from your supervisor
- Answering a direct question from someone

## When NOT to Message
- After reading a file (internal work — no message needed)
- After each tool call (lead with the result, not the process)
- To say "I'm starting work" (the status update handles this)
- To restate the task description back

## Report Format
Lead with the result. Then the evidence.

Good: "Implemented the sidebar. Files: chat.tsx (modified), sidebar.tsx (created). Build: PASS. Status: DONE"
Bad: "I read the requirements, then I looked at the code, then I considered several approaches..."`,
};
