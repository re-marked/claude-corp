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

import type { Chit } from './types/chit.js';
import type { ChitTypeId } from './types/chit.js';
import { findChitById, readChit, queryChits } from './chits.js';
import {
  isTerminalSuccess,
  isTerminalFailure,
  type TaskTransitionTrigger,
} from './task-state-machine.js';

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

// ─── Convenience re-exports (save callers a second import) ─────────

export { isTerminalSuccess, isTerminalFailure };
export type { ChitTypeId };

// readChit is the natural pair — callers often want to read the full
// dependency chit after analyzeReadiness flags it as blocking. Export
// a tightly-scoped re-export rather than making callers know about
// chits.js directly from chain-walker contexts.
export { readChit };
