/**
 * Audit engine — the pure decision function the cc-cli audit command
 * invokes after sourcing its inputs from the hook boundary. Given
 * AuditInput, returns AuditDecision. No I/O, no side effects: hand
 * it canned inputs in tests, observe the exact decision it produces.
 *
 * Decision tree, in order. The ORDER matters because early approves
 * short-circuit later (expensive) checks, and the hard gates precede
 * the soft gates so tier-3 inbox doesn't get buried under "missing
 * build evidence" noise.
 *
 *   1. stopHookActive ───► approve
 *      Anti-loop: Claude Code sets this when a prior Stop in the
 *      same cycle already blocked. Must approve or the agent loops.
 *
 *   2. currentTask === undefined ───► approve (fail-open)
 *      Substrate gap: Casket doesn't exist or the current task chit
 *      is missing. Log, approve. Fail-open beats trapping the agent
 *      in a state we can't evaluate.
 *
 *   3. currentTask === null ───► approve
 *      Agent is idle — Casket exists, currentStep is null. Nothing
 *      to audit.
 *
 *   4. openTier3Inbox.length > 0 ───► block (hard gate)
 *      Founder DMs, escalations, direct assignments. Explicit
 *      resolution required — can't be worked around by doing more
 *      task work.
 *
 *   5. evidence gaps on current task ───► block (soft gate)
 *      Acceptance criteria without matching evidence, files without
 *      read-back, build/tests/git-status didn't run. Surface as a
 *      checklist; the loop catches dishonest claims by re-blocking
 *      until evidence appears.
 *
 *   6. fallback ───► approve
 *      Current task has no criteria (or all criteria verified) +
 *      inbox clear + universal gates satisfied. Let them go.
 */

import type { AuditDecision, AuditInput } from './types.js';
import { buildAuditPrompt } from './prompt.js';
import { scanEvidence } from './evidence.js';

export function runAudit(input: AuditInput): AuditDecision {
  // (1) Anti-loop: if the stop hook has already blocked in this
  // cycle, approve. Without this the audit would fire on every
  // turn-end and eventually re-block → infinite loop.
  if (input.stopHookActive) {
    return { decision: 'approve' };
  }

  // (2) Substrate gap. Casket missing or task resolver returned no
  // hit. We can't meaningfully audit without knowing what the agent
  // is supposed to be doing — fail-open rather than fail-closed.
  // cc-cli audit is responsible for logging this at the boundary;
  // the engine stays pure.
  if (input.currentTask === undefined) {
    return { decision: 'approve' };
  }

  // (3) Idle agent, nothing to gate on task side — but inbox still
  // matters (founder DM could be waiting even on an idle agent).
  // So we don't early-return here; fall through to inbox check with
  // "no criteria to audit" implicit.

  // (4) Tier-3 inbox hard gate. Any open critical item blocks,
  // regardless of current-task state.
  if (input.openTier3Inbox.length > 0) {
    return {
      decision: 'block',
      reason: buildAuditPrompt({
        audit: input,
        // No task-side checks when tier-3 is the dominant reason —
        // keep the prompt focused. If there's also a current task,
        // the prompt template still renders its criteria header for
        // context, just without unverified-criteria noise.
        unverifiedCriteria: [],
        filesNeedingReadback: [],
        missingEvidence: [],
      }),
    };
  }

  // (5) Task-side evidence gate. Skip for idle agents (null task).
  if (input.currentTask !== null) {
    const criteria = input.currentTask.fields.task?.acceptanceCriteria ?? [];
    const scan = scanEvidence(criteria, input.recent);

    const criteriaGap = scan.unverifiedCriteria.length > 0;
    const readbackGap = scan.filesNeedingReadback.length > 0;
    const universalGap = scan.missingEvidence.length > 0;

    if (criteriaGap || readbackGap || universalGap) {
      return {
        decision: 'block',
        reason: buildAuditPrompt({
          audit: input,
          unverifiedCriteria: scan.unverifiedCriteria,
          filesNeedingReadback: scan.filesNeedingReadback,
          missingEvidence: scan.missingEvidence,
        }),
      };
    }
  }

  // (6) Everything clear — approve.
  return { decision: 'approve' };
}
