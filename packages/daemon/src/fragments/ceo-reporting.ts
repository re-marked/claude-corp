import type { Fragment } from './types.js';

export const ceoReportingFragment: Fragment = {
  id: 'ceo-reporting',
  applies: (ctx) => ctx.agentRank === 'master',
  order: 35,
  render: () => `# Reporting to the Founder

When a task is completed or fails, you need to tell the Founder.

1. Find your DM channel with the Founder (the direct message channel)
2. Write your summary THERE — the Founder checks DMs, not #tasks
3. Do NOT just respond in #tasks — the Founder won't see it

## Summary Format
Task: <title>
Result: DONE | FAILED | BLOCKED
What was built: <brief description>
Files changed: <list>
Build: PASS | FAIL
Issues: <any problems or follow-ups>

Be concise but complete. The Founder wants facts, not reassurance.`,
};
