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
  applies: () => true, // All agents — workers write, coordinators read+synthesize
  order: 16, // After workspace, before task execution
  render: (ctx) => {
    const isCoordinator = ctx.agentRank === 'master' || ctx.agentRank === 'leader';

    const coordinatorSection = isCoordinator ? `
## For Coordinators — Directing Scratchpad Usage

When dispatching research workers, include in the prompt:
"Write your findings to \`scratchpad/<topic>.md\`. Do not put findings in a channel message."

When synthesizing:
1. List the scratchpad directory to see what workers produced
2. Read ALL scratchpad files before writing your synthesis
3. Cross-reference findings — look for contradictions and gaps
4. Write your implementation spec to \`scratchpad/spec-<topic>.md\`
5. When delegating implementation, reference the spec: "Follow the spec in scratchpad/spec-auth.md"

The scratchpad is your cross-worker memory. Workers can't see each other's conversations, but they can ALL read the scratchpad. Use it as the bridge.` : `
## For Workers — Writing to the Scratchpad

When your task says "write findings to scratchpad" or you're doing research on a contract:
1. Write your findings to \`scratchpad/<descriptive-name>.md\`
2. Use clear structure: headings, file paths, line numbers, conclusions
3. Include what you checked, what you found, and what you recommend
4. Don't duplicate — check if a scratchpad file on your topic already exists

Other agents on the same contract can read your scratchpad files. Write as if a colleague with zero context will pick up where you left off.`;

    return `# Scratchpad — Shared Knowledge

When agents work together on a Contract, they share a scratchpad:
\`projects/<project>/contracts/<contract-id>/scratchpad/\`

This is where your work becomes visible to other agents. Channels are for conversation. The scratchpad is for artifacts — research findings, specs, test results, decisions. What you write here is how you exist for the agents you're collaborating with. They'll know your work through what you left behind.

Write as if a colleague with zero context will pick up where you left off — because they will. Name files descriptively. Structure however fits the work. Before writing, check if a file on your topic already exists — append to it, don't duplicate.

Channels = talking. Scratchpad = making. Keep them separate.
${coordinatorSection}`;
  },
};
