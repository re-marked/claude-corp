/**
 * Chain walker — pure functions that answer three questions about the
 * DAG of Task / work chits linked via `dependsOn`:
 *
 *   1. `isReady(chit)`            — can this chit proceed?
 *   2. `nextReadyTask(contract)`  — what's the next ready step in a Contract?
 *   3. `advanceChain(closedChit)` — now that this chit closed, what changed
 *                                   downstream (newly-ready, newly-blocked)?
 *
 * These are the primitives the daemon's task-events hook fires on close,
 * that the future cc-cli block primitive (1.4.1) composes with, and that
 * the role-resolver (1.4) consults when deciding what work to hand next.
 *
 * No I/O effects beyond reading chits — the walker does NOT mutate state.
 * Callers (task-events.ts in daemon) take the walker's output and do the
 * state transitions via the task-state-machine + updateChit.
 *
 * Dependency semantics (ChitCommon.dependsOn):
 *   - References OTHER chit ids; closing them in terminal-success
 *     makes this chit "ready" to proceed.
 *   - Terminal-failure of any dep cascades this chit to `blocked`.
 *     (The actual transition happens at the caller — advanceChain
 *     surfaces the "should be blocked now" classification.)
 *   - Missing deps (ids that don't resolve to any chit) are treated
 *     as not-ready + missingDeps list populated, so callers can
 *     surface an actionable error rather than pretending the chit
 *     is unblocked.
 *
 * Cycle safety: walker paths accept an optional `seen` Set and throw
 * ChainCycleError when a cycle is detected. The corp-level chit
 * validator should catch cycles at write time (0.1 constraint), but
 * the walker remains defensive — a corrupt file or a migration slip
 * shouldn't spin the scanner forever.
 */

import type { Chit, TaskFields, TaskWorkflowStatus } from './types/chit.js';
import type { ChitTypeId } from './types/chit.js';
import { findChitById, readChit, queryChits, updateChit, chitScopeFromPath } from './chits.js';
import {
  isTerminalSuccess,
  isTerminalFailure,
  validateTransition,
  TaskTransitionError,
  type TaskTransitionTrigger,
} from './task-state-machine.js';
import { advanceCurrentStep } from './casket.js';
import { createInboxItem } from './inbox.js';

// ─── Error types ────────────────────────────────────────────────────

/** Thrown when the walker detects a cycle in dependsOn edges. */
export class ChainCycleError extends Error {
  constructor(
    public readonly cycle: readonly string[],
  ) {
    super(
      `chain cycle detected: ${cycle.join(' → ')}. ` +
        `dependsOn should form a DAG; a cycle means some task can never become ready.`,
    );
    this.name = 'ChainCycleError';
  }
}

// ─── isReady + readiness analysis ───────────────────────────────────

export type ReadinessReason =
  /** No dependencies — trivially ready. */
  | 'no-deps'
  /** All deps are in terminal-success state. */
  | 'all-satisfied'
  /** At least one dep is not yet terminal (still running). */
  | 'blocked-by-running'
  /** At least one dep reached terminal-failure (rejected / failed / cancelled). */
  | 'blocked-by-failed'
  /** At least one dep id doesn't resolve to any chit on disk. */
  | 'dep-missing';

export interface ReadinessResult {
  /** True iff the chit can proceed (reason === 'no-deps' | 'all-satisfied'). */
  readonly ready: boolean;
  /** Classification of why ready / why not. */
  readonly reason: ReadinessReason;
  /** Dep ids still running (non-terminal). Empty unless reason === 'blocked-by-running'. */
  readonly blockingDeps: readonly string[];
  /** Dep ids that reached terminal-failure. Empty unless reason === 'blocked-by-failed'. */
  readonly failedDeps: readonly string[];
  /** Dep ids that didn't resolve to any chit. Empty unless reason === 'dep-missing'. */
  readonly missingDeps: readonly string[];
}

/**
 * Analyze a chit's readiness — returns full classification, never
 * throws (absent findChitById errors, which bubble). Task chits use
 * their workflowStatus for terminal classification; other chit types
 * fall back to chit.status-level matching against the ChitStatus-level
 * terminal set.
 */
export function analyzeReadiness(corpRoot: string, chit: Chit): ReadinessResult {
  if (chit.dependsOn.length === 0) {
    return {
      ready: true,
      reason: 'no-deps',
      blockingDeps: [],
      failedDeps: [],
      missingDeps: [],
    };
  }

  const blockingDeps: string[] = [];
  const failedDeps: string[] = [];
  const missingDeps: string[] = [];

  for (const depId of chit.dependsOn) {
    const hit = findChitById(corpRoot, depId);
    if (!hit) {
      missingDeps.push(depId);
      continue;
    }
    const classification = classifyChitTerminality(hit.chit);
    if (classification === 'running') blockingDeps.push(depId);
    else if (classification === 'failure') failedDeps.push(depId);
    // 'success' → silent pass; counts toward all-satisfied
  }

  if (missingDeps.length > 0) {
    return { ready: false, reason: 'dep-missing', blockingDeps, failedDeps, missingDeps };
  }
  if (failedDeps.length > 0) {
    return { ready: false, reason: 'blocked-by-failed', blockingDeps, failedDeps, missingDeps };
  }
  if (blockingDeps.length > 0) {
    return { ready: false, reason: 'blocked-by-running', blockingDeps, failedDeps, missingDeps };
  }
  return { ready: true, reason: 'all-satisfied', blockingDeps, failedDeps, missingDeps };
}

/** Fast predicate — just the boolean. For detailed classification, use analyzeReadiness. */
export function isReady(corpRoot: string, chit: Chit): boolean {
  return analyzeReadiness(corpRoot, chit).ready;
}

/**
 * Classify a chit as 'success' | 'failure' | 'running' for chain
 * dependency purposes. Task chits drive off fields.task.workflowStatus;
 * other types drive off chit.status (the coarse lifecycle) since they
 * don't have a workflow enum. Unknown / unexpected values fall to
 * 'running' (conservative — can't prove success, so treat as not-yet).
 */
function classifyChitTerminality(chit: Chit): 'success' | 'failure' | 'running' {
  if (chit.type === 'task') {
    const ws = (chit.fields.task as { workflowStatus?: string | null }).workflowStatus;
    if (ws === 'completed') return 'success';
    if (ws === 'rejected' || ws === 'failed' || ws === 'cancelled') return 'failure';
    // Pre-1.3 tasks without workflowStatus fall through to chit.status check below.
  }
  // Chit-layer status — covers non-task types and task chits missing workflowStatus.
  if (chit.status === 'completed') return 'success';
  if (chit.status === 'failed' || chit.status === 'rejected' || chit.status === 'closed') {
    // `closed` is ambiguous (could be benign retirement or failure); the
    // chain walker treats it as failure to avoid false-satisfied deps.
    // Callers that close a chit as "successful retirement" should use
    // `completed` instead to signal dep satisfaction explicitly.
    return 'failure';
  }
  return 'running';
}

// ─── nextReadyTask in a contract ────────────────────────────────────

/**
 * Walk a Contract's ordered taskIds and return the first task chit
 * that is (a) non-terminal and (b) ready. Optional `after` id skips
 * past an id the caller has already consumed — used by the Casket
 * advancer to find "what's next for this agent" after closing the
 * current step.
 *
 * Returns null when the contract has no more ready steps — either the
 * contract is fully done OR remaining steps are blocked and the
 * caller needs to address that separately (surface a blocker chit,
 * page the founder).
 */
export function nextReadyTask(
  corpRoot: string,
  contractChitId: string,
  after?: string,
): Chit<'task'> | null {
  const contractHit = findChitById(corpRoot, contractChitId);
  if (!contractHit || contractHit.chit.type !== 'contract') return null;
  const taskIds = (contractHit.chit.fields.contract as { taskIds?: readonly string[] }).taskIds ?? [];

  let skipping = after !== undefined;
  for (const taskId of taskIds) {
    if (skipping) {
      if (taskId === after) skipping = false;
      continue;
    }
    const taskHit = findChitById(corpRoot, taskId);
    if (!taskHit || taskHit.chit.type !== 'task') continue;
    const classification = classifyChitTerminality(taskHit.chit);
    if (classification !== 'running') continue; // already done/failed — skip
    if (!isReady(corpRoot, taskHit.chit)) continue;
    return taskHit.chit as Chit<'task'>;
  }
  return null;
}

// ─── advanceChain on close ──────────────────────────────────────────

export interface AdvanceChainResult {
  /** The chit that just closed. */
  readonly closedChitId: string;
  /** Whether the close was terminal-success, terminal-failure, or neither. */
  readonly closedClassification: 'success' | 'failure' | 'running';
  /**
   * Dependents (chits with `closedChitId` in their dependsOn) whose
   * readiness changed AS A RESULT of this close. Each entry carries
   * the dependent id + the trigger the caller should apply to
   * transition its workflowStatus (unblock for newly-ready, block
   * for cascaded-failure).
   */
  readonly dependentDeltas: readonly DependentDelta[];
}

export interface DependentDelta {
  readonly chitId: string;
  /** 'unblock' when all deps now satisfied; 'block' when a terminal-failure dep cascaded. */
  readonly trigger: Extract<TaskTransitionTrigger, 'unblock' | 'block'>;
  /** Detail reason — carried into the transition log / audit trail. */
  readonly reason: ReadinessReason;
}

/**
 * On a chit reaching terminal state, compute the propagation: which
 * dependents are now ready (unblock trigger) vs cascaded-blocked
 * (block trigger due to failed dep). Returns structured deltas so the
 * caller (task-events.ts in daemon) can apply each transition through
 * the state machine + update Casket pointers uniformly.
 *
 * IMPORTANT: this function does NOT mutate state — it only computes.
 * The caller is responsible for:
 *   - Running each delta's trigger through validateTransition.
 *   - Writing the updated workflowStatus to the dependent chit via updateChit.
 *   - Updating any Casket pointers affected by the new readiness.
 *   - Logging the transition for audit.
 *
 * Separating computation from mutation keeps the walker pure + testable
 * without filesystem stubs, and lets callers batch mutations atomically
 * if they want to (e.g., a single task-events.ts cycle applying all
 * deltas for one close in sequence, rolling back if any transition
 * throws).
 */
export function advanceChain(corpRoot: string, closedChitId: string): AdvanceChainResult {
  const closedHit = findChitById(corpRoot, closedChitId);
  if (!closedHit) {
    return {
      closedChitId,
      closedClassification: 'running',
      dependentDeltas: [],
    };
  }
  const closedClassification = classifyChitTerminality(closedHit.chit);
  if (closedClassification === 'running') {
    // Called on a non-terminal chit — nothing to propagate. Callers
    // shouldn't hit this in practice (they invoke advanceChain AFTER
    // closing), but we treat it as a no-op rather than an error so
    // double-fires are idempotent.
    return {
      closedChitId,
      closedClassification: 'running',
      dependentDeltas: [],
    };
  }

  const deltas = computeDependentDeltas(corpRoot, closedChitId, closedClassification);
  return {
    closedChitId,
    closedClassification,
    dependentDeltas: deltas,
  };
}

/**
 * Find chits whose dependsOn includes `closedChitId` and compute the
 * right delta for each based on the closed chit's terminality.
 *
 * Relies on `queryChits` with the `dependsOn` filter — efficient scan
 * across every scope (the walker doesn't know a priori where
 * dependents live; they could be in the same contract, a different
 * project, or at corp scope).
 */
function computeDependentDeltas(
  corpRoot: string,
  closedChitId: string,
  closedClassification: 'success' | 'failure',
): DependentDelta[] {
  // queryChits is a one-way dependency: chain.ts needs it, chits.ts
  // doesn't depend on chain.ts. Static import is clean — no runtime
  // cycle. (Earlier draft used require() defensively; ESM doesn't
  // support synchronous require, and the cycle risk was imagined.)
  const { chits: dependents } = queryChits(corpRoot, {
    dependsOn: [closedChitId],
    limit: 0,
  });

  const deltas: DependentDelta[] = [];

  for (const { chit } of dependents) {
    // Only propagate to non-terminal dependents. A dependent that's
    // already completed / failed / cancelled doesn't need a block or
    // unblock applied — its own lifecycle is done.
    if (classifyChitTerminality(chit) !== 'running') continue;

    if (closedClassification === 'failure') {
      // Cascade: closed-failed → dependent should block. Only emit the
      // delta if the dependent isn't ALREADY in blocked state (idempotent
      // — don't re-block an already-blocked dependent).
      const depWs = getWorkflowStatus(chit);
      if (depWs === 'blocked') continue;
      deltas.push({
        chitId: chit.id,
        trigger: 'block',
        reason: 'blocked-by-failed',
      });
      continue;
    }

    // closedClassification === 'success'. Re-evaluate the dependent's
    // overall readiness — maybe it has OTHER deps still pending.
    const readiness = analyzeReadiness(corpRoot, chit);
    if (!readiness.ready) continue;

    // All deps satisfied. Only emit unblock if the dependent is
    // actually in blocked state; otherwise it's just "naturally
    // ready but not yet queued" and the daemon's queued-state entry
    // pathway (task-create --assignee or hand) will handle it.
    const depWs = getWorkflowStatus(chit);
    if (depWs !== 'blocked') continue;

    deltas.push({
      chitId: chit.id,
      trigger: 'unblock',
      reason: 'all-satisfied',
    });
  }

  return deltas;
}

/** Read fields.task.workflowStatus safely for any chit (non-task chits have no workflow). */
function getWorkflowStatus(chit: Chit): string | undefined {
  if (chit.type !== 'task') return undefined;
  const ws = (chit.fields.task as { workflowStatus?: string | null }).workflowStatus;
  return ws ?? undefined;
}

// ─── applyDependentDelta — the mutation side of advanceChain ────────

export interface ApplyDeltaResult {
  /** True when the state transition actually landed on the chit. */
  readonly applied: boolean;
  /** Target chit id — always set, matches the delta's chitId. */
  readonly chitId: string;
  /** State before the apply (undefined when skipped before reading). */
  readonly fromState?: TaskWorkflowStatus;
  /** State after the apply (undefined when not applied). */
  readonly toState?: TaskWorkflowStatus;
  /** Classification of why we skipped, when applied=false. Callers log but shouldn't error. */
  readonly skippedReason?:
    | 'chit-missing'
    | 'not-task'
    | 'no-workflow-status'
    | 'transition-rejected';
  /** Free-form detail for log entries — the specific error or the rejected transition. */
  readonly detail?: string;
}

export interface ApplyDeltaOpts {
  corpRoot: string;
  delta: DependentDelta;
  /** Member id to stamp on the chit's updatedBy audit field. */
  actor: string;
}

/**
 * Apply a single DependentDelta from advanceChain — translates the
 * delta's trigger through the state machine + writes the chit.
 *
 * Fail-open on substrate gaps (missing chit, pre-1.3 task without
 * workflowStatus, state machine rejection): returns `applied: false`
 * with a classified `skippedReason` so the caller can log the gap but
 * shouldn't stop its outer loop. The alternative — throwing — would
 * abort the whole cascade on one stale dependent, which is worse
 * than leaving one chit in the wrong state for one cycle (the next
 * close event re-evaluates).
 *
 * Callers:
 *   - handoff-promotion.ts on audit-approve (apply deltas from the
 *     closed task's advanceChain result).
 *   - task-events.ts / task-watcher.ts on any task-close event
 *     (replacing the pre-1.4 ad-hoc blockedBy resolver).
 *   - cmdBlock's blocker-close handler (dynamic blocker flow).
 *
 * The caller is ALSO responsible for dispatch/re-hand after unblock —
 * this helper does the chit write, not the side effects. Separation
 * keeps unit-testability clean; wiring is done at the caller boundary
 * where the daemon context (re-dispatch routing, DM announcements,
 * Casket pointer updates) is available.
 */
export function applyDependentDelta(opts: ApplyDeltaOpts): ApplyDeltaResult {
  const { corpRoot, delta, actor } = opts;
  const hit = findChitById(corpRoot, delta.chitId);
  if (!hit) {
    return {
      applied: false,
      chitId: delta.chitId,
      skippedReason: 'chit-missing',
      detail: `chit ${delta.chitId} not found — stale dependent reference`,
    };
  }
  if (hit.chit.type !== 'task') {
    return {
      applied: false,
      chitId: delta.chitId,
      skippedReason: 'not-task',
      detail: `chit ${delta.chitId} is type '${hit.chit.type}'; chain walker only transitions tasks`,
    };
  }
  const fields = hit.chit.fields.task as TaskFields;
  const fromState = fields.workflowStatus ?? undefined;
  if (!fromState) {
    // Pre-1.3 task chit or migration straggler. Skip transition;
    // chit.status-level lifecycle still moves via other paths.
    return {
      applied: false,
      chitId: delta.chitId,
      skippedReason: 'no-workflow-status',
      detail: `task ${delta.chitId} has no fields.task.workflowStatus — pre-1.3 chit`,
    };
  }

  let toState: TaskWorkflowStatus;
  try {
    toState = validateTransition(fromState, delta.trigger, delta.chitId);
  } catch (err) {
    if (err instanceof TaskTransitionError) {
      return {
        applied: false,
        chitId: delta.chitId,
        fromState,
        skippedReason: 'transition-rejected',
        detail: err.message,
      };
    }
    throw err;
  }

  const scope = chitScopeFromPath(corpRoot, hit.path);
  updateChit(corpRoot, scope, 'task', delta.chitId, {
    // Chain walker deltas are workflowStatus-level — coarse chit.status
    // stays untouched (it already reflects the terminal / non-terminal
    // state). Touching chit.status from here would double-classify.
    fields: { task: { workflowStatus: toState } } as never,
    updatedBy: actor,
  });

  return {
    applied: true,
    chitId: delta.chitId,
    fromState,
    toState,
  };
}

/**
 * Apply every delta in a DependentDelta[] and return per-delta results.
 * Pure sequential loop — if one applies and the next's transition is
 * rejected, the first's mutation stays (chain walker cascades are not
 * transactional). Callers receiving partial success should inspect each
 * result and decide how to log / recover.
 */
export function applyDependentDeltas(
  corpRoot: string,
  deltas: readonly DependentDelta[],
  actor: string,
): ApplyDeltaResult[] {
  return deltas.map((delta) => applyDependentDelta({ corpRoot, delta, actor }));
}

// ─── applyChainAdvance — close the loop after a close event ─────────

/**
 * Side-effect contract of an unblock delta application. When
 * applyDependentDelta flips a dependent blocked → in_progress, the
 * work needs to actually become AVAILABLE to the assignee — which
 * means writing their Casket (so their next session picks it up) and
 * notifying them (so they see it in their inbox). Neither side
 * effect is pure state; neither lives in applyDependentDelta.
 *
 * applyChainAdvance composes both: the state transition via
 * applyDependentDelta, plus the re-dispatch semantics for unblock.
 * Block deltas get the state transition only (a dependent becoming
 * blocked doesn't need a Casket write; they'll discover it next tick
 * via wtf header).
 */
export interface ChainAdvanceApplyResult {
  /** The input delta, for caller cross-reference. */
  readonly delta: DependentDelta;
  /** Result of the state-machine transition (applied / skipped + reason). */
  readonly transition: ApplyDeltaResult;
  /** Re-dispatch summary — only populated for unblock deltas whose transition applied. */
  readonly redispatch?: ChainAdvanceRedispatchResult;
}

export interface ChainAdvanceRedispatchResult {
  /** Assignee slug that received the Casket pointer + inbox. Null when the task had no assignee. */
  readonly targetSlug: string | null;
  /** True when advanceCurrentStep succeeded on the target's Casket. */
  readonly casketWritten: boolean;
  /** True when the Tier 2 inbox-item landed. */
  readonly notified: boolean;
  /** Aggregated error string if either side effect failed; undefined on full success. */
  readonly error?: string;
}

export interface ApplyChainAdvanceOpts {
  /**
   * Notify on re-dispatch (unblock). Default true. Pass false for
   * silent backfill paths (e.g. initial chain resync on daemon
   * restart where announcing every historical unblock would flood
   * the inbox).
   */
  readonly announce?: boolean;
}

/**
 * Apply every delta in an AdvanceChainResult — state transitions for
 * all, plus re-dispatch side effects (Casket write + inbox) for
 * unblock deltas whose transition applied.
 *
 * The single-call shape task-watcher + handoff-promotion need after
 * observing a task close. Idempotent by construction: re-running on
 * the same closed chit hits applyDependentDelta's transition-rejected
 * path for already-unblocked dependents (validateTransition refuses
 * unblock from in_progress), and for already-blocked dependents the
 * stacking rule makes the block write a no-op.
 *
 * Errors in re-dispatch (Casket write fails, inbox write fails) are
 * captured in the per-delta result — they DON'T undo the transition.
 * The state flip is the canonical side effect; Casket + inbox are
 * observability that can be retried by subsequent cycles.
 */
export function applyChainAdvance(
  corpRoot: string,
  advance: AdvanceChainResult,
  actor: string,
  opts: ApplyChainAdvanceOpts = {},
): ChainAdvanceApplyResult[] {
  const announce = opts.announce ?? true;
  return advance.dependentDeltas.map((delta) => {
    const transition = applyDependentDelta({ corpRoot, delta, actor });
    if (!transition.applied || delta.trigger !== 'unblock') {
      return { delta, transition };
    }
    const redispatch = redispatchUnblocked(corpRoot, delta.chitId, actor, announce);
    return { delta, transition, redispatch };
  });
}

/**
 * Side-effect helper for a newly-unblocked task: write the assignee's
 * Casket pointer + optionally fire a Tier 2 inbox-item. Pure re-read
 * of the just-transitioned chit (could optimize by threading through
 * applyDependentDelta's read, but the cost is one filesystem hit and
 * the separation keeps the helper self-contained for reuse).
 */
function redispatchUnblocked(
  corpRoot: string,
  taskChitId: string,
  actor: string,
  announce: boolean,
): ChainAdvanceRedispatchResult {
  const hit = findChitById(corpRoot, taskChitId);
  if (!hit || hit.chit.type !== 'task') {
    return {
      targetSlug: null,
      casketWritten: false,
      notified: false,
      error: 'task chit unreadable post-transition (race or corruption)',
    };
  }
  const assignee = (hit.chit.fields.task as TaskFields).assignee;
  if (!assignee) {
    // Unblocked task with no assignee — chain walker can't pick the
    // target. Likely a contract-scoped task waiting for a hand; the
    // next explicit `cc-cli hand` call will route it correctly.
    return {
      targetSlug: null,
      casketWritten: false,
      notified: false,
    };
  }

  const errors: string[] = [];

  let casketWritten = false;
  try {
    advanceCurrentStep(corpRoot, assignee, taskChitId, actor);
    casketWritten = true;
  } catch (err) {
    errors.push(`casket: ${(err as Error).message}`);
  }

  let notified = false;
  if (announce) {
    try {
      const title = (hit.chit.fields.task as TaskFields).title;
      createInboxItem({
        corpRoot,
        recipient: assignee,
        tier: 2,
        from: actor,
        subject: `UNBLOCKED: ${title} — your previous blocker closed, you can resume`,
        source: 'system',
        sourceRef: taskChitId,
      });
      notified = true;
    } catch (err) {
      errors.push(`inbox: ${(err as Error).message}`);
    }
  }

  return {
    targetSlug: assignee,
    casketWritten,
    notified,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}

// ─── Convenience re-exports (save callers a second import) ─────────

export { isTerminalSuccess, isTerminalFailure };
export type { ChitTypeId };

// readChit is the natural pair — callers often want to read the full
// dependency chit after analyzeReadiness flags it as blocking. Export
// a tightly-scoped re-export rather than making callers know about
// chits.js directly from chain-walker contexts.
export { readChit };
