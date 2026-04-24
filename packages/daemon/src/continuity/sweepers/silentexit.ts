/**
 * `silentexit` sweeper — respawn slots that died without a clean
 * exit.
 *
 * Detects: Members whose process-manager entry is in `crashed` or
 * `stopped` status AND whose Casket has a non-null currentStep
 * (i.e. the slot was mid-work when it died). These are the "silent
 * exits" Sexton exists to resurrect: no clean `cc-cli done`, no
 * handoff chit, just a process that went away with work assigned.
 *
 * Action: for each detected slot, call processManager.spawnAgent(id).
 * spawnAgent is idempotent for existing members (1.9.5 spec-pin) —
 * it re-registers the agent without creating a new Member record.
 * After respawn the slot is ready to be dispatched again; the slot's
 * Casket still points at the original task, so the next dispatch
 * picks up where the dead session left off (minus the in-turn
 * context, which step-log chits from the 1.6/1.9.5 spec will
 * eventually carry across — not wired in this PR).
 *
 * What this does NOT do:
 *   - Detect claude-code dispatch-subprocess crashes. Those are
 *     caller-side failures surfaced via /cc/say's error response,
 *     not long-running-process deaths. This sweeper only sees
 *     Members that process-manager has flagged 'crashed'/'stopped'.
 *     In pure-claude-code corps this sweeper correctly finds nothing.
 *   - Distinguish "died once" from "died 3× in 5 min." Retry-loop
 *     protection is 1.11's circuit breaker territory. silentexit
 *     respawns once per invocation per detected slot; repeated calls
 *     by Sexton's patrol naturally accumulate, and 1.11 (when it
 *     ships) observes the restart count and trips a breaker.
 *   - Handle slots whose Casket is null. No currentStep = no work
 *     was pending = respawning is not this sweeper's concern.
 *   - Write handoff chits or step-logs. The sweeper reports what it
 *     did; state continuity across the respawn boundary is a
 *     separate primitive.
 */

import { readConfig, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { join } from 'node:path';
import { log } from '../../logger.js';
import { getCurrentStep } from '@claudecorp/shared';
import type { SweeperContext, SweeperResult, SweeperObservation } from './types.js';

export async function runSilentexit(ctx: SweeperContext): Promise<SweeperResult> {
  const { daemon } = ctx;
  const observations: SweeperObservation[] = [];
  let respawned = 0;
  let failed = 0;

  // Pull the full member list so we can tell agent Members from
  // founder Members and map process entries back to display names
  // for human-legible observation subjects.
  let members: Member[];
  try {
    members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
  } catch (err) {
    return {
      status: 'failed',
      observations: [],
      summary: `silentexit: members.json read failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // listAgents returns the in-memory process-manager state, which
  // is what we actually need — members.json 'status' is a coarser
  // "active/idle/archived" field not driven by process lifecycle.
  const procs = daemon.processManager.listAgents();

  for (const proc of procs) {
    // Only act on dead-mid-work slots. 'ready' + 'starting' are
    // alive. Anything else with no Casket currentStep means the
    // slot retired cleanly — nothing to resurrect.
    if (proc.status !== 'crashed' && proc.status !== 'stopped') continue;

    // Skip archived members (silentexit honors the fire action).
    const member = members.find((m) => m.id === proc.memberId);
    if (!member) continue;
    if (member.status === 'archived') continue;

    // Does this slot have work to resume? If its Casket is empty,
    // respawning achieves nothing — leave it alone.
    let currentStep: string | null | undefined;
    try {
      currentStep = getCurrentStep(daemon.corpRoot, proc.memberId);
    } catch {
      // Casket chit missing / malformed — treat as "no pending
      // work" and skip. A later chit-hygiene sweeper will flag the
      // malformed Casket separately.
      continue;
    }
    if (currentStep === null || currentStep === undefined) continue;

    // Attempt respawn. spawnAgent is idempotent for existing
    // Members and synchronous for claude-code harness agents
    // (registerHarnessAgent flips status back to 'ready'
    // immediately); for gateway agents it may resolve with
    // 'starting'. Both outcomes satisfy "the slot is no longer
    // dead" for silentexit's purposes.
    try {
      await daemon.processManager.spawnAgent(proc.memberId);
      respawned++;
      observations.push({
        category: 'NOTICE',
        subject: proc.memberId,
        title: `Respawned silent-exit slot ${member.displayName}`,
        importance: 3,
        body: `Slot ${member.displayName} (${proc.memberId}) was in '${proc.status}' status with Casket currentStep=${currentStep}. silentexit called processManager.spawnAgent to reinitialize the slot. Next dispatch will resume from the Casket pointer; no handoff chit exists (silent exit by definition).`,
        tags: ['sweeper:silentexit', 'respawn'],
      });
      log(`[sweeper:silentexit] respawned ${proc.memberId} (was ${proc.status}, currentStep=${currentStep})`);
    } catch (err) {
      failed++;
      observations.push({
        category: 'NOTICE',
        subject: proc.memberId,
        title: `Respawn failed for silent-exit slot ${member.displayName}`,
        importance: 4,
        body: `Attempted to respawn slot ${member.displayName} (${proc.memberId}) after detecting it in '${proc.status}' status with pending Casket work (currentStep=${currentStep}). processManager.spawnAgent threw: ${err instanceof Error ? err.message : String(err)}. If this repeats across several patrol cycles, circuit-breaker territory (1.11).`,
        tags: ['sweeper:silentexit', 'respawn-failed'],
      });
      log(`[sweeper:silentexit] respawn failed for ${proc.memberId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (respawned === 0 && failed === 0) {
    return {
      status: 'noop',
      observations: [],
      summary: `silentexit: no dead slots detected (scanned ${procs.length} process entries).`,
    };
  }

  return {
    status: failed > 0 && respawned === 0 ? 'failed' : 'completed',
    observations,
    summary: `silentexit: respawned ${respawned} slot(s), ${failed} respawn failure(s). Scanned ${procs.length} process entries.`,
  };
}
