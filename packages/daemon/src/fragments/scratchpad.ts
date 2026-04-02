/**
 * Scratchpad Fragment
 *
 * Borrowed from Claude Code's `getScratchpadInstructions()` and the
 * `tengu_scratch` gate in coordinatorMode.ts.
 *
 * Provides a shared workspace per contract where agents on the same
 * contract can read/write freely. This replaces the ad-hoc "put it in
 * a channel message" pattern with structured cross-agent knowledge sharing.
 *
 * Each contract gets: projects/<name>/contracts/<id>/scratchpad/
 * Workers can organize files however fits the work — research findings,
 * intermediate specs, shared context, test results.
 */

import type { Fragment } from './types.js';

export const scratchpadFragment: Fragment = {
  id: 'scratchpad',
  applies: (ctx) => ctx.agentRank === 'master' || ctx.agentRank === 'leader',
  order: 16, // After workspace, before task execution
  render: (ctx) => `# Scratchpad — Cross-Agent Knowledge Sharing

When working on a Contract, agents sharing that contract have a **scratchpad directory**:

\`\`\`
projects/<project>/contracts/<contract-id>/scratchpad/
\`\`\`

This is a shared workspace where all agents on the contract can read and write freely. No permissions needed. No channel messages required.

## What Goes in the Scratchpad

| Content | Example File |
|---------|-------------|
| Research findings | \`scratchpad/auth-research.md\` |
| Implementation specs | \`scratchpad/spec-session-handler.md\` |
| Shared type definitions | \`scratchpad/types-draft.ts\` |
| Test results | \`scratchpad/test-results-phase1.md\` |
| Intermediate data | \`scratchpad/competitor-pricing.json\` |
| Decision records | \`scratchpad/decision-cache-strategy.md\` |

## Rules

- Structure files however fits the work — there is no required format
- Name files descriptively — other agents need to find them
- Write findings HERE, not in channel messages (channels are for communication, scratchpad is for artifacts)
- When delegating work, tell the worker: "Write your findings to scratchpad/<filename>"
- When synthesizing findings, READ the scratchpad first — don't ask workers to repeat themselves
- The scratchpad survives until the contract is archived

## For Coordinators

When you dispatch research workers, include in the prompt:
"Write your findings to \`scratchpad/<topic>.md\`. Do not put findings in a channel message."

When you synthesize:
1. Read all scratchpad files
2. Cross-reference findings
3. Write your implementation spec to scratchpad
4. Reference the spec when delegating implementation

The scratchpad is how workers share knowledge without noise. Use it.`,
};
