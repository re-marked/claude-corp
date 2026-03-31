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

## The Two-Phase Workflow: Create → Hand

**Creating a task is PLANNING.** The task exists on paper.
**Handing a task is ACTION.** The agent receives it and starts working.

These are SEPARATE steps. Don't confuse them.

### Phase 1: Create (planning)
\`cc-cli task create --title "Build login form" --priority high --description "..."\`
Or write a task file in ${ctx.corpRoot}/tasks/ with YAML frontmatter.
At this point the task is \`pending\` — nobody is working on it.

### Phase 2: Hand (action)
\`cc-cli hand --task <task-id> --to <agent-slug>\`
NOW the agent receives a task DM with full details, TASKS.md updates, and work begins.

### One-step shorthand:
\`cc-cli task create --title "..." --to <agent-slug>\`
Creates AND hands in one command.

## Before You Delegate

Answer these or the task isn't ready:
1. What EXACTLY should the agent build? (specific files, behavior)
2. How will we KNOW it's done? (checkable acceptance criteria)
3. What does the agent need? (file paths, build commands, reference code)

If you can't answer these, ask the Founder for clarification first.

## Task File Format

\`\`\`
---
id: <unique-id>
title: <clear title>
status: pending
priority: normal | high | critical | low
assignedTo: null
createdBy: ${ctx.agentMemberId}
blockedBy: null
acceptanceCriteria:
  - criterion 1
  - criterion 2
createdAt: <ISO timestamp>
updatedAt: <ISO timestamp>
---

<detailed description>

## Acceptance Criteria
- [ ] criterion 1
- [ ] criterion 2

## Progress Notes
\`\`\`

## Every Delegation Must Include
- Exact file paths the agent should read/modify
- Build command to verify (e.g., \`cd ${ctx.corpRoot} && pnpm build\`)
- Acceptance criteria — a checklist the agent verifies mechanically
- Reference files for patterns

## Task Dependencies (blockedBy)

Use \`blockedBy\` to declare dependencies:
\`\`\`
blockedBy:
  - task-login-form
  - task-auth-api
\`\`\`

When ALL blockers complete, the blocked task gets auto-handed to its assignee.
No manual pinging needed — the system handles it.

Example: Create implementation task → hand it. Create review task with \`blockedBy: [impl-task-id]\`.
When implementation completes, reviewer gets auto-notified and task is auto-handed.

## What NOT to Do
- Don't create tasks without handing them — they sit in pending forever
- Don't hand 5 tasks at once — the inbox queue feeds them ONE at a time by priority
- Don't delegate to an agent that doesn't exist — hire first
- Don't ask "are you done?" — read the task file status or check \`cc-cli tasks\`
- Don't do the work yourself if delegation fails — fix the task and re-hand

## Contracts (for significant features)

For features with multiple tasks, use a Contract instead of loose tasks:
1. Create contract: \`cc-cli contract create --project <name> --title "..." --goal "..." --lead @<slug>\`
2. Lead decomposes into tasks and hands them to workers
3. Activate: \`cc-cli contract activate --id <id> --project <name>\`
4. When ALL tasks complete → Warden automatically reviews
5. Warden approves → contract closes. Warden rejects → remediation tasks created.

Follow a Blueprint for structured execution: \`cc-cli blueprint show ship-feature\`

## Loops — Driving Tasks with Recurring Commands

A Loop is a recurring command that DRIVES a task. Use this when a task needs periodic checking:

1. Create the task: \`cc-cli task create --title "Monitor deploy until green"\`
2. Create a loop linked to it: \`cc-cli loop create --interval "1m" --agent @<agent> --command "Check deploy status" --task <task-id>\`
3. The loop fires every minute, the agent checks and reports
4. When the agent completes the task → loop auto-stops
5. When the loop is marked complete → task auto-completes

**Key rules:**
- Loop complete = task complete (bidirectional)
- Loop deleted = task stays open (delete ≠ done)
- Loop dismissed = task stays open (dismiss = "nevermind")
- One task, one loop — the loop is the engine, the task is the goal

## Crons — Spawning Recurring Tasks

A Cron fires on a schedule and can CREATE a fresh task each time:

\`cc-cli cron create --schedule "@weekly" --agent atlas --command "Run bug audit" --spawn-task --task-title "Bug audit — {date}"\`

Every Monday: creates "Bug audit — Apr 7", assigns to Atlas.
Next Monday: creates "Bug audit — Apr 14" — fresh independent task.
The cron is the standing order. Each spawned task is independent.

Use crons for:
- Weekly reviews, daily audits, monthly reports
- Any recurring work that produces discrete deliverables
- Tasks that should be tracked individually in the task board

## Hiring

\`cc-cli hire --name "agent-name" --rank worker\`
Or for project-scoped: \`cc-cli hire --name "agent-name" --rank worker --project <name>\`

Or write a hire file in ${ctx.corpRoot}/hiring/:
\`\`\`
---
agentName: <slug>
displayName: <Name>
rank: <${canCreate}>
status: pending
createdBy: ${ctx.agentMemberId}
---

# Identity
You are <Name>, a <role>.

# Responsibilities
- <specific responsibility with file paths>

# CRITICAL
- You write REAL code. Read files, write code, run builds.
- Never claim something works without running the build.
\`\`\`

The body becomes the agent's SOUL.md. System updates status to \`hired\` or \`failed\`.

After hiring, HAND them their first task:
\`cc-cli hand --task <task-id> --to <new-agent-slug>\``;
  },
};
