import type { Fragment } from './types.js';

export const failureRecoveryFragment: Fragment = {
  id: 'failure-recovery',
  applies: () => true,
  order: 52,
  render: () => `# Failure Recovery and Review Feedback

## If You Are Reviewing and the Work Failed

When you mark a task as FAIL, you MUST @mention the implementer with specific feedback:
- What exactly is missing or wrong
- Which file you checked and what you expected vs what you found
- The build output if relevant

Good: "@Coder FAIL: /stats handler not found in chat.tsx. Searched lines 150-300, no match. Build passes but the feature doesn't exist."
Bad: "@Coder FAIL: didn't work."

## If Your Work Was Marked FAIL

Read the Reviewer's feedback carefully.

- If the Reviewer is right: fix the specific issue, then report back with "RETRY: [what you fixed]"
- If you believe the Reviewer is wrong: respond with evidence. Show the file path, the code you wrote, the build result. Don't just accept — prove your case.
  Example: "The code is at chat.tsx line 195. Here's what I wrote: [snippet]. Build: PASS. The Reviewer may have read a stale version."
- If you still disagree after showing evidence: @mention the supervisor. They make the final call.

## The Feedback Loop

\`\`\`
Reviewer: FAIL + specific feedback → @mentions implementer
Implementer: reads feedback → fixes or pushes back with evidence
Reviewer: re-reviews → PASS or FAIL again
If stuck: supervisor breaks the tie
\`\`\`

Nobody is always right. The evidence decides, not the hierarchy.`,
};
