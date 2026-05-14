/**
 * Project 2.5 — apply a self-witnessing review verdict.
 *
 * The verdict-decide flow lives in shared (not the daemon) because
 * it's pure-ish chit-store mutation + state-machine validation. The
 * daemon-side wiring (when to call this, what to dispatch after) is
 * a separate consumer that lands once the substrate is reviewed.
 *
 * ### When this runs
 *
 * Review-sessions write a `review` chit (`verdict ∈ {accept, redo,
 * flag}`) at the end of their turn. The Stop hook re-wire (follow-up
 * PR) routes review-mode Stops here instead of `cc-cli audit`. At the
 * moment this function fires, the linked Task is in `under_review` —
 * the same state audit operates on; the review-session intercepts the
 * Stop hook BEFORE audit so the verdict either gates or replaces the
 * audit-approve transition.
 *
 * ### Verdict routing
 *
 *   - `accept` → caller fires audit next (transitions under_review →
 *     completed via the existing audit-approve trigger). Substrate
 *     just closes the review chit; we don't fire audit ourselves
 *     because audit reads stdin + emits decisions to stdout — the
 *     orchestration belongs at the hook boundary.
 *
 *   - `redo`   → fires the existing `audit-block` trigger
 *     (under_review → in_progress) so the agent picks the same Task
 *     back up next dispatch. Bumps task.reviewRedoCount; closes the
 *     review chit. Hard cap: when reviewRedoCount is already >= 1
 *     before this verdict applies, the redo is auto-downgraded to
 *     `flag` — pointless second redos are exactly the cost-blowing
 *     loop the cap exists to prevent. `redoFeedback` from the chit
 *     is what the next dispatch's prompt should surface; that surface
 *     is the consumer-side concern.
 *
 *   - `flag`   → emits a Tier-3 inbox-item for the founder with the
 *     review's reasoning, closes the review chit, leaves the Task in
 *     under_review. The chain walker won't advance past an under_
 *     review task — the walk is implicitly paused until the founder
 *     intervenes (override audit, or manually transition).
 *
 * ### What this does NOT do
 *
 *   - Fire audit on accept (caller's job — see above).
 *   - Dispatch the redo session (consumer-side daemon work).
 *   - Read the daemon's process-manager state.
 *   - Touch members.json for live-agent checks (different problem).
 *
 * ### Failure modes
 *
 * All non-applied paths return `applied: false` with a populated
 * `errors[]` and never mutate the chit store. Callers should surface
 * the error to the agent / founder rather than treating "not applied"
 * as silent success.
 */

import { findChitById, updateChit, chitScopeFromPath, queryChits } from '../chits.js';
import { createInboxItem } from '../inbox.js';
import { validateTransition, TaskTransitionError } from '../task-state-machine.js';
import type { Chit, ReviewFields, TaskFields } from '../types/chit.js';

/** Hard cap on redo verdicts per Task. Spec: 1. */
export const REVIEW_REDO_CAP_DEFAULT = 1;

/**
 * Result of attempting to apply a review verdict.
 *
 * `outcomeVerdict` may differ from the chit's `verdict` field when
 * the cap forces a downgrade — the chit still records what the
 * reviewer said; this field records what the system actually did
 * with that verdict.
 *
 * `appliedTaskTransition` is the (from, to) workflowStatus pair
 * actually written, when one was. `null` when the verdict didn't
 * change the Task state (accept + flag are non-mutating on the task).
 */
export interface ApplyReviewVerdictResult {
  readonly applied: boolean;
  readonly outcomeVerdict: 'accept' | 'redo' | 'flag';
  readonly inputVerdict: 'accept' | 'redo' | 'flag';
  readonly capDowngrade: boolean;
  readonly appliedTaskTransition: {
    readonly from: string;
    readonly to: string;
  } | null;
  readonly inboxItemId: string | null;
  readonly reviewChitId: string;
  readonly taskId: string;
  readonly errors: readonly string[];
}

export interface ApplyReviewVerdictOpts {
  /** Chit id of the `review` chit whose verdict is being applied. */
  readonly reviewChitId: string;
  /**
   * Founder member id — receives Tier-3 inbox-items on flag verdicts
   * and on cap-downgrade flags. Required; the caller must resolve the
   * founder from members.json (typically the rank=owner Member).
   */
  readonly founderMemberId: string;
  /** Overrideable redo cap. Default `REVIEW_REDO_CAP_DEFAULT` (1). */
  readonly redoCap?: number;
}

export function applyReviewVerdict(
  corpRoot: string,
  opts: ApplyReviewVerdictOpts,
): ApplyReviewVerdictResult {
  const redoCap = opts.redoCap ?? REVIEW_REDO_CAP_DEFAULT;
  const errors: string[] = [];

  // ── Resolve the review chit + sanity-check its state. ───────────
  const reviewHit = findChitById(corpRoot, opts.reviewChitId);
  if (!reviewHit || reviewHit.chit.type !== 'review') {
    errors.push(`review chit not found or wrong type: ${opts.reviewChitId}`);
    return makeNoOp(opts.reviewChitId, '', errors);
  }
  const reviewChit = reviewHit.chit as Chit<'review'>;
  if (reviewChit.status !== 'active') {
    errors.push(
      `review chit ${opts.reviewChitId} status is ${reviewChit.status}; ` +
        `verdict was already applied or chit was burned`,
    );
    return makeNoOp(opts.reviewChitId, '', errors);
  }
  const review = reviewChit.fields.review as ReviewFields;
  const inputVerdict = review.verdict;

  // ── Resolve the linked task chit + sanity-check its state. ──────
  const taskHit = findChitById(corpRoot, review.taskId);
  if (!taskHit || taskHit.chit.type !== 'task') {
    errors.push(`linked task chit not found or wrong type: ${review.taskId}`);
    return makeNoOp(opts.reviewChitId, review.taskId, errors, inputVerdict);
  }
  const taskChit = taskHit.chit as Chit<'task'>;
  const task = taskChit.fields.task as TaskFields;
  const taskWs = task.workflowStatus ?? null;
  // Review fires when the Task is in under_review — the same state
  // audit operates on. Other states mean the orchestration is wrong
  // (audit already fired, hand re-routed, founder forced a state).
  // Refuse rather than corrupt the state machine.
  if (taskWs !== 'under_review') {
    errors.push(
      `task ${review.taskId} workflowStatus is ${taskWs ?? '(unset)'}; ` +
        `review-decide expects under_review`,
    );
    return makeNoOp(opts.reviewChitId, review.taskId, errors, inputVerdict);
  }

  // ── Cap evaluation: a second redo on the same task auto-promotes
  //    to flag. The downgrade is INVISIBLE to the chit's stored
  //    verdict — the agent said redo; what the system does about it
  //    is recorded in the outcome + the inbox-item we emit. ────────
  const currentRedoCount = task.reviewRedoCount ?? 0;
  let outcomeVerdict: 'accept' | 'redo' | 'flag' = inputVerdict;
  let capDowngrade = false;
  if (inputVerdict === 'redo' && currentRedoCount >= redoCap) {
    outcomeVerdict = 'flag';
    capDowngrade = true;
  }

  // ── Apply per outcome verdict. ──────────────────────────────────
  let appliedTransition: { from: string; to: string } | null = null;
  let inboxItemId: string | null = null;

  try {
    if (outcomeVerdict === 'redo') {
      // under_review → in_progress via the audit-block trigger.
      // Same trigger audit uses on its block path — reusing the
      // legal transition rather than inventing a new one.
      const nextWs = validateTransition(taskWs, 'audit-block', taskChit.id);
      const taskScope = chitScopeFromPath(corpRoot, taskHit.path);
      const newReviewRedoCount = currentRedoCount + 1;
      // Codex P2 on PR #213: stamp redoFeedback onto the Task so the
      // future redispatch surface can read it without status-filtering.
      // The review chit closes immediately on verdict-application; a
      // findActiveReviewForTask call would miss the closed chit and
      // the next session would boot the same Task without the
      // specific feedback the cap exists to make non-pointless.
      updateChit(corpRoot, taskScope, 'task', taskChit.id, {
        updatedBy: review.reviewerSlug,
        fields: {
          task: {
            ...task,
            workflowStatus: nextWs,
            reviewRedoCount: newReviewRedoCount,
            pendingRedoFeedback: review.redoFeedback ?? null,
          },
        } as never,
      });
      appliedTransition = { from: taskWs, to: nextWs };
    } else if (outcomeVerdict === 'flag') {
      // Emit a Tier-3 inbox-item. Task stays in under_review (chain
      // walker won't advance past it; the walk is implicitly paused
      // until the founder weighs in).
      const subject = capDowngrade
        ? `Walk review hit redo cap on task ${review.taskId} — founder needed`
        : `Walk review flagged task ${review.taskId} — founder needed`;
      const item = createInboxItem({
        corpRoot,
        recipient: opts.founderMemberId,
        tier: 3,
        from: 'system',
        subject: subject.slice(0, 200),
        source: 'system',
        sourceRef: opts.reviewChitId,
        references: [opts.reviewChitId, review.taskId, review.contractId],
      });
      inboxItemId = item.id;
    }
    // accept: nothing to do on the task. Caller fires audit next.

    // ── Close the review chit so the verdict isn't re-applied. ──
    const reviewScope = chitScopeFromPath(corpRoot, reviewHit.path);
    updateChit(corpRoot, reviewScope, 'review', reviewChit.id, {
      updatedBy: review.reviewerSlug,
      status: 'closed',
    });
  } catch (err) {
    if (err instanceof TaskTransitionError) {
      errors.push(`state-machine refused transition: ${err.message}`);
    } else {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    return {
      applied: false,
      inputVerdict,
      outcomeVerdict,
      capDowngrade,
      appliedTaskTransition: appliedTransition,
      inboxItemId,
      reviewChitId: opts.reviewChitId,
      taskId: review.taskId,
      errors,
    };
  }

  return {
    applied: true,
    inputVerdict,
    outcomeVerdict,
    capDowngrade,
    appliedTaskTransition: appliedTransition,
    inboxItemId,
    reviewChitId: opts.reviewChitId,
    taskId: review.taskId,
    errors,
  };
}

/**
 * Build a not-applied result without touching the chit store. Used
 * for the pre-mutation guard paths (missing chit, wrong type, wrong
 * state) — callers see structured errors without any partial writes.
 */
function makeNoOp(
  reviewChitId: string,
  taskId: string,
  errors: readonly string[],
  inputVerdict: 'accept' | 'redo' | 'flag' = 'accept',
): ApplyReviewVerdictResult {
  return {
    applied: false,
    inputVerdict,
    outcomeVerdict: inputVerdict,
    capDowngrade: false,
    appliedTaskTransition: null,
    inboxItemId: null,
    reviewChitId,
    taskId,
    errors,
  };
}

/**
 * Find the most-recent active `review` chit for a given task. Mostly
 * a debugging / inspection helper at this point — Codex P2 on PR
 * #213 surfaced that verdict-application closes the review chit, so
 * the redispatch surface should NOT depend on a still-active chit
 * carrying the feedback. The substrate path is now: redo verdict
 * stamps `task.pendingRedoFeedback` directly, and the redispatch
 * reads + consumes that via consumePendingRedoFeedback().
 *
 * Active-status filter preserved: this helper answers "is there a
 * verdict waiting to be applied right now?" — useful for the audit
 * hook's review-mode detection in Phase 2.
 *
 * Defensive: if two active reviews exist for the same task (data
 * drift — shouldn't happen with proper verdict-application but
 * possible if a write half-succeeded), returns the most-recently-
 * created one. Doesn't auto-close the duplicates; chit-hygiene's
 * domain.
 */
export function findActiveReviewForTask(
  corpRoot: string,
  taskId: string,
): Chit<'review'> | null {
  try {
    const result = queryChits<'review'>(corpRoot, {
      types: ['review'],
      statuses: ['active'],
    });
    const matches = result.chits
      .map((cwb) => cwb.chit as Chit<'review'>)
      .filter((c) => (c.fields.review as ReviewFields).taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matches[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Consume `task.pendingRedoFeedback` — return the string and clear
 * the field atomically (well, as atomic as a single updateChit can
 * be — reader sees one of two consistent states).
 *
 * The future redispatch path calls this when booting a session on a
 * Task that was redo'd. The returned string is what gets surfaced
 * in the new session's prompt (the agent's "you redid this; here's
 * the feedback that fired" context). Clearing on consume prevents
 * the same feedback from re-firing on a later unrelated dispatch.
 *
 * Returns null when:
 *   - task chit not found / wrong type (returns null + logs nothing;
 *     pre-mutation guard like applyReviewVerdict's path)
 *   - pendingRedoFeedback is absent / null / empty string (the
 *     common case for tasks that never had a redo verdict applied)
 *
 * Best-effort: any write failure leaves the field as-is so a future
 * consume can retry. The caller doesn't need the field to be cleared
 * to proceed — they need the string. We surface what we read.
 */
export function consumePendingRedoFeedback(
  corpRoot: string,
  taskId: string,
  consumerSlug: string,
): string | null {
  const hit = findChitById(corpRoot, taskId);
  if (!hit || hit.chit.type !== 'task') return null;
  const taskChit = hit.chit as Chit<'task'>;
  const task = taskChit.fields.task as TaskFields;
  const feedback = task.pendingRedoFeedback;
  if (typeof feedback !== 'string' || feedback.length === 0) return null;

  try {
    const scope = chitScopeFromPath(corpRoot, hit.path);
    updateChit(corpRoot, scope, 'task', taskChit.id, {
      updatedBy: consumerSlug,
      fields: {
        task: {
          ...task,
          pendingRedoFeedback: null,
        },
      } as never,
    });
  } catch {
    // Best-effort clear. Caller still gets the feedback string;
    // worst case the next consume re-reads the same string and clears
    // then. Not catastrophic.
  }
  return feedback;
}

