/**
 * `agentstuck` sweeper — detect live-but-not-progressing agents.
 *
 * Complements silentexit. silentexit finds slots whose process
 * died (crashed/stopped) with pending Casket work; agentstuck
 * finds slots whose process is fine but whose current task hasn't
 * been touched in a long time. Different failure modes, different
 * detectors.
 *
 * Detection:
 *   For each agent Member (type='agent', not archived):
 *     - Load Casket.currentStep. If null → skip (no assigned work).
 *     - Load the referenced task chit. If missing or wrong type →
 *       skip (malformed pointer; chit-hygiene's territory).
 *     - If task.fields.task.workflowStatus === 'blocked' → skip
 *       (waiting on dep, not stuck in the agent-attention sense).
 *     - If task.updatedAt > now - STUCK_THRESHOLD_MS → skip (agent
 *       actively touched the task recently; working on it).
 *     - Else → emit a finding at severity='warn'.
 *
 * Why task.updatedAt and not Casket.updatedAt:
 *   Casket.updatedAt only bumps when the currentStep pointer
 *   CHANGES (one task closed, next begins). An agent mid-task who
 *   writes to the task chit (acceptance criteria edits, output
 *   field updates) bumps task.updatedAt but not Casket.updatedAt.
 *   The task timestamp is the true "when did work last happen"
 *   signal.
 *
 * What this does NOT do:
 *   - No auto-action. Stuck agents aren't dead — they might be
 *     waiting on API rate limits, deep in a reasoning loop, or
 *     genuinely working but slow. Sexton reads the finding and
 *     decides: nudge via `cc-cli say --agent <slug>`, escalate to
 *     founder, or wait another tick.
 *   - No retry counter. The runner's auto-resolve handles the
 *     "previously flagged, now unstuck" case by closing prior
 *     kinks whose subject no longer appears in findings. The kink
 *     itself carries occurrenceCount via dedup, so Sexton sees
 *     "this slot has been stuck across 4 patrols" at a glance.
 *   - No claude-code-specific heuristics. Works on any harness
 *     since it reads chit timestamps, not process state.
 */

import { readConfig, type Member, MEMBERS_JSON, getCurrentStep, findChitById } from '@claudecorp/shared';
import { join } from 'node:path';
import { log } from '../../logger.js';
import type { SweeperContext, SweeperResult, SweeperFinding } from './types.js';

/**
 * How long a task chit's updatedAt can be stale before the agent
 * is considered stuck. 30 minutes is the low bar — most real stuck
 * shows up long before this, so false-positives are rare. The cost
 * of a false positive is "Sexton nudges a working agent," which is
 * mild; the cost of a false negative is "genuinely stuck agent
 * stays unnoticed for hours."
 */
const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

export async function runAgentstuck(ctx: SweeperContext): Promise<SweeperResult> {
  const { daemon } = ctx;
  const findings: SweeperFinding[] = [];
  let stuck = 0;
  let scanned = 0;

  let members: Member[];
  try {
    members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
  } catch (err) {
    return {
      status: 'failed',
      findings: [],
      summary: `agentstuck: members.json read failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const now = Date.now();

  for (const member of members) {
    // Only active agent Members. Archived (fired) and non-agent
    // Members (founder, etc.) are out of scope.
    if (member.type !== 'agent') continue;
    if (member.status === 'archived') continue;

    let currentStep: string | null | undefined;
    try {
      currentStep = getCurrentStep(daemon.corpRoot, member.id);
    } catch {
      // Casket chit missing / unreadable — chit-hygiene flags
      // that separately. Skip quietly here.
      continue;
    }
    if (currentStep === null || currentStep === undefined) continue;

    scanned++;

    const hit = findChitById(daemon.corpRoot, currentStep);
    if (!hit) {
      // Casket pointer references a nonexistent chit. That's a
      // hygiene issue, not a stuck-agent issue. Skip; chit-hygiene
      // will catch the orphan pointer.
      continue;
    }
    if (hit.chit.type !== 'task') {
      // Casket pointing at a non-task chit is a misuse of Casket;
      // skip quietly.
      continue;
    }

    const task = hit.chit.fields.task;
    // Blocked tasks aren't stuck in the agent-attention sense —
    // the agent is waiting on dependencies resolving.
    if (task.workflowStatus === 'blocked') continue;

    // Terminal-status tasks shouldn't be in Casket currentStep
    // either, but if they are, skip — not this sweeper's concern.
    if (task.workflowStatus === 'completed' || task.workflowStatus === 'rejected' || task.workflowStatus === 'failed' || task.workflowStatus === 'cancelled') continue;

    // The actual stuck check.
    const updatedAt = hit.chit.updatedAt ?? hit.chit.createdAt;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
    if (!Number.isFinite(updatedMs)) continue;
    const ageMs = now - updatedMs;
    if (ageMs < STUCK_THRESHOLD_MS) continue;

    stuck++;
    const ageMin = Math.round(ageMs / 60_000);
    findings.push({
      subject: member.id,
      severity: 'warn',
      title: `${member.displayName} stuck ~${ageMin}min on ${currentStep}`,
      body: `Slot ${member.displayName} (${member.id}) has Casket.currentStep=${currentStep} pointing at task "${(task as { title?: string }).title ?? currentStep}". The task chit's updatedAt hasn't moved in ~${ageMin} minutes (threshold ${STUCK_THRESHOLD_MS / 60_000}min). Task workflowStatus=${task.workflowStatus}. Agent process is alive (not a silentexit case) but not making progress — nudge via \`cc-cli say --agent ${member.id}\` or investigate via \`cc-cli inspect --agent ${member.id}\`.`,
    });
    log(`[sweeper:agentstuck] stuck ${member.id} (~${ageMin}min on task ${currentStep})`);
  }

  if (stuck === 0) {
    return {
      status: 'noop',
      findings: [],
      summary: `agentstuck: no stuck agents (scanned ${scanned} agents with active Caskets).`,
    };
  }

  return {
    status: 'completed',
    findings,
    summary: `agentstuck: ${stuck} stuck agent(s) (scanned ${scanned}).`,
  };
}
