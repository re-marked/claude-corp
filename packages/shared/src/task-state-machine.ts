/**
 * Task state machine — the mechanical enforcement layer for the
 * 11-state TaskWorkflowStatus enum (REFACTOR.md Project 1.3, plus
 * `clearance` added in Project 1.12 for the Pressman merge lane).
 *
 * BEFORE this layer, workflowStatus was advisory: a string field
 * callers set however they felt. If task-events.ts flipped
 * `in_progress` → `completed` without an audit, the chain walker still
 * advanced. Ghost transitions were invisible until they bit downstream.
 *
 * AFTER this layer, every mutation of workflowStatus must name the
 * TRIGGER that caused it (assign, dispatch, claim, block, handoff,
 * audit-approve, audit-block, fail, cancel, reopen, ...) and the
 * (from, trigger) pair must resolve to a single deterministic `to`
 * state. Illegal transitions throw TaskTransitionError at the CLI /
 * daemon boundary — caller must fix their logic or use the legitimate
 * escape-hatch trigger (cancel, fail).
 *
 * Pure module — no I/O, no side effects. The functions here are
 * consumed by:
 *   - packages/daemon/src/task-events.ts — lifecycle events
 *   - packages/daemon/src/dispatch.ts    — dispatched → in_progress
 *   - packages/cli/src/commands/audit.ts — under_review → completed | in_progress
 *   - packages/cli/src/commands/done.ts  — in_progress → under_review
 *   - packages/shared/src/chain.ts       — blocked ⇄ in_progress cascade
 *
 * Design note: we key the rules on (from, trigger) rather than just
 * (from, to) so the same destination can be reached via different
 * triggers with different preconditions. For example, both
 * `audit-approve` and `chain-consume` produce in_progress → completed,
 * but only one is legal per caller context. Naming the trigger also
 * makes the transition log (when we wire one) self-explanatory:
 * "queued -[dispatch]-> dispatched" reads better than just
 * "queued → dispatched."
 */

import type { TaskWorkflowStatus } from './types/chit.js';

/** Every cause of a state transition, enumerated for rule dispatch + audit logs. */
export type TaskTransitionTrigger =
  /** `cc-cli task create --assignee` / `cc-cli hand` sets assignee on a draft. */
  | 'assign'
  /** Daemon delivers the task to the assignee's Casket. */
  | 'dispatch'
  /** Agent's session touches the task (first tool-use observed OR explicit claim). */
  | 'claim'
  /** `cc-cli block` files a blocker chit against this task. */
  | 'block'
  /**
   * All blocker chits reached terminal-success; task resumes.
   * Chain walker fires this automatically on blocker close (1.4.1).
   */
  | 'unblock'
  /** `cc-cli done` — agent declares completion, audit-gate pending. */
  | 'handoff'
  /** Audit gate approved the handoff; chain walker can consume this task. */
  | 'audit-approve'
  /**
   * Audit gate blocked the handoff (acceptance criteria not met, tier-3
   * inbox unresolved, evidence missing). Task returns to in_progress so
   * the agent can address the gap and re-`done`.
   */
  | 'audit-block'
  /** Warden / founder rejected — distinct from audit-block in that it's a deliberate review decision, not a gate miss. */
  | 'reject'
  /** Rejected task re-opened for another pass (founder-initiated). */
  | 'reopen'
  /**
   * Project 1.12 — Pressman finalized the merge: the clearance-
   * submission landed on origin and the task lifecycle terminates
   * successfully. Distinct from `audit-approve` (which is the
   * agent-side gate that fires `enterClearance` in the first place);
   * `merge` is the substrate-side completion stamp.
   */
  | 'merge'
  /**
   * Circuit-breaker trip (1.10), repeated audit blocks, or explicit
   * failure. Terminal-failure — downstream tasks cascade to blocked.
   */
  | 'fail'
  /** Founder-only `cc-cli task cancel` — explicit escape hatch, terminal. */
  | 'cancel';

/** Terminal states — no outgoing legitimate transitions except `reopen` from rejected. */
export const TERMINAL_STATES: readonly TaskWorkflowStatus[] = [
  'completed',
  'rejected',
  'failed',
  'cancelled',
] as const;

/** Terminal-SUCCESS states — chain walker treats these as "dependency satisfied." */
export const TERMINAL_SUCCESS_STATES: readonly TaskWorkflowStatus[] = ['completed'] as const;

/**
 * Terminal-FAILURE states — chain walker cascades "blocked (reason=failed-dep)"
 * to dependents when any of these land on a Task in their depends_on.
 */
export const TERMINAL_FAILURE_STATES: readonly TaskWorkflowStatus[] = [
  'rejected',
  'failed',
  'cancelled',
] as const;

/** The 11-state universe. Derived from the type for single-source-of-truth. */
export const ALL_STATES: readonly TaskWorkflowStatus[] = [
  'draft',
  'queued',
  'dispatched',
  'in_progress',
  'blocked',
  'under_review',
  'clearance',
  'completed',
  'rejected',
  'failed',
  'cancelled',
] as const;

/**
 * The transition table — the complete (from, trigger) → to map. Any
 * pair not in this table is an ILLEGAL transition and validateTransition
 * throws.
 *
 * The shape is two-level: `RULES[from][trigger] = to`. Nested record
 * lets us answer both "what triggers are legal from state X?" and
 * "what would trigger T do from state X?" without extra structure.
 *
 * Triggers with dual-source semantics (e.g., `fail` can happen from
 * most states, `cancel` from any non-terminal) are expanded explicitly
 * rather than wildcarded — makes the table exhaustive and greppable.
 */
export const TRANSITION_RULES: {
  readonly [From in TaskWorkflowStatus]?: {
    readonly [T in TaskTransitionTrigger]?: TaskWorkflowStatus;
  };
} = {
  draft: {
    assign: 'queued',
    cancel: 'cancelled',
    fail: 'failed',
  },
  queued: {
    dispatch: 'dispatched',
    // Re-assign while queued is effectively a no-op transition, but we
    // allow it explicitly so hand-revocation paths can flip back to
    // draft by passing a null assignee (caller's responsibility to clear
    // the assignee field in the same mutation).
    assign: 'queued',
    // Cascade from a failed upstream dep: even though this task hasn't
    // been dispatched yet, a failed dependency means the chain is
    // broken — flip to blocked so the founder can see a stalled chain
    // instead of a queue item silently sitting on a dead dep. Without
    // this rule, computeDependentDeltas's block delta on a queued
    // dependent would get rejected by the state machine and the chain
    // walker would silently fail to propagate the failure.
    block: 'blocked',
    cancel: 'cancelled',
    fail: 'failed',
  },
  dispatched: {
    claim: 'in_progress',
    // Blocker filed before the agent even touched the task — rare but
    // legal when the assignee discovers a dep at session start.
    block: 'blocked',
    cancel: 'cancelled',
    fail: 'failed',
  },
  in_progress: {
    block: 'blocked',
    handoff: 'under_review',
    reject: 'rejected',
    fail: 'failed',
    cancel: 'cancelled',
  },
  blocked: {
    // Blocker closed; resume work. Chain walker fires this trigger
    // after verifying every depends_on has reached terminal-success.
    unblock: 'in_progress',
    // Stacking blockers: additional blocker filed while already blocked
    // is still `block` — no state change, but we preserve the trigger
    // legality so the transition log captures the additional blocker.
    block: 'blocked',
    fail: 'failed',
    cancel: 'cancelled',
  },
  under_review: {
    'audit-approve': 'completed',
    'audit-block': 'in_progress',
    reject: 'rejected',
    fail: 'failed',
    cancel: 'cancelled',
  },
  // Project 1.12 — once audit-approve fires `enterClearance`, the task
  // sits in `clearance` until the Pressman lane resolves it. Codex P1
  // round 4 on PR #204: this row was missing entirely, so any
  // validateTransition call from a clearance-state task threw — fail/
  // cancel/recovery flows from the clearinghouse couldn't complete.
  clearance: {
    // Pressman finalized merge → terminal success. Distinct trigger
    // from audit-approve; merge is substrate-side, audit-approve is
    // agent-side gate.
    merge: 'completed',
    // Clearinghouse blocker (rebase conflict, hook reject, test
    // failure routed to author) → task returns to in_progress so
    // the author can re-work + re-handoff. Mirrors under_review's
    // audit-block transition shape.
    block: 'blocked',
    // Pressman terminal-fail (push race exhausted retries, fatal
    // git/network error, attribution-routing to engineering-lead
    // exhausted) → terminal failure; downstream tasks cascade.
    fail: 'failed',
    // Founder cancel — same escape hatch as every non-terminal state.
    cancel: 'cancelled',
  },
  // Terminal-success is truly terminal — no outgoing legal transitions.
  // Future re-open-from-completed would require a new trigger
  // (`rework`?) with explicit founder consent. Not v1.
  completed: {},
  rejected: {
    // The ONLY legal exit from rejected: explicit reopen by founder
    // (or Warden in 2.4). Returns to in_progress so the agent can
    // fix what was rejected and re-handoff.
    reopen: 'in_progress',
  },
  failed: {},
  cancelled: {},
} as const;

/** Raised when a caller attempts a transition not in TRANSITION_RULES. */
export class TaskTransitionError extends Error {
  constructor(
    public readonly from: TaskWorkflowStatus,
    public readonly trigger: TaskTransitionTrigger,
    public readonly taskId?: string,
  ) {
    const legal = legalTriggersFrom(from);
    const context = taskId ? ` (task ${taskId})` : '';
    const legalList = legal.length > 0 ? legal.join(', ') : '<terminal — no legal transitions>';
    super(
      `illegal task transition${context}: from='${from}' trigger='${trigger}'. ` +
        `Legal triggers from '${from}': ${legalList}.`,
    );
    this.name = 'TaskTransitionError';
  }
}

// ─── Query helpers ──────────────────────────────────────────────────

/** True if the state is any of the four terminal states (no further legal transitions without re-open). */
export function isTerminal(state: TaskWorkflowStatus): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** True if the state is terminal-success (completed). Chain walker satisfaction predicate. */
export function isTerminalSuccess(state: TaskWorkflowStatus): boolean {
  return (TERMINAL_SUCCESS_STATES as readonly string[]).includes(state);
}

/**
 * True if the state is a terminal-failure (rejected, failed, cancelled).
 * Dependents of a task in one of these states cascade to blocked.
 */
export function isTerminalFailure(state: TaskWorkflowStatus): boolean {
  return (TERMINAL_FAILURE_STATES as readonly string[]).includes(state);
}

/**
 * Pick the correct initial state for a freshly-created task:
 *   - no assignee       → 'draft'
 *   - assignee supplied → 'queued'
 *
 * Matches the draft/queued split in REFACTOR.md 1.3 (assignee presence
 * is what distinguishes the two pre-dispatch states; actual dispatch
 * is a separate event the daemon fires).
 */
export function initialState(hasAssignee: boolean): TaskWorkflowStatus {
  return hasAssignee ? 'queued' : 'draft';
}

/**
 * Enumerate the legal triggers from a given state. Useful for:
 *   - UI: render only the actions that would succeed
 *   - docs: auto-generate the transition matrix
 *   - error messages: tell callers what they CAN do from where they are
 */
export function legalTriggersFrom(state: TaskWorkflowStatus): TaskTransitionTrigger[] {
  const rules = TRANSITION_RULES[state];
  if (!rules) return [];
  return Object.keys(rules) as TaskTransitionTrigger[];
}

/**
 * Resolve a (from, trigger) to its destination state, or undefined if
 * the pair is illegal. Non-throwing twin of validateTransition — use
 * when you want to check legality without exception control flow.
 */
export function resolveTransition(
  from: TaskWorkflowStatus,
  trigger: TaskTransitionTrigger,
): TaskWorkflowStatus | undefined {
  return TRANSITION_RULES[from]?.[trigger];
}

/**
 * Validate + resolve a transition. Returns the destination state on
 * success, throws TaskTransitionError on an illegal pair. Canonical
 * entry point for daemon / audit / done callers — they invoke this,
 * catch the error at their edge if needed, and pass the result to
 * updateChit as the new workflowStatus.
 *
 * Pass the task id when available so the thrown error carries context
 * (which task failed to transition, useful in aggregated logs).
 */
export function validateTransition(
  from: TaskWorkflowStatus,
  trigger: TaskTransitionTrigger,
  taskId?: string,
): TaskWorkflowStatus {
  const to = resolveTransition(from, trigger);
  if (to === undefined) {
    throw new TaskTransitionError(from, trigger, taskId);
  }
  return to;
}
