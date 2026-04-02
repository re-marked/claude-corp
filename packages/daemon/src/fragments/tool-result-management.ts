/**
 * Tool Result Management Fragment
 *
 * Borrowed from Claude Code's `getFunctionResultClearingSection()` and
 * `SUMMARIZE_TOOL_RESULTS_SECTION` in constants/prompts.ts.
 *
 * Teaches agents two critical behaviors:
 * 1. Prior tool results may be cleared from context — note down important info
 * 2. When a tool returns a massive result, summarize key findings before moving on
 *
 * Without this, agents lose file paths, line numbers, and decisions
 * when OpenClaw compacts the session. With this, they learn to persist
 * what matters into their response text or WORKLOG.md.
 */

import type { Fragment } from './types.js';

export const toolResultManagementFragment: Fragment = {
  id: 'tool-result-management',
  applies: () => true,
  order: 12, // Early — before task execution, after workspace
  render: () => `# Tool Result Management

## Results Are Ephemeral

Prior tool results in your conversation may be cleared to save context space. This is normal — OpenClaw does this to keep your session alive longer.

**The problem:** You read a file, found line 42 has a bug, then 10 tool calls later the file content is gone from your context. Now you can't reference line 42 because you never wrote it down.

**The fix:** After any tool call that reveals important information, write it down in your response text IMMEDIATELY:
- File paths you'll need later
- Line numbers and function names
- Error messages and their causes
- Decisions you made based on what you saw
- Build output summaries

Don't rely on "I can scroll back" — you can't. The raw result may be gone.

## Summarize Large Results

When a tool returns hundreds of lines (directory listings, build output, large files), do NOT copy it all. Extract what matters:

\`\`\`
BAD:  (dumps entire 200-line build output into response)
GOOD: "Build failed. 3 errors:
       1. src/auth.ts:42 — Type 'string' not assignable to 'Session'
       2. src/auth.ts:58 — Property 'userId' missing
       3. src/types.ts:15 — Duplicate identifier 'Session'
       Root cause: type definition changed but consumers weren't updated."
\`\`\`

The raw output is in the tool call details — your response carries the analysis.

## Write Critical Context to WORKLOG.md

If you're about to do a long operation (multiple file edits, multi-step build), first write a brief note to your WORKLOG.md:

\`\`\`
## Working On: Auth module refactor
- Files to modify: src/auth.ts, src/types.ts, src/middleware.ts
- Approach: Update Session type first, then fix consumers
- Key finding: Line 42 in auth.ts has the wrong type assertion
\`\`\`

If your session gets compacted mid-work, your WORKLOG.md survives. You can pick up exactly where you left off.`,
};
