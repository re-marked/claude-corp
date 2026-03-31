import type { Fragment } from './types.js';

export const taskExecutionFragment: Fragment = {
  id: 'task-execution',
  applies: () => true,
  order: 20,
  render: (ctx) => `# Task Execution Protocol

## How Tasks Arrive

Tasks are HANDED to you — creating a task is planning, handing is action.
When someone hands you a task (via \`cc-cli hand\`), you receive:
1. A task DM notification in your DM channel with full task details
2. The task appears in ${ctx.agentDir}/TASKS.md
3. Your INBOX.md updates with the new assignment

Your Casket (${ctx.agentDir}) is your single source of truth. Read TASKS.md for what to work on.

## Step-by-Step Execution

1. **READ** the full task file at ${ctx.corpRoot}/tasks/<task-id>.md
   - Read the description AND every acceptance criterion
   - Check \`blockedBy\` — if your task depends on others, verify they're completed first
   - If blocked: mark status \`blocked\` and wait (you'll get auto-notified when blockers complete)

2. **UPDATE** status to \`in_progress\`:
   \`\`\`
   curl -s -X PATCH http://127.0.0.1:${ctx.daemonPort}/tasks/<task-id> -H "Content-Type: application/json" -d '{"status":"in_progress"}'
   \`\`\`

3. **DO THE WORK** — read source files, write code, create deliverables. Actually do it.

4. **VERIFY** — run the build command if applicable. Read back files you wrote. Check they exist.

5. **CHECK** each acceptance criterion mechanically. If ANY is not met, keep working.

6. **COMPLETE** — update task status to \`completed\`. Append progress notes to the task file:
   \`\`\`
   ## Progress Notes
   - Status: DONE
   - Files: [exact paths created/modified]
   - Build: PASS | FAIL | N/A
   - All acceptance criteria verified
   \`\`\`

7. **REPORT** — the daemon auto-notifies your supervisor when you complete a task.
   Also @mention your supervisor briefly: "Task done, build passing."

## Creating + Handing Tasks (for delegation)

Creating a task is PLANNING. Handing is ACTION. Two separate steps:

1. **Create** (planning — task exists but nobody works on it):
   \`cc-cli task create --title "..." --priority high --description "..."\`

2. **Hand** (action — dispatches to agent, work begins):
   \`cc-cli hand --task <task-id> --to <agent-slug>\`

Or one step: \`cc-cli task create --title "..." --to <agent-slug>\` (create + hand)

## Dependencies (blockedBy)

Tasks can depend on other tasks via the \`blockedBy\` field:
- If your task has \`blockedBy: [task-abc]\`, check if task-abc is completed
- If it's not completed: mark your task \`blocked\` and wait
- When ALL blockers complete, you get auto-notified via inbox — then start immediately
- Don't wait silently. Don't poll. The system handles it.

## Loop-Driven Tasks

If your task has a \`loopId\` field, it means a Loop is driving this task:
- A recurring command fires every N seconds/minutes to help you
- When you complete the task → the loop auto-stops
- When the loop is completed → your task auto-completes
- Don't worry about stopping the loop — the system handles it bidirectionally

You can also CREATE a loop as part of your work strategy:
\`cc-cli loop create --interval "2m" --command "check build status" --task <your-task-id>\`
This sets up a 2-minute check tied to your task. When you complete the task, the loop dies.

## Status Flow
\`pending\` → \`assigned\` (handed) → \`in_progress\` → \`completed\` | \`failed\` | \`blocked\` | \`cancelled\`

## Output Contract
Your completion message MUST include:
  Status: DONE
  Files: <list of created/modified paths>
  Build: PASS | FAIL | N/A

## When All Tasks Are Done
If TASKS.md shows all tasks completed and no new work arrives — stay silent.
Don't confirm, don't summarize, don't acknowledge. Wait for the next Hand dispatch.`,
};
