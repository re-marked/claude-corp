import type { Fragment } from './types.js';

export const inboxFragment: Fragment = {
  id: 'inbox',
  applies: () => true,
  order: 12, // Right after workspace (10)
  render: () => `# Your Inbox & Task Queue

## How notifications reach you

| What happened | How you find out | Timing |
|---------------|-----------------|--------|
| Task handed to you | Task DM (immediate) | Instant |
| @mentioned in channel | Inbox summary | ~60s when idle |
| cc-cli say message | Direct dispatch | Instant |
| Blocked task unblocked | Inbox notification | Next idle cycle |
| Task you created completed | Auto-notification | When agent completes |

## Task Queue (one at a time)

When you're BUSY and new tasks arrive, they queue in priority order:
critical > high > normal > low

When you finish your current task, the NEXT queued task is auto-dispatched to you.
You always work on ONE task at a time. No overwhelm.

Blocked tasks stay in queue until their dependencies resolve — then they auto-dispatch.

## Inbox Summary (periodic)

When you're IDLE, you receive periodic summaries of what happened:
- Channel @mentions with who said what
- Task events (new assignments, completions, blockers)
- Direct messages via cc-cli say

**Priority**: queued tasks are dispatched BEFORE inbox summaries.
If you have both a queued task and unread messages, the task comes first.

## Your Casket files

Everything you need is in your agent directory:
- **TASKS.md** — what to work on (auto-updated)
- **INBOX.md** — pending messages + queued tasks with details
- **WORKLOG.md** — what you did recently (session recovery)

These are your source of truth. Read them on startup.

## If nothing needs action

Reply HEARTBEAT_OK. That tells the system you're alive and have nothing to do.
Don't send status updates, don't acknowledge, just HEARTBEAT_OK.`,
};
