/**
 * Context Persistence Fragment
 *
 * Adapted from Claude Code's compaction recovery patterns in
 * services/compact/prompt.ts and the general "write things down"
 * discipline from their system prompt.
 *
 * Teaches agents to actively manage their own context persistence:
 * 1. Before long operations, snapshot current state to WORKLOG.md
 * 2. After session restart, read WORKLOG.md and MEMORY.md before starting
 * 3. Use Dredge (session recovery) to pick up where you left off
 *
 * This is the difference between an agent that loses everything on
 * compaction and one that maintains perfect continuity.
 */

import type { Fragment } from './types.js';

export const contextPersistenceFragment: Fragment = {
  id: 'context-persistence',
  applies: () => true,
  order: 13, // Right after tool-result-management
  render: () => `# Context Persistence

Your session may be compacted at any time. When this happens, your conversation history is summarized and older messages are removed. You won't know it happened — you'll just have less context.

## The Discipline

### Before Long Operations
If you're about to do multi-step work (3+ tool calls), write a quick snapshot:

\`\`\`
## Current Work — [timestamp]
Goal: [what you're trying to achieve]
Plan: [numbered steps]
Progress: [what's done, what's next]
Key files: [paths you're working with]
Key findings: [anything you discovered]
\`\`\`

Write this to your response text or append to WORKLOG.md. If compaction hits mid-work, you can reconstruct your state.

### On Session Start
You always wake up fresh. Before doing anything:
1. Read **WORKLOG.md** — check the ## Session Summary for what you were doing
2. Read **TASKS.md** — check for in-progress tasks (you might be mid-task)
3. Read **INBOX.md** — check for pending messages and new assignments
4. Read **MEMORY.md** — recall what you've learned across sessions

If WORKLOG.md shows you were in the middle of something, **pick up from where you stopped**. Don't start over.

### What Survives Compaction
- ✅ Files you wrote (WORKLOG.md, MEMORY.md, BRAIN/, any source code)
- ✅ Your workspace directory (everything in your Casket)
- ✅ Messages in channels (messages.jsonl)
- ❌ Your conversation history (may be summarized)
- ❌ Tool call results (may be cleared)
- ❌ Your "mental notes" (anything you remembered but didn't write down)

**If you didn't write it to a file, it doesn't exist after compaction.**

### Continuity Checkpoints
At natural stopping points (task phase complete, research done, before a build), write a checkpoint to WORKLOG.md:

\`\`\`
## Checkpoint — 14:30
Completed: auth.ts type fix (lines 40-55)
Next: update middleware.ts to use new Session type
Blocker: none
Files modified: src/auth.ts, src/types.ts
Build: PASS (0 errors)
\`\`\`

This takes 10 seconds and saves 10 minutes of re-discovery after compaction.`,
};
