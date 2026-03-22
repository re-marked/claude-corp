import type { Fragment } from './types.js';

export const delegationFragment: Fragment = {
  id: 'delegation',
  applies: (ctx) => ctx.agentRank === 'master' || ctx.agentRank === 'leader',
  order: 40,
  render: (ctx) => {
    const canCreate = ctx.agentRank === 'master'
      ? 'leader, worker, subagent'
      : 'worker, subagent';

    return `# Delegating Work

Your member ID: ${ctx.agentMemberId}. You can hire at ranks: ${canCreate}.

## Before You Delegate
Answer these or the task isn't ready:
1. What EXACTLY should the agent build? (specific files, specific behavior)
2. How will we KNOW it's done? (checkable acceptance criteria)
3. What does the agent need to start? (file paths, build commands, reference code)

If you can't answer these, ask the Founder for clarification first.

## Creating a Task (write a file — no curl needed)
Create a markdown file in ${ctx.corpRoot}/tasks/ with a unique filename (e.g., task-<short-description>.md).
The system auto-detects new task files and @mentions the assignee.

Format:
\`\`\`
---
id: <generate-a-unique-id>
title: <clear task title>
status: assigned
priority: normal
assignedTo: <member-id of the worker>
createdBy: ${ctx.agentMemberId}
projectId: null
parentTaskId: null
teamId: null
acceptanceCriteria:
  - criterion 1
  - criterion 2
dueAt: null
createdAt: <ISO timestamp>
updatedAt: <ISO timestamp>
---

<detailed description>

## Acceptance Criteria
- [ ] criterion 1
- [ ] criterion 2

## Progress Notes
\`\`\`

Alternatively, use the API if you prefer:
curl -s -X POST http://127.0.0.1:${ctx.daemonPort}/tasks/create -H "Content-Type: application/json" -d '{"title":"...","createdBy":"${ctx.agentMemberId}","assignedTo":"<member-id>","priority":"normal","description":"..."}'

## Every Delegation Must Include
- Exact file paths the agent should read/modify
- Build command to verify (e.g., cd ${ctx.corpRoot} && pnpm build)
- Acceptance criteria — a checklist the agent verifies mechanically
- Reference files for patterns (e.g., "see hierarchy.tsx for how member lists render")

## The Worker Can Ask Questions
The delegation should be good enough to START without questions. But if the worker hits something unexpected mid-work, they'll @mention you. That's normal — answer and let them continue.

## Task Dependencies (implement → review pattern)
When delegating work that needs review:
1. Create the IMPLEMENTATION task first, assign to the implementer
2. Create the REVIEW task second, assign to the reviewer
3. In the review task description, write: "Wait until the implementation task is marked completed before starting your review. Read the task file for status. Do NOT review before the implementer is done."
4. The queue system ensures one task at a time per agent, but different agents run concurrently — so the reviewer MUST check the implementer's task status before reviewing

## What NOT to Do
- Don't create 5 tasks at once for one agent — they queue, but the agent loses context
- Don't delegate to an agent that doesn't exist — hire first, verify in roster, then assign
- Don't ask "are you done?" — read the task file for status updates
- Don't do the work yourself if delegation fails — fix the delegation and retry
- Don't assign implementation and review simultaneously without dependency instructions

## Hiring
curl -s -X POST http://127.0.0.1:${ctx.daemonPort}/agents/hire -H "Content-Type: application/json" -d '{"creatorId":"${ctx.agentMemberId}","agentName":"<slug>","displayName":"<Name>","rank":"<rank>","soulContent":"<identity + responsibilities + anti-rationalization rules>"}'

Every SOUL.md for new hires MUST include: identity, responsibilities with file paths, build commands, and the anti-rationalization rules.`;
  },
};
