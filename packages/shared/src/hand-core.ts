/**
 * Hand mechanics — the core primitives shared by `cc-cli hand`, the
 * daemon's cron task-spawn path (crons.ts), chain walker delta
 * application, and future 1.4 integrations.
 *
 * Pure file-first writes: advance target's Casket, transition the
 * chit's workflowStatus via the state machine, stamp assignee fields,
 * optionally fire an inbox-item notification. No HTTP, no daemon
 * round-trip, no channel broadcast — that's what distinguishes
 * post-1.4 Hand from the pre-1.4 chat-based hand.
 *
 * Callers resolve the target first (by slug directly, or via
 * role-resolver for role-mode). This helper takes an already-resolved
 * slug so it stays agnostic to the resolution strategy.
 */

import { advanceCurrentStep } from './casket.js';
import {
  findChitById,
  updateChit,
  chitScopeFromPath,
} from './chits.js';
import {
  validateTransition,
  TaskTransitionError,
  type TaskTransitionTrigger,
} from './task-state-machine.js';
import { createInboxItem } from './inbox.js';
import type { Chit, TaskFields, TaskWorkflowStatus, InboxItemTier } from './types/chit.js';

export interface HandChitToSlotOpts {
  corpRoot: string;
  /** Member id of the already-resolved target Employee / Partner. */
  targetSlug: string;
  /** Chit id being handed (task, contract, or escalation). */
  chitId: string;
  /** Member id of the hander — stamped on task.handedBy + inbox from. */
  handerId: string;
  /** Optional free-form reason — surfaced in the inbox subject. */
  reason?: string;
  /**
   * Fire a Tier 2 inbox-item on the target. Default true. Callers that
   * want silent delivery (cron backfill, internal re-hand) pass false.
   */
  announce?: boolean;
  /** Inbox tier override. Default 2. Use 3 for founder-visible hands. */
  announceTier?: InboxItemTier;
}

export interface HandChitToSlotResult {
  /** Final workflowStatus on the chit (only set for task chits). */
  finalWorkflowStatus: TaskWorkflowStatus | null;
  /** Whether the inbox-item was fired successfully (false when announce=false OR inbox write failed). */
  announced: boolean;
  /** Errors encountered mid-hand — surfaced for observability; Casket write succeeded if we got here. */
  errors: string[];
}

/**
 * Thrown at the hand boundary when the chit type or state doesn't
 * admit a hand. Distinct from TaskTransitionError so callers can
 * surface a cleaner message for the "wrong chit type" case.
 */
export class HandNotAllowedError extends Error {
  constructor(public readonly chitId: string, public readonly reason: string) {
    super(`cannot hand chit ${chitId}: ${reason}`);
    this.name = 'HandNotAllowedError';
  }
}

const HAND_ELIGIBLE_TYPES = new Set(['task', 'contract', 'escalation']);

export function handChitToSlot(opts: HandChitToSlotOpts): HandChitToSlotResult {
  const { corpRoot, targetSlug, chitId, handerId } = opts;
  const announce = opts.announce ?? true;
  const tier = opts.announceTier ?? 2;
  const errors: string[] = [];

  const hit = findChitById(corpRoot, chitId);
  if (!hit) {
    throw new HandNotAllowedError(chitId, 'chit not found');
  }
  if (!HAND_ELIGIBLE_TYPES.has(hit.chit.type)) {
    throw new HandNotAllowedError(
      chitId,
      `chit type "${hit.chit.type}" is not hand-eligible ` +
        `(hand-eligible: ${[...HAND_ELIGIBLE_TYPES].join(', ')})`,
    );
  }

  // Validate the task state machine BEFORE writing anything. If the
  // transition is illegal (in_progress, blocked, terminal), throw
  // before touching Casket — the previous ordering wrote Casket first,
  // so a rejected transition left the target's Casket pointing at an
  // undispatched task the next session would pick up.
  let taskPlan: { finalWs: TaskWorkflowStatus; isRestamp: boolean } | null = null;
  if (hit.chit.type === 'task') {
    taskPlan = computeTaskHandPlan(hit.chit);
  }

  // Casket write — all validation has passed; safe to commit. Subsequent
  // write failures leave Casket pointing at a real, hand-eligible chit.
  advanceCurrentStep(corpRoot, targetSlug, chitId, handerId);

  let finalWs: TaskWorkflowStatus | null = null;
  if (taskPlan) {
    finalWs = applyTaskHandPlan(corpRoot, hit, taskPlan, targetSlug, handerId);
  }

  let announced = false;
  if (announce) {
    try {
      createInboxItem({
        corpRoot,
        recipient: targetSlug,
        tier,
        from: handerId,
        subject: renderSubject(hit.chit, opts.reason),
        source: 'hand',
        sourceRef: chitId,
      });
      announced = true;
    } catch (err) {
      errors.push(`inbox-item: ${(err as Error).message}`);
    }
  }

  return { finalWorkflowStatus: finalWs, announced, errors };
}

/**
 * Pure validation pass for the task hand — runs the state-machine
 * transitions WITHOUT writing. Throws TaskTransitionError on illegal
 * source state (in_progress, blocked, under_review, terminal). Returns
 * the computed target state + whether this is an idempotent re-stamp
 * (currentWs === 'dispatched').
 *
 * Split out of applyTaskHandPlan so the caller (handChitToSlot) can
 * validate before writing Casket — a rejected transition must not
 * leave the target's Casket pointing at an undispatched chit.
 */
function computeTaskHandPlan(chit: Chit): { finalWs: TaskWorkflowStatus; isRestamp: boolean } {
  const fields = chit.fields as { task: TaskFields };
  const currentWs: TaskWorkflowStatus = fields.task.workflowStatus ?? 'draft';

  if (currentWs === 'dispatched') {
    return { finalWs: 'dispatched', isRestamp: true };
  }

  const triggerPath: TaskTransitionTrigger[] =
    currentWs === 'draft' ? ['assign', 'dispatch']
    : currentWs === 'queued' ? ['dispatch']
    : [];

  if (triggerPath.length === 0) {
    // Non-terminal-but-not-pre-delivery state (in_progress, blocked,
    // under_review) or terminal (completed / rejected / failed /
    // cancelled). The state machine rejects dispatch from all of
    // those; the throw carries the legal-triggers list in its
    // message so the CLI surfaces an actionable error.
    validateTransition(currentWs, 'dispatch', chit.id);
    // Unreachable — validateTransition threw — but type-level
    // exhaustiveness demands a return.
    return { finalWs: currentWs, isRestamp: false };
  }

  let ws: TaskWorkflowStatus = currentWs;
  for (const trigger of triggerPath) {
    ws = validateTransition(ws, trigger, chit.id);
  }
  return { finalWs: ws, isRestamp: false };
}

/**
 * Write-side companion — applies the pre-validated hand plan. Idempotent
 * re-stamps just refresh handedBy/handedAt without touching workflowStatus;
 * real transitions write the new workflowStatus alongside the audit stamp.
 */
function applyTaskHandPlan(
  corpRoot: string,
  hit: { chit: Chit; path: string },
  plan: { finalWs: TaskWorkflowStatus; isRestamp: boolean },
  targetSlug: string,
  handerId: string,
): TaskWorkflowStatus {
  const now = new Date().toISOString();
  const update: Partial<TaskFields> = {
    assignee: targetSlug,
    handedBy: handerId,
    handedAt: now,
  };
  if (!plan.isRestamp) update.workflowStatus = plan.finalWs;
  writeTaskUpdate(corpRoot, hit, update);
  return plan.finalWs;
}

function writeTaskUpdate(
  corpRoot: string,
  hit: { chit: Chit; path: string },
  partial: Partial<TaskFields>,
): void {
  const scope = chitScopeFromPath(corpRoot, hit.path);
  updateChit(corpRoot, scope, 'task', hit.chit.id, {
    fields: { task: partial } as never,
    updatedBy: (partial.handedBy as string) ?? 'system',
  });
}

function renderSubject(chit: Chit, reason?: string): string {
  const title =
    chit.type === 'task'
      ? (chit.fields as { task: TaskFields }).task.title
      : chit.id;
  return reason ? `${title} — handed (${reason})` : `${title} — handed to you`;
}

// Re-export the transition error so callers can branch on it without
// a second import from task-state-machine.
export { TaskTransitionError };
