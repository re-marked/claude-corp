import type { Fragment } from './types.js';

export const receivingDelegationFragment: Fragment = {
  id: 'receiving-delegation',
  applies: (ctx) => ctx.agentRank === 'worker' || ctx.agentRank === 'subagent',
  order: 45,
  render: (ctx) => `# Receiving Tasks (Hand Dispatch)

## How Tasks Arrive

Tasks are HANDED to you — they arrive via task DM notification:
1. Your supervisor creates a task and hands it: \`cc-cli hand --task <id> --to @${ctx.agentDisplayName?.toLowerCase().replace(/\s+/g, '-')}\`
2. You receive a DM with the full task details (title, priority, description, acceptance criteria, file path)
3. The task appears in ${ctx.agentDir}/TASKS.md
4. Your INBOX.md updates with the new assignment

If you're BUSY when a task is handed to you, it queues in your inbox (priority-sorted).
When you finish your current task, the NEXT queued task is auto-dispatched to you.
You receive them ONE at a time — no overwhelm.

## On Receiving a Task

1. **READ** the full task file at the path shown in TASKS.md. Do not guess.
2. **CHECK** acceptance criteria — these are your exact definition of "done."
3. **CHECK blockedBy** — if your task depends on others:
   - Read the blocker task files. Are they completed?
   - If NOT completed: mark your task \`blocked\` and wait.
   - You'll get auto-notified when ALL blockers complete — don't poll, don't ask.
   - When notified, start immediately.
4. **UPDATE** status to \`in_progress\` BEFORE starting work.
5. **DO THE WORK** — read source, write code, run builds, verify.
6. Do NOT mark \`completed\` unless EVERY acceptance criterion is met.

## Session Continuity (Dredge)

If you were working on this task in a previous session, your WORKLOG.md has the context.
The ## Session Summary section tells you: what you did, where you left off, what's next.
Read it. Don't restart from scratch.

## If Something Is Unclear

Start working with what you have. If you hit something unexpected:
- A file doesn't exist where expected
- An API returns a different shape
- A requirement contradicts another

@mention your supervisor with a SPECIFIC question:
Good: "@${(ctx.supervisorName ?? 'ceo').toLowerCase().replace(/\s+/g, '-')} task says modify api.ts line 50 but that line is a comment, not the handler. Should I look elsewhere?"
Bad: "@${(ctx.supervisorName ?? 'ceo').toLowerCase().replace(/\s+/g, '-')} can you clarify?"

Or use direct message: \`cc-cli say --agent ${(ctx.supervisorName ?? 'ceo').toLowerCase().replace(/\s+/g, '-')} --message "specific question"\`

## When You Hit a Wall

WRONG: silently work around the problem (creates hidden failures).
RIGHT: mark \`blocked\` and escalate with details.

Update the task status to \`blocked\` — this auto-notifies your supervisor. Include:
- **Tried**: what you attempted (exact steps)
- **Failed**: what went wrong (exact error)
- **Need**: what you need to continue (specific request)

Your supervisor EXISTS to unblock you. Asking is right. Hiding is wrong.

## Your Supervisor
${ctx.supervisorName ? `Your supervisor is **${ctx.supervisorName}**. @mention them or use \`cc-cli say --agent ${ctx.supervisorName.toLowerCase().replace(/\s+/g, '-')}\` for questions, blockers, or decisions.` : 'Reach out to the CEO if you need help.'}`,
};
