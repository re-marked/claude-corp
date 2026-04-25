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

import {
  readConfig,
  type Member,
  MEMBERS_JSON,
  getCurrentStep,
  getRole,
  queryChits,
  evaluateBreakerTrigger,
  tripBreaker,
  findActiveBreaker,
  CRASH_LOOP_THRESHOLD_DEFAULT,
  CRASH_LOOP_WINDOW_MS_DEFAULT,
} from '@claudecorp/shared';
import { join } from 'node:path';
import { log, logError } from '../../logger.js';
import type { Daemon } from '../../daemon.js';
import type { SweeperContext, SweeperResult, SweeperFinding } from './types.js';

export async function runSilentexit(ctx: SweeperContext): Promise<SweeperResult> {
  const { daemon } = ctx;
  const findings: SweeperFinding[] = [];
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
      findings: [],
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
      findings.push({
        subject: proc.memberId,
        severity: 'info',
        title: `Respawned silent-exit slot ${member.displayName}`,
        body: `Slot ${member.displayName} (${proc.memberId}) was in '${proc.status}' status with Casket currentStep=${currentStep}. silentexit called processManager.spawnAgent to reinitialize the slot. Next dispatch will resume from the Casket pointer; no handoff chit exists (silent exit by definition).`,
      });
      log(`[sweeper:silentexit] respawned ${proc.memberId} (was ${proc.status}, currentStep=${currentStep})`);
    } catch (err) {
      failed++;
      findings.push({
        subject: proc.memberId,
        severity: 'error',
        title: `Respawn failed for silent-exit slot ${member.displayName}`,
        body: `Attempted to respawn slot ${member.displayName} (${proc.memberId}) after detecting it in '${proc.status}' status with pending Casket work (currentStep=${currentStep}). processManager.spawnAgent threw: ${err instanceof Error ? err.message : String(err)}. If this repeats across several patrol cycles, circuit-breaker territory (1.11).`,
      });
      log(`[sweeper:silentexit] respawn failed for ${proc.memberId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (respawned === 0 && failed === 0) {
    return {
      status: 'noop',
      findings: [],
      summary: `silentexit: no dead slots detected (scanned ${procs.length} process entries).`,
    };
  }

  return {
    status: failed > 0 && respawned === 0 ? 'failed' : 'completed',
    findings,
    summary: `silentexit: respawned ${respawned} slot(s), ${failed} respawn failure(s). Scanned ${procs.length} process entries.`,
  };
}

/**
 * Crash-loop detection hook (Project 1.11). Called by the sweeper
 * runner AFTER kink writes complete so it sees fresh occurrenceCount
 * values. For each subject the silent-exit sweeper just emitted a
 * finding for, look up the active silentexit kink, evaluate the
 * trigger against the role's threshold/window (or defaults), and
 * trip the breaker if crossed.
 *
 * Why here, not in runSilentexit's body: writeOrBumpKink runs in the
 * runner pipeline, so the kink's count for THIS pass isn't visible
 * yet inside runSilentexit. Running detection here keeps the trigger
 * coupled to the silent-exit data source per spec while sequencing
 * after the kink bump that produces the count.
 *
 * Idempotency: tripBreaker dedups on slug — repeat calls during a
 * persistent loop bump triggerCount + recentSilentexitKinks rather
 * than creating duplicates. Skips slugs that already have an active
 * trip (no point evaluating a slot that's already paused).
 *
 * Failure containment: any error per-slug logs + continues; one
 * malformed kink or unreadable role registry must not stop other
 * detections in the same round.
 */
export function detectAndTripCrashLoops(
  daemon: Daemon,
  findings: ReadonlyArray<SweeperFinding>,
): void {
  if (findings.length === 0) return;

  const now = new Date();
  let members: Member[];
  try {
    members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
  } catch (err) {
    logError(
      `[sweeper:silentexit] breaker detection skipped — members.json read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Read all active silentexit kinks once; filter per-finding in
  // memory. Cheaper than per-slug query in the common case where
  // multiple slots loop in the same round.
  let activeKinks: ReturnType<typeof queryChits<'kink'>>['chits'];
  try {
    const result = queryChits<'kink'>(daemon.corpRoot, {
      types: ['kink'],
      scopes: ['corp'],
      statuses: ['active'],
    });
    activeKinks = result.chits.filter(
      (c) => c.chit.fields.kink.source === 'sweeper:silentexit',
    );
  } catch (err) {
    logError(
      `[sweeper:silentexit] breaker detection skipped — kink query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  for (const finding of findings) {
    const slug = finding.subject;

    try {
      // Skip if already tripped — avoids redundant evaluation and
      // keeps tripBreaker's idempotency contract from churning.
      if (findActiveBreaker(daemon.corpRoot, slug)) continue;

      const kinkContainer = activeKinks.find(
        (c) => c.chit.fields.kink.subject === slug,
      );
      if (!kinkContainer) continue;
      const kink = kinkContainer.chit;

      // Per-role config snapshot. Member missing (slot was removed
      // mid-round) or role not in registry → fall through to defaults.
      const member = members.find((m) => m.id === slug);
      const role = member?.role ? getRole(member.role) : undefined;
      const threshold = role?.crashLoopThreshold ?? CRASH_LOOP_THRESHOLD_DEFAULT;
      const windowMs = role?.crashLoopWindowMs ?? CRASH_LOOP_WINDOW_MS_DEFAULT;

      const decision = evaluateBreakerTrigger(
        {
          id: kink.id,
          createdAt: kink.createdAt,
          occurrenceCount: kink.fields.kink.occurrenceCount,
        },
        threshold,
        windowMs,
        now,
      );
      if (!decision.shouldTrip) continue;

      const reason =
        `Crash-loop breaker tripped: ${decision.count} silent-exits within ` +
        `${Math.round(decision.ageMs / 1000)}s (threshold ${threshold} / window ${Math.round(windowMs / 1000)}s).`;

      const result = tripBreaker({
        corpRoot: daemon.corpRoot,
        slug,
        triggerThreshold: threshold,
        triggerWindowMs: windowMs,
        triggerKinkId: kink.id,
        loopStartedAt: kink.createdAt,
        reason,
      });

      log(
        `[sweeper:silentexit] breaker ${result.action} for ${slug} (count=${result.triggerCount}, threshold=${threshold})`,
      );
    } catch (err) {
      logError(
        `[sweeper:silentexit] breaker detection failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Continue — one slug's failure doesn't poison the round.
    }
  }
}
