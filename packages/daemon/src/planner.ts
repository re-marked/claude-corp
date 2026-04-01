/**
 * Planner — dedicated Opus 4.6 agent for deep planning.
 *
 * Auto-hired on bootstrap like Failsafe, Warden, Herald.
 * Only activated for /plan (deep plans). /sketch uses whatever
 * agent you're talking to.
 *
 * Uses the most powerful model available for thorough analysis.
 */

import type { Daemon } from './daemon.js';
import { hireAgent } from './hire.js';
import { log } from './logger.js';

const PLANNER_RULES = `# Rules — Planner Agent

You are the corp's deep thinker. Your ONLY job is producing thorough, well-researched plans.

## When you are activated:
You receive a goal and a codebase. Your job is to:
1. Audit the ENTIRE codebase structure — not just a few files
2. Understand existing patterns, conventions, dependencies
3. Research how real-world production apps solve the same problem
4. Design a comprehensive implementation plan with phases, tasks, risks
5. Self-review the plan before presenting it

## What makes a good plan:
- Every decision has explicit reasoning (WHY, not just WHAT)
- Alternatives are considered and tradeoffs explained
- File paths are real — you verified they exist
- Tasks are specific enough for an agent with zero context
- Risks have mitigations, not just descriptions
- Scale is considered: what happens at 10x?

## What you do NOT do:
- Do NOT implement anything — plan only
- Do NOT write thin, rushed plans — you have 20 minutes
- Do NOT guess about the codebase — read actual files
- Do NOT skip the self-review phase

## Reply format:
A structured plan in markdown with: Goal, Context, Approach, Phases with tasks, Risks, Acceptance Criteria, Scope estimate.
`;

const PLANNER_HEARTBEAT = `# Heartbeat — Planner Agent

You are idle until a /plan command activates you. When idle, respond HEARTBEAT_OK.
When activated, follow your RULES.md protocol for deep planning.
`;

/**
 * Hire the Planner agent into a corp.
 * Uses Opus 4.6 for maximum reasoning depth.
 */
export async function hirePlanner(daemon: Daemon): Promise<void> {
  const members = (await import('@claudecorp/shared')).readConfig(
    (await import('node:path')).join(daemon.corpRoot, 'members.json'),
  ) as any[];

  if (members.some((m: any) => m.displayName === 'Planner')) {
    log('[planner] Planner agent already exists');
    return;
  }

  const ceo = members.find((m: any) => m.rank === 'master');
  if (!ceo) {
    log('[planner] No CEO found — cannot hire Planner');
    return;
  }

  await hireAgent(daemon, {
    creatorId: ceo.id,
    agentName: 'planner',
    displayName: 'Planner',
    rank: 'leader',
    agentsContent: PLANNER_RULES,
    heartbeatContent: PLANNER_HEARTBEAT,
    model: 'claude-opus-4-6',
  });

  log('[planner] Planner agent hired (Opus 4.6)');
}
