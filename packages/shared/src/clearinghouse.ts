/**
 * Clearinghouse helpers (Project 1.12) — pure-where-possible
 * substrate the Pressman/Editor agents and the cc-cli surface
 * compose against. Three responsibilities:
 *
 * 1. **Priority scoring** (pure). Gas Town's adapted formula —
 *    queue age + priority bias + retry penalty + underlying-PR age.
 *    Decoupled from chit storage so tests pass plain literals.
 *
 * 2. **Lock lifecycle.** Read/claim/release the singleton
 *    `clearinghouse-lock.json` corp-scope file. Single-daemon-process
 *    means in-memory mutex handles atomicity at the call site; the
 *    JSON file persists state across daemon restarts so stale-lock
 *    detection (next commit) can find dead-holder locks after a
 *    crash.
 *
 * 3. **State cascade.** When a clearance-submission flips to a
 *    terminal status, the linked task (and possibly contract)
 *    workflow status needs to advance in lockstep. Helpers here own
 *    the multi-chit transition so callers don't manage three
 *    interdependent updates by hand.
 *
 * ### Why a JSON lock instead of a chit type
 *
 * The lock is a singleton with a small structured state — exactly
 * the shape `bacteria-paused.json` already established. Chit types
 * are for work records (one per occurrence, audit history matters);
 * runtime daemon state lives in plain JSON. If we ever want richer
 * lock history (who held it for how long, contention metrics), can
 * promote to a chit type then.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { queryChits, updateChit, findChitById, chitScopeFromPath } from './chits.js';
import { CLEARINGHOUSE_LOCK_JSON } from './constants.js';
import type { Chit, TaskWorkflowStatus } from './types/chit.js';

// ─── Priority scoring (pure) ─────────────────────────────────────────

/**
 * Subset of clearance-submission state needed for scoring. Decoupled
 * from the full chit shape so callers can pass plain literals + tests
 * stay readable.
 */
export interface ScorableSubmission {
  /** ISO timestamp the submission entered the queue. */
  submittedAt: string;
  /** Snapshotted from the task at submit time. */
  priority: 'critical' | 'high' | 'normal' | 'low';
  /** Phase-2 mechanical-retry counter. */
  retryCount: number;
  /**
   * Optional secondary age signal — ISO timestamp of the underlying
   * task's createdAt. A task that's been waiting through review for
   * days deserves a small bump beyond its submission age. Falls
   * back to 0 contribution when absent (e.g. task lookup failed).
   */
  taskCreatedAt?: string;
}

const PRIORITY_LEVEL: Record<ScorableSubmission['priority'], number> = {
  critical: 1,
  high: 2,
  normal: 3,
  low: 4,
};

/**
 * Adapted from Gas Town's convoy formula. Higher score → processed
 * sooner. Anti-thrashing via the retry-penalty cap (-300 max) so a
 * frequently-failing PR gets deprioritized but never permanently
 * buried below fresh work.
 *
 * Components:
 *   - Base 1000 — keeps all real submissions positive even with
 *     a heavy retry penalty.
 *   - queue_age × 10/hr — anti-starvation as the submission ages
 *     in the lane.
 *   - (4 - priorityLevel) × 100 — critical=300, high=200, normal=100,
 *     low=0. Big enough to dominate small age differences.
 *   - -min(retries × 50, 300) — capped so 6 retries == 12 retries
 *     for scoring purposes.
 *   - pr_age × 1/hr — small bump for underlying task age. Smaller
 *     coefficient than queue_age because it can be much larger
 *     (task lifetime can be days while submission lifetime is
 *     usually minutes-to-hours).
 *
 * Returns 0 for completely-malformed inputs (defensive — corrupted
 * scores shouldn't crash the queue ordering).
 */
export function scoreSubmission(s: ScorableSubmission, now: Date): number {
  let score = 1000;

  const submittedMs = Date.parse(s.submittedAt);
  if (Number.isFinite(submittedMs)) {
    const queueAgeHours = Math.max(0, (now.getTime() - submittedMs) / (3600 * 1000));
    score += queueAgeHours * 10;
  }

  const level = PRIORITY_LEVEL[s.priority] ?? 3; // default to 'normal' on unknown
  score += (4 - level) * 100;

  const retries = Math.max(0, Math.floor(s.retryCount));
  score -= Math.min(retries * 50, 300);

  if (s.taskCreatedAt) {
    const taskMs = Date.parse(s.taskCreatedAt);
    if (Number.isFinite(taskMs)) {
      const prAgeHours = Math.max(0, (now.getTime() - taskMs) / (3600 * 1000));
      score += prAgeHours * 1;
    }
  }

  return score;
}

// ─── Queue ordering ──────────────────────────────────────────────────

export interface QueueEntry {
  readonly chit: Chit<'clearance-submission'>;
  readonly score: number;
}

/**
 * Read all clearance-submissions in `queued` state and return them
 * scored + sorted descending. The first entry is what Pressman
 * should claim next. Submissions in `processing`/`conflict`/etc are
 * excluded — only freshly-queued work is candidate for claim.
 */
export function rankQueue(corpRoot: string, now: Date = new Date()): ReadonlyArray<QueueEntry> {
  let result: ReturnType<typeof queryChits<'clearance-submission'>>;
  try {
    result = queryChits<'clearance-submission'>(corpRoot, {
      types: ['clearance-submission'],
      scopes: ['corp'],
      statuses: ['active'],
    });
  } catch {
    return [];
  }

  const entries: QueueEntry[] = [];
  for (const c of result.chits) {
    const f = c.chit.fields['clearance-submission'];
    if (f.submissionStatus !== 'queued') continue;
    const score = scoreSubmission(
      {
        submittedAt: f.submittedAt,
        priority: f.priority,
        retryCount: f.retryCount,
        // taskCreatedAt resolution is best-effort; skip the lookup
        // for now (callers can pass enrichments later if needed).
      },
      now,
    );
    entries.push({ chit: c.chit, score });
  }
  entries.sort((a, b) => b.score - a.score);
  return entries;
}

// ─── Lock lifecycle ──────────────────────────────────────────────────

export interface ClearinghouseLockState {
  /** Pressman Member.id currently holding the lock. Null when free. */
  heldBy: string | null;
  /** ISO timestamp of the claim. Null when free. */
  claimedAt: string | null;
  /** Submission chit id being processed. Null when free. */
  submissionId: string | null;
}

const FREE_LOCK: ClearinghouseLockState = {
  heldBy: null,
  claimedAt: null,
  submissionId: null,
};

/**
 * Read the lock file. Returns the free-lock state when the file
 * doesn't exist (no Pressman has ever claimed) or is corrupt
 * (defense in depth — a bad lock file shouldn't permanently block
 * the lane; chit-hygiene will surface the corruption separately).
 */
export function readClearinghouseLock(corpRoot: string): ClearinghouseLockState {
  const path = join(corpRoot, CLEARINGHOUSE_LOCK_JSON);
  if (!existsSync(path)) return { ...FREE_LOCK };
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ClearinghouseLockState>;
    if (!parsed || typeof parsed !== 'object') return { ...FREE_LOCK };
    return {
      heldBy: typeof parsed.heldBy === 'string' ? parsed.heldBy : null,
      claimedAt: typeof parsed.claimedAt === 'string' ? parsed.claimedAt : null,
      submissionId: typeof parsed.submissionId === 'string' ? parsed.submissionId : null,
    };
  } catch {
    return { ...FREE_LOCK };
  }
}

/**
 * Atomic write via temp-file + rename. POSIX rename is atomic;
 * Windows rename is atomic when target doesn't exist (we tolerate
 * the small race when overwriting because the in-memory mutex at
 * the daemon level handles concurrent writers).
 */
function writeLockState(corpRoot: string, state: ClearinghouseLockState): void {
  const path = join(corpRoot, CLEARINGHOUSE_LOCK_JSON);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}

export interface ClaimLockOpts {
  corpRoot: string;
  /** Pressman Member.id requesting the lock. */
  slug: string;
  /** Clearance-submission chit id this claim is for. */
  submissionId: string;
}

/**
 * Attempt to claim the lock for the given Pressman + submission.
 * Returns true on success, false if already held by someone else.
 * Idempotent: if the same slug already holds the lock for the same
 * submission, returns true (treats it as a no-op success).
 *
 * Atomicity note: this function relies on the caller having a
 * daemon-side mutex around the read-then-write sequence. Within the
 * single-daemon-process model that's all we need; multi-process
 * scenarios would require fcntl/flock layering on top.
 */
export function claimClearinghouseLock(opts: ClaimLockOpts): boolean {
  const current = readClearinghouseLock(opts.corpRoot);
  if (current.heldBy && current.heldBy !== opts.slug) return false;
  if (current.heldBy === opts.slug && current.submissionId === opts.submissionId) return true;
  writeLockState(opts.corpRoot, {
    heldBy: opts.slug,
    claimedAt: new Date().toISOString(),
    submissionId: opts.submissionId,
  });
  return true;
}

export interface ReleaseLockOpts {
  corpRoot: string;
  /** Pressman Member.id releasing. Must match the current holder. */
  slug: string;
}

/**
 * Release the lock IF the requesting slug currently holds it.
 * Returns true if released; false if mismatch (another slug holds
 * it, or the lock was already free). Mismatch is a soft no-op —
 * stale-lock cleanup (next commit) handles the case where the
 * holder is dead.
 */
export function releaseClearinghouseLock(opts: ReleaseLockOpts): boolean {
  const current = readClearinghouseLock(opts.corpRoot);
  if (current.heldBy !== opts.slug) return false;
  writeLockState(opts.corpRoot, { ...FREE_LOCK });
  return true;
}

/**
 * Force-release the lock regardless of holder. Used by stale-lock
 * detection (next commit) when the holder is confirmed dead. NOT a
 * normal-flow API — Pressman should always use releaseClearinghouseLock
 * for own-slug release.
 */
export function forceReleaseClearinghouseLock(corpRoot: string): void {
  writeLockState(corpRoot, { ...FREE_LOCK });
}

// ─── State cascade (submission → task → contract) ────────────────────

/**
 * Mark a clearance-submission as merged, advancing the linked task
 * and (if all sibling tasks complete) the contract. Single helper
 * so callers don't manage three interdependent chit updates by hand
 * and screw one up — the cascade either lands cleanly or surfaces
 * the failure point.
 *
 * Cascade order:
 *   1. submission.submissionStatus = 'merged', mergedAt + commit sha set.
 *      submission chit.status flips to 'completed'.
 *   2. task.workflowStatus advances clearance → completed.
 *   3. If all sibling tasks (same contract) are completed, contract
 *      chit.status advances clearance → completed.
 *
 * Per-step failures bubble — caller decides retry. Partial cascade
 * can leave the chit graph in a transitional state; the next dispatch
 * pass will re-evaluate (the helpers are idempotent for already-
 * advanced statuses).
 */
export interface MarkSubmissionMergedOpts {
  corpRoot: string;
  submissionId: string;
  mergeCommitSha?: string;
  /** Who's writing — Pressman slug. */
  updatedBy: string;
}

export function markSubmissionMerged(opts: MarkSubmissionMergedOpts): void {
  const subResult = findChitById(opts.corpRoot, opts.submissionId);
  if (!subResult) {
    throw new Error(`markSubmissionMerged: submission ${opts.submissionId} not found`);
  }
  if (subResult.chit.type !== 'clearance-submission') {
    throw new Error(`markSubmissionMerged: ${opts.submissionId} is type '${subResult.chit.type}', not clearance-submission`);
  }
  const subChit = subResult.chit as Chit<'clearance-submission'>;
  const subFields = subChit.fields['clearance-submission'];
  const mergedAt = new Date().toISOString();

  // 1. Update the submission chit.
  updateChit<'clearance-submission'>(opts.corpRoot, 'corp', 'clearance-submission', subChit.id, {
    status: 'completed',
    updatedBy: opts.updatedBy,
    fields: {
      'clearance-submission': {
        ...subFields,
        submissionStatus: 'merged',
        mergedAt,
        mergeCommitSha: opts.mergeCommitSha ?? null,
        processingBy: null,
      },
    },
  });

  // 2. Advance the linked task workflow status.
  cascadeTaskWorkflowStatus(opts.corpRoot, subFields.taskId, 'completed', opts.updatedBy);

  // 3. If the contract's tasks are all completed, advance contract.
  cascadeContractStatusIfReady(opts.corpRoot, subFields.contractId, opts.updatedBy);
}

export interface MarkSubmissionFailedOpts {
  corpRoot: string;
  submissionId: string;
  reason: string;
  updatedBy: string;
}

/**
 * Mark a clearance-submission as failed (mechanical exhaustion —
 * retries used up, branch gone, etc). Cascades the task to `failed`
 * workflow status. Contract is NOT auto-failed from one task's
 * failure — that's a contract-level decision the founder or higher
 * agent makes.
 */
export function markSubmissionFailed(opts: MarkSubmissionFailedOpts): void {
  const subResult = findChitById(opts.corpRoot, opts.submissionId);
  if (!subResult) {
    throw new Error(`markSubmissionFailed: submission ${opts.submissionId} not found`);
  }
  if (subResult.chit.type !== 'clearance-submission') {
    throw new Error(`markSubmissionFailed: ${opts.submissionId} is type '${subResult.chit.type}', not clearance-submission`);
  }
  const subChit = subResult.chit as Chit<'clearance-submission'>;
  const subFields = subChit.fields['clearance-submission'];

  updateChit<'clearance-submission'>(opts.corpRoot, 'corp', 'clearance-submission', subChit.id, {
    status: 'failed',
    updatedBy: opts.updatedBy,
    fields: {
      'clearance-submission': {
        ...subFields,
        submissionStatus: 'failed',
        lastFailureReason: opts.reason,
        processingBy: null,
      },
    },
  });

  cascadeTaskWorkflowStatus(opts.corpRoot, subFields.taskId, 'failed', opts.updatedBy);
}

// ─── Internal cascade primitives ─────────────────────────────────────

function cascadeTaskWorkflowStatus(
  corpRoot: string,
  taskId: string,
  newWorkflowStatus: TaskWorkflowStatus,
  updatedBy: string,
): void {
  const taskResult = findChitById(corpRoot, taskId);
  if (!taskResult) return; // task missing — submission was orphaned; surface elsewhere
  if (taskResult.chit.type !== 'task') return;
  const taskChit = taskResult.chit as Chit<'task'>;
  const taskFields = taskChit.fields.task;

  // Idempotency — if task is already at the target state, no-op.
  if (taskFields.workflowStatus === newWorkflowStatus) return;

  // chit.status mirrors workflow terminal/non-terminal.
  const chitStatus =
    newWorkflowStatus === 'completed'
      ? 'completed'
      : newWorkflowStatus === 'failed'
        ? 'failed'
        : taskChit.status;

  const scope = chitScopeFromPath(corpRoot, taskResult.path);
  updateChit<'task'>(corpRoot, scope, 'task', taskChit.id, {
    status: chitStatus,
    updatedBy,
    fields: {
      task: {
        ...taskFields,
        workflowStatus: newWorkflowStatus,
      },
    },
  });
}

// ─── Stale-lock detection + restart resumption ───────────────────────

/**
 * Result of a stale-lock check. `state` is the current lock; `isStale`
 * is true iff the lock is held by a slug that the supplied predicate
 * reports as not-alive. Free locks are never stale.
 */
export interface StaleLockInfo {
  readonly state: ClearinghouseLockState;
  readonly isStale: boolean;
}

/**
 * Pure: classify a lock as stale-or-not given an aliveness predicate.
 * Caller (daemon) supplies the predicate, typically by composing
 * processManager.getAgent into a slug→boolean function. Pure shape
 * keeps this testable without process-manager.
 */
export function detectStaleLock(
  state: ClearinghouseLockState,
  isAlive: (slug: string) => boolean,
): StaleLockInfo {
  if (!state.heldBy) return { state, isStale: false };
  return { state, isStale: !isAlive(state.heldBy) };
}

/**
 * A clearance-submission whose `processingBy` slot is no longer
 * alive — orphaned mid-process by a Pressman crash or restart.
 * Caller resets these to `queued` so the next Pressman tick picks
 * them up.
 */
export interface OrphanedSubmission {
  readonly chit: Chit<'clearance-submission'>;
  /** The slug that was processing — now dead. */
  readonly orphanedFrom: string;
}

/**
 * Walk active clearance-submissions, return any whose
 * `submissionStatus === 'processing'` AND whose `processingBy` slot
 * is not alive. Pure-ish: the only I/O is the chit query; the
 * aliveness predicate is supplied.
 */
export function findOrphanedProcessingSubmissions(
  corpRoot: string,
  isAlive: (slug: string) => boolean,
): ReadonlyArray<OrphanedSubmission> {
  let result: ReturnType<typeof queryChits<'clearance-submission'>>;
  try {
    result = queryChits<'clearance-submission'>(corpRoot, {
      types: ['clearance-submission'],
      scopes: ['corp'],
      statuses: ['active'],
    });
  } catch {
    return [];
  }
  const orphans: OrphanedSubmission[] = [];
  for (const c of result.chits) {
    const f = c.chit.fields['clearance-submission'];
    if (f.submissionStatus !== 'processing') continue;
    if (!f.processingBy) continue; // defensive — shouldn't happen
    if (isAlive(f.processingBy)) continue;
    orphans.push({ chit: c.chit, orphanedFrom: f.processingBy });
  }
  return orphans;
}

/**
 * Reset one orphaned submission back to `queued` so the next
 * Pressman tick can re-claim it. Idempotent: no-op if the
 * submission has already moved off `processing`.
 *
 * Records `lastFailureReason` for retrospective audit so the
 * resumption shows up in `cc-cli clearinghouse status` listings.
 * Does NOT increment retryCount — restart-induced re-queue isn't
 * the submission's fault and shouldn't penalize its priority.
 */
export function resetOrphanedSubmission(
  corpRoot: string,
  submissionId: string,
  reason: string,
): void {
  const result = findChitById(corpRoot, submissionId);
  if (!result || result.chit.type !== 'clearance-submission') return;
  const subChit = result.chit as Chit<'clearance-submission'>;
  const subFields = subChit.fields['clearance-submission'];
  if (subFields.submissionStatus !== 'processing') return;

  updateChit<'clearance-submission'>(corpRoot, 'corp', 'clearance-submission', subChit.id, {
    updatedBy: 'system:clearinghouse-resume',
    fields: {
      'clearance-submission': {
        ...subFields,
        submissionStatus: 'queued',
        processingBy: null,
        // processingStartedAt cleared by setting to null (chit
        // serializer treats null and absent equivalently for
        // optional ISO timestamps).
        processingStartedAt: undefined,
        lastFailureReason: reason,
      },
    },
  });
}

/**
 * Summary of what `resumeClearinghouse` cleaned up. Caller logs
 * this so the founder/Sexton can see post-restart what was
 * recovered.
 */
export interface ResumeClearinghouseResult {
  readonly lockReleased: boolean;
  readonly submissionsReset: number;
}

/**
 * Boot-time + periodic-sweeper composer. Releases the lock if its
 * holder is dead; resets every orphaned-processing submission back
 * to `queued`. Best-effort per orphan — one bad reset doesn't
 * poison the rest.
 *
 * Daemon calls this at startup (after processManager initializes
 * so `isAlive` returns meaningful values) and from a sweeper at
 * regular cadence (catches Pressman silent-exits between restarts).
 */
export function resumeClearinghouse(
  corpRoot: string,
  isAlive: (slug: string) => boolean,
): ResumeClearinghouseResult {
  let lockReleased = false;
  const lockInfo = detectStaleLock(readClearinghouseLock(corpRoot), isAlive);
  if (lockInfo.isStale) {
    forceReleaseClearinghouseLock(corpRoot);
    lockReleased = true;
  }

  const orphans = findOrphanedProcessingSubmissions(corpRoot, isAlive);
  let resetCount = 0;
  for (const o of orphans) {
    try {
      resetOrphanedSubmission(
        corpRoot,
        o.chit.id,
        `Pressman '${o.orphanedFrom}' no longer alive at resume time — re-queued.`,
      );
      resetCount++;
    } catch {
      // Best-effort — one failure shouldn't poison the rest.
    }
  }

  return { lockReleased, submissionsReset: resetCount };
}

function cascadeContractStatusIfReady(
  corpRoot: string,
  contractId: string,
  updatedBy: string,
): void {
  const contractResult = findChitById(corpRoot, contractId);
  if (!contractResult) return;
  if (contractResult.chit.type !== 'contract') return;
  const contractChit = contractResult.chit as Chit<'contract'>;
  const contractFields = contractChit.fields.contract;

  // Already completed? No-op.
  if (contractChit.status === 'completed') return;

  // Walk task ids; if every one is workflowStatus=completed, advance
  // the contract. Missing-task lookups treated as "not yet completed"
  // so the contract waits.
  const taskIds = contractFields.taskIds ?? [];
  if (taskIds.length === 0) return;
  for (const tid of taskIds) {
    const t = findChitById(corpRoot, tid);
    if (!t || t.chit.type !== 'task') return;
    const tChit = t.chit as Chit<'task'>;
    if (tChit.fields.task.workflowStatus !== 'completed') return;
  }

  const scope = chitScopeFromPath(corpRoot, contractResult.path);
  updateChit<'contract'>(corpRoot, scope, 'contract', contractChit.id, {
    status: 'completed',
    updatedBy,
    fields: {
      contract: {
        ...contractFields,
        completedAt: new Date().toISOString(),
      },
    },
  });
}
