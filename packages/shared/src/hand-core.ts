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

  // Casket write first — intermediate failures leave the Casket on a
  // real (if not-yet-dispatched) chit rather than a stale id.
  advanceCurrentStep(corpRoot, targetSlug, chitId, handerId);

  let finalWs: TaskWorkflowStatus | null = null;
  if (hit.chit.type === 'task') {
    finalWs = transitionTaskToDispatched(corpRoot, hit, targetSlug, handerId);
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
 * Task-specific transition — two-phase when source is `draft`
 * (draft → assign → queued → dispatch → dispatched), one-phase from
 * `queued`, no-op at `dispatched`. Anything else throws
 * TaskTransitionError with the legal-triggers list in its message.
 */
function transitionTaskToDispatched(
  corpRoot: string,
  hit: { chit: Chit; path: string },
  targetSlug: string,
  handerId: string,
): TaskWorkflowStatus {
  const fields = hit.chit.fields as { task: TaskFields };
  const currentWs: TaskWorkflowStatus = fields.task.workflowStatus ?? 'draft';
  const now = new Date().toISOString();

  if (currentWs === 'dispatched') {
    // Idempotent re-hand — re-stamp audit trail without changing state.
    writeTaskUpdate(corpRoot, hit, { assignee: targetSlug, handedBy: handerId, handedAt: now });
    return 'dispatched';
  }

  const triggerPath: TaskTransitionTrigger[] =
    currentWs === 'draft' ? ['assign', 'dispatch']
    : currentWs === 'queued' ? ['dispatch']
    : [];

  if (triggerPath.length === 0) {
    // Non-terminal-but-not-pre-delivery state (in_progress, blocked,
    // under_review). Use the state machine's rejection so the error
    // message carries the legal-triggers list.
    validateTransition(currentWs, 'dispatch', hit.chit.id);
    // Unreachable — validateTransition throws for non-legal pairs —
    // but type-level exhaustiveness.
    return currentWs;
  }

  let ws: TaskWorkflowStatus = currentWs;
  for (const trigger of triggerPath) {
    ws = validateTransition(ws, trigger, hit.chit.id);
  }

  writeTaskUpdate(corpRoot, hit, {
    workflowStatus: ws,
    assignee: targetSlug,
    handedBy: handerId,
    handedAt: now,
  });
  return ws;
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
