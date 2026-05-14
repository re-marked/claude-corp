/**
 * `walk-stalled` sweeper (Project 2.4) — detect walks whose forward
 * motion has died with open steps remaining.
 *
 * The complement to walk-aware audit (2.3): audit catches agents at
 * `cc-cli done` who try to advance past a missing expectedOutput.
 * Some failure modes never reach `done` — agent decommissions mid-
 * walk, founder overrides audit, daemon dies mid-step, agent gets
 * stuck and Claude Code's anti-loop guard releases them without
 * progress. In all those cases a Contract sits with open steps and
 * nobody working on them. This sweeper surfaces those.
 *
 * Detection per active Contract with a blueprintId:
 *   - Skip if ANY task on this contract is in `clearance`
 *     workflowStatus. That state means Pressman owns the work — the
 *     agent-side absence is correct, not a stall. Without this filter
 *     every PR mid-merge would generate noise kinks and drown the
 *     real stall signal.
 *   - Skip if any open task (workflowStatus not in terminal-success
 *     / terminal-failure set) has an assignee that resolves to a
 *     non-archived Member. Someone's on it.
 *   - Compute `lastClose` = max updatedAt of tasks with
 *     workflowStatus='completed'. When the contract has no completed
 *     tasks yet, use contract.createdAt as the floor. If
 *     (now - lastClose) <= stallThresholdMs → skip (recent activity
 *     is incompatible with stalled).
 *   - Otherwise emit a `warn` finding with the contract id as subject.
 *
 * Subject = contract id. Dedup pairs (source=sweeper:walk-stalled,
 * subject=<contract-id>) collapse to one kink with occurrenceCount
 * bumping across patrols until either the walk advances (auto-resolve)
 * or Sexton acknowledges.
 *
 * What this does NOT do:
 *   - Auto-Hand the orphan steps. The right reassignment is judgment
 *     (specific slot vs role pool vs accept-as-acceptable-pause).
 *     Sexton reads the kink and decides; in the no-humans reality
 *     the founder-DM path becomes a permanent kink record.
 *   - Distinguish "all tasks queued, never started" from "started and
 *     orphaned mid-walk." Both surface — the body names the
 *     last-completed step so Sexton can tell.
 *   - Touch the Clearinghouse worktree tree, run git, or read
 *     anything off-corp. Pure chit-store + members.json reads.
 *
 * Threshold: configurable via opts.stallThresholdMs (the runner can
 * pass it through from the patrol blueprint's var). Default 30
 * minutes — Pulse cadence is 5min, so 30min = 6 ticks of no
 * advancement, small enough to surface real stalls quickly, large
 * enough to avoid kinks on agents mid-thought between dispatches.
 */

import {
  readConfig,
  type Member,
  MEMBERS_JSON,
  queryChits,
  getWalkProgress,
  type Chit,
} from '@claudecorp/shared';
import { join } from 'node:path';
import { log } from '../../logger.js';
import type { SweeperContext, SweeperResult, SweeperFinding } from './types.js';

/** Default stall threshold — 30 min in ms. See file docstring. */
export const WALK_STALL_THRESHOLD_DEFAULT_MS = 30 * 60 * 1000;

/**
 * Optional opts. The runner currently invokes sweepers with a fixed
 * SweeperContext shape and no per-sweeper opts pass-through; this
 * threshold field is here for future runner extension AND for direct
 * test invocation. When not provided, default applies.
 */
export interface WalkStalledOpts {
  readonly stallThresholdMs?: number;
  /** Override for "now" — supports deterministic tests. */
  readonly now?: number;
}

export async function runWalkStalled(
  ctx: SweeperContext,
  opts: WalkStalledOpts = {},
): Promise<SweeperResult> {
  const { daemon } = ctx;
  const stallThresholdMs = opts.stallThresholdMs ?? WALK_STALL_THRESHOLD_DEFAULT_MS;
  const now = opts.now ?? Date.now();
  const findings: SweeperFinding[] = [];

  // members.json — needed to resolve assignees → live-or-archived.
  let members: Member[];
  try {
    members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
  } catch (err) {
    return {
      status: 'failed',
      findings: [],
      summary: `walk-stalled: members.json read failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const activeMemberIds = new Set(
    members.filter((m) => m.status !== 'archived').map((m) => m.id),
  );

  // Active contracts with a blueprintId (i.e. cast walks, not ad-hoc
  // contracts). queryChits walks all discoverable scopes.
  let contractResult;
  try {
    contractResult = queryChits<'contract'>(daemon.corpRoot, {
      types: ['contract'],
      statuses: ['active'],
    });
  } catch (err) {
    return {
      status: 'failed',
      findings: [],
      summary: `walk-stalled: contract query failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let scanned = 0;
  let stalled = 0;

  for (const item of contractResult.chits) {
    const contract = item.chit as Chit<'contract'>;
    const contractFields = contract.fields.contract;

    // No blueprint = not a walk. Ad-hoc multi-task contracts exist
    // and aren't this sweeper's business.
    if (!contractFields.blueprintId) continue;

    scanned++;

    // Resolve the walk picture via the shared helper. Returns null
    // when the blueprint is missing/deleted — drift case. We treat
    // missing-blueprint as "can't classify, skip" rather than emit
    // a kink here; chit-hygiene's territory if the blueprint
    // reference is broken.
    const progress = getWalkProgress(contract, daemon.corpRoot);
    if (!progress) continue;

    // Categorize steps.
    const TERMINAL_STATUSES = new Set<string>([
      'completed',
      'failed',
      'rejected',
      'cancelled',
    ]);
    const openSteps = progress.steps.filter((s) => {
      // Step with no task → ad-hoc gap, treat as open. Surfaces
      // walks whose cast didn't produce every task.
      if (!s.taskStatus) return true;
      return !TERMINAL_STATUSES.has(s.taskStatus);
    });
    const completedSteps = progress.steps.filter((s) => s.taskStatus === 'completed');

    // No open steps → contract effectively done. The chit-side
    // 'active' status is stale; chit-hygiene's territory. Skip here.
    if (openSteps.length === 0) continue;

    // Clearance filter — any open step in 'clearance' means Pressman
    // owns it. Agent-absence on the SAME contract during a clearance
    // submission is normal — Pressman's session does the merge, the
    // original author's session is gone. Without this filter every
    // PR mid-merge looks stalled.
    if (openSteps.some((s) => s.taskStatus === 'clearance')) continue;

    // Live-agent filter — if any open step's task assignee resolves
    // to a non-archived Member id, someone's nominally on the work.
    // Note: doesn't check process-manager liveness; agentstuck +
    // silentexit handle that orthogonally. Here we just want "is
    // there at least one live slot assigned to an open step."
    //
    // Role-shaped assignees (e.g. "backend-engineer" with no slot
    // resolved yet) deliberately DON'T count as "someone on it" —
    // the spec defines a stall as "no live AGENT in any of the
    // remaining open Tasks' assignees." A role-id in the assignee
    // field means the task is queued in a role pool waiting for
    // bacteria-spawn (1.10) to materialize a slot; if that pool
    // remains unrealized past the threshold, that IS the stall
    // condition this sweeper surfaces.
    const someoneAssigned = openSteps.some((s) => {
      const assignee = s.taskAssignee;
      if (!assignee) return false;
      return activeMemberIds.has(assignee);
    });
    if (someoneAssigned) continue;

    // Last-close timestamp. Most-recent completed task's updatedAt
    // when any completed task exists; otherwise contract.createdAt
    // as the "nothing has moved since cast" floor.
    let lastCloseIso: string;
    if (completedSteps.length > 0) {
      const stamps = completedSteps
        .map((s) => s.taskUpdatedAt)
        .filter((t): t is string => typeof t === 'string');
      lastCloseIso = stamps.sort().pop() ?? contract.createdAt;
    } else {
      lastCloseIso = contract.createdAt;
    }
    const lastCloseMs = Date.parse(lastCloseIso);
    if (!Number.isFinite(lastCloseMs)) continue; // malformed timestamp — chit-hygiene's domain
    if (now - lastCloseMs <= stallThresholdMs) continue; // recent activity, not stalled

    // Stalled. Compose the finding.
    stalled++;
    const ageMin = Math.round((now - lastCloseMs) / 60_000);
    const lastCompleted = completedSteps
      .slice()
      .sort((a, b) => (a.taskUpdatedAt ?? '').localeCompare(b.taskUpdatedAt ?? ''))
      .pop();
    const lastCompletedDesc = lastCompleted
      ? `step \`${lastCompleted.stepId}\` (task ${lastCompleted.taskId ?? '?'})`
      : 'none — contract never advanced past cast';
    const orphanLines = openSteps
      .map((s) => {
        const taskRef = s.taskId ? `task ${s.taskId}` : '(no task chit)';
        const assigneeNote = s.taskAssignee
          ? ` assignee=${s.taskAssignee}`
          : ' unassigned';
        const statusNote = s.taskStatus ? ` workflowStatus=${s.taskStatus}` : '';
        const roleHint = s.step.assigneeRole ? ` role=${s.step.assigneeRole}` : '';
        return `  - step \`${s.stepId}\` — ${taskRef}${statusNote}${assigneeNote}${roleHint}`;
      })
      .join('\n');

    // `cc-cli hand` only accepts tasks in {draft, queued, dispatched}.
    // It refuses in_progress/blocked/under_review (state-machine guard
    // in hand-core.ts:validateTransition('dispatch', ...)). For stalls
    // that hit those states because the assignee was archived, the
    // recovery requires rewinding workflowStatus first. Split the
    // suggestion by reachability so Sexton's recommendation always
    // names a command that will actually succeed.
    const HANDABLE_STATUSES = new Set(['draft', 'queued', 'dispatched']);
    const handableOrphans = openSteps.filter(
      (s) => s.taskId && (!s.taskStatus || HANDABLE_STATUSES.has(s.taskStatus)),
    );
    const stuckOrphans = openSteps.filter(
      (s) => s.taskId && s.taskStatus && !HANDABLE_STATUSES.has(s.taskStatus),
    );

    const handLines = handableOrphans
      .map((s) => {
        const target = s.step.assigneeRole ?? '<slot-or-role>';
        return `\`cc-cli hand --to ${target} --chit ${s.taskId} --from sexton\``;
      })
      .join(', ');
    const rewindLines = stuckOrphans
      .map((s) => {
        const target = s.step.assigneeRole ?? '<slot-or-role>';
        return (
          `task ${s.taskId} (workflowStatus=${s.taskStatus}): rewind to queued first, ` +
          `then hand — \`cc-cli chit update ${s.taskId} --set-field task.workflowStatus=queued --from sexton\` ` +
          `&& \`cc-cli hand --to ${target} --chit ${s.taskId} --from sexton\``
        );
      })
      .join('\n  ');

    const suggestedAction =
      [
        handableOrphans.length > 0
          ? `Re-Hand the orphan task(s): ${handLines}.`
          : '',
        stuckOrphans.length > 0
          ? `For tasks stuck mid-flight (state machine refuses \`cc-cli hand\` from in_progress/blocked/under_review):\n  ${rewindLines}.\n\nThe rewind preserves prior stamps (claimedAt, editorReviewRound, any in-flight .pending-handoff.json in the original assignee's workspace). Most consumers ignore those once workflowStatus=queued, but an under_review task's pending handoff is lost work the new assignee will need to redo.`
          : '',
        handableOrphans.length === 0 && stuckOrphans.length === 0
          ? '(No task chits to recover; cast may need re-running.)'
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');

    findings.push({
      subject: contract.id,
      severity: 'warn',
      title: `Stalled walk: ${progress.blueprintName} (contract ${contract.id})`,
      body:
        `Contract \`${contract.id}\` cast from blueprint \`${progress.blueprintName}\` has ` +
        `${openSteps.length} open step(s) and no live agent assigned; last forward motion was ` +
        `~${ageMin} min ago (threshold: ${Math.round(stallThresholdMs / 60_000)} min).\n\n` +
        `Last completed: ${lastCompletedDesc}\n\n` +
        `Open steps:\n${orphanLines}\n\n` +
        `Suggested action: ${suggestedAction} ` +
        `If this is an intentional long-lead pause (waiting on external dep), acknowledge ` +
        `the kink to silence it.`,
    });
    log(
      `[sweeper:walk-stalled] stalled contract=${contract.id} blueprint=${progress.blueprintName} openSteps=${openSteps.length} ageMin=${ageMin}`,
    );
  }

  if (stalled === 0) {
    return {
      status: 'noop',
      findings: [],
      summary: `walk-stalled: no stalled walks (scanned ${scanned} blueprint-backed active contract(s)).`,
    };
  }

  return {
    status: 'completed',
    findings,
    summary: `walk-stalled: ${stalled} stalled walk(s) (scanned ${scanned} blueprint-backed active contract(s)).`,
  };
}
