/**
 * Clearinghouse workflow primitives (Project 1.12.1).
 *
 * Stateless step functions composed by the Pressman session via
 * `cc-cli clearinghouse <verb>` subcommands. Each primitive is a
 * single coherent step: pick a submission, acquire a worktree,
 * rebase, test, merge, or route a terminal outcome.
 *
 * ### Why stateless
 *
 * The Pressman is an Employee with a session — it reads the
 * `patrol/clearing` blueprint and calls these primitives via the
 * cc-cli subcommands in {@link ../../cli/src/commands/clearinghouse.ts}.
 * Each call runs in a fresh CLI process. State that persists
 * across calls lives on disk: the lock JSON, the chit graph, the
 * worktree directory. In-memory state (a daemon's "in-flight"
 * flag, a pool's holder map) is unavailable across process
 * boundaries, so primitives never rely on it.
 *
 * ### Composition
 *
 *   pickNext         → reads queue + lock, claims for this Pressman.
 *   acquireWorktree  → ensures an isolated worktree on disk.
 *   rebaseStep       → fetch base + attemptRebase + classify.
 *   testStep         → runWithFlakeRetry + classify.
 *   mergeStep        → attemptMerge + classify.
 *   finalizeMerged   → cascade success + release lock + remove worktree.
 *   fileBlocker      → escalation chit + markSubmissionFailed +
 *                      release lock + remove worktree.
 *   markFailedAndRelease → terminal failure without escalation
 *                          (e.g. push-race retry-cap, sanity-failed,
 *                          inconclusive tests).
 *   releaseAll       → bare cleanup (no chit changes).
 *
 * ### Self-heal
 *
 * `resumeClearinghouse` (PR 1 substrate) needs an aliveness
 * predicate, which only the daemon has. It runs in the daemon's
 * boot path + periodic sweeper, not here. The agent's `pickNext`
 * trusts that stale state is reaped between sweeper ticks.
 *
 * ### Worktree provisioning
 *
 * The PR 2 `WorktreePool` is in-memory daemon state and can't be
 * shared across CLI processes. Workflow primitives use
 * `gitOps.worktreeAdd/Remove` directly with a deterministic path
 * keyed off the submission id (`<corpRoot>/.clearinghouse/wt-<prefix>`).
 * Loss: a couple of extra git invocations per merge (no reuse).
 * Gain: process-agnostic, no daemon round-trips, idempotent
 * resumption (re-acquire of an existing worktree returns it
 * as-is when the branch matches).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  rankQueue,
  readClearinghouseLock,
  claimClearinghouseLock,
  releaseClearinghouseLock,
  markSubmissionMerged,
  markSubmissionFailed,
  findChitById,
  updateChit,
  createChit,
  readConfig,
  MEMBERS_JSON,
  type Chit,
  type ClearanceSubmissionFields,
  type EscalationFields,
  type LaneEventFields,
  type LaneEventKind,
  type LaneEventPayload,
  type Member,
} from '@claudecorp/shared';
import { failure, ok, err, type Result } from './failure-taxonomy.js';
import { realGitOps, type GitOps } from './git-ops.js';
import { attemptRebase, type RebaseAttemptResult } from './rebase-flow.js';
import { attemptMerge, type MergeAttemptResult } from './merge-flow.js';
import {
  runWithFlakeRetry,
  runTestsOnRef,
  attributeFailure,
  type RunWithFlakeRetryResult,
  type AttributedFailure,
} from './test-attribution.js';
import { runTests, type TestRunResult } from './tests-runner.js';
import type { FailureRecord } from './failure-taxonomy.js';
import { WORKTREE_PARENT_DIR, WORKTREE_GITIGNORE } from './worktree-pool.js';

// ─── Config ──────────────────────────────────────────────────────────

/** Default base branch the rebase targets when the caller doesn't override. */
export const DEFAULT_BASE_BRANCH = 'main';

/**
 * Cap on Phase-2 mechanical retries before a submission is failed.
 * Push-races increment retryCount; once at the cap the submission
 * exits the lane via markFailedAndRelease.
 */
export const PRESSMAN_RETRY_CAP = 3;

/**
 * Length of the submission-id prefix used for the deterministic
 * worktree path. Long enough to avoid collisions in a single corp's
 * lifetime; short enough to keep the on-disk path readable.
 */
const WORKTREE_PREFIX_LEN = 12;

// ─── lane-event emission helper ──────────────────────────────────────

/**
 * Project 1.12.3 — emit a lane-event chit recording one state
 * transition. Best-effort: emission failure surfaces to stderr but
 * never blocks the calling primitive's main return value. The corp
 * staying functional matters more than any single event landing.
 *
 * Every primitive that performs a state transition calls this with
 * the appropriate kind. Narratives are optional — agent-supplied via
 * the CLI when the agent has prose worth recording, null otherwise
 * (renderers fall back to a kind-derived default phrase). Daemon-
 * emitted events (resume sweeps, watcher fallbacks) leave both
 * `emittedBy` and `narrative` null.
 */
export function emitLaneEvent(opts: {
  corpRoot: string;
  /** submissionId optional for Editor pre-submission events. */
  submissionId?: string | null;
  taskId: string;
  kind: LaneEventKind;
  emittedBy: string | null;
  narrative?: string | null;
  payload?: LaneEventPayload | null;
}): void {
  try {
    const fields: LaneEventFields = {
      submissionId: opts.submissionId,
      taskId: opts.taskId,
      kind: opts.kind,
      emittedBy: opts.emittedBy,
      ...(opts.narrative !== undefined ? { narrative: opts.narrative } : {}),
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    };
    createChit<'lane-event'>(opts.corpRoot, {
      type: 'lane-event',
      scope: 'corp',
      createdBy: opts.emittedBy ?? 'system:lane',
      status: 'active',
      fields: { 'lane-event': fields },
    });
  } catch (cause) {
    process.stderr.write(
      `[clearinghouse:lane-event] emit failed for ${opts.kind} (submission ${opts.submissionId}): ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  }
}

/**
 * Resolve the taskId for a submission id without forcing every
 * caller to redundantly read the submission chit. Returns null
 * if the submission isn't found — the lane-event will be skipped
 * in that case (the calling primitive's failure will already
 * have logged the missing submission).
 */
function taskIdFromSubmission(corpRoot: string, submissionId: string): string | null {
  try {
    const hit = findChitById(corpRoot, submissionId);
    if (!hit || hit.chit.type !== 'clearance-submission') return null;
    return (hit.chit as Chit<'clearance-submission'>).fields['clearance-submission'].taskId;
  } catch {
    return null;
  }
}

// ─── pickNext ────────────────────────────────────────────────────────

/**
 * What `pickNext` returns. `resumed: true` means the lock was
 * already held by this Pressman — agent is resuming a prior
 * session's in-flight submission rather than picking fresh work.
 */
export interface PickedSubmission {
  readonly submissionId: string;
  readonly branch: string;
  readonly taskId: string;
  readonly contractId: string;
  readonly submitter: string;
  readonly priority: 'critical' | 'high' | 'normal' | 'low';
  readonly retryCount: number;
  /** Score from rankQueue. Absent when resuming an already-claimed submission. */
  readonly score?: number;
  /** True iff the lock was already held by this slug at pick time. */
  readonly resumed: boolean;
}

export interface PickNextOpts {
  corpRoot: string;
  /** Pressman's Member.id. Must exist in members.json with role='pressman'. */
  pressmanSlug: string;
}

/**
 * Find the next submission to work on. Three outcomes wrapped in
 * `Result<PickedSubmission | null>`:
 *
 *   - ok(picked, resumed=true): lock was already held by this
 *     Pressman. Return the held submission so the agent can pick
 *     up mid-flight (session restart, daemon restart, etc).
 *
 *   - ok(picked, resumed=false): lock was free; rankQueue had work;
 *     we claimed the lock and flipped the submission to 'processing'.
 *
 *   - ok(null): nothing to do (queue empty, OR lock held by someone
 *     else, OR the claim race went to another Pressman).
 *
 *   - err(...): Pressman not in members.json, or chit-store
 *     I/O blew up. Caller surfaces.
 */
export function pickNext(opts: PickNextOpts): Result<PickedSubmission | null> {
  // 1. Validate the Pressman is hired. If members.json is broken or
  // the slug doesn't resolve to a pressman, refuse — we don't want
  // a typo'd slug claiming the lock.
  let pressman: Member | undefined;
  try {
    const members = readConfig<Member[]>(join(opts.corpRoot, MEMBERS_JSON));
    pressman = members.find((m) => m.id === opts.pressmanSlug && m.role === 'pressman');
  } catch (cause) {
    return err(failure(
      'unknown',
      `pickNext: cannot read members.json (${MEMBERS_JSON}). Is this a Claude Corp checkout?`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }
  if (!pressman) {
    return err(failure(
      'unknown',
      `pickNext: no Pressman with id='${opts.pressmanSlug}' and role='pressman' in members.json`,
      `slug=${opts.pressmanSlug}`,
    ));
  }

  // 2. Read lock. Three cases.
  const lock = readClearinghouseLock(opts.corpRoot);
  if (lock.heldBy && lock.heldBy !== opts.pressmanSlug) {
    // Held by someone else. Could be a live peer Pressman; could be
    // stale (will be released by the daemon's sweeper). Either way,
    // this Pressman waits.
    return ok(null);
  }
  if (lock.heldBy === opts.pressmanSlug && lock.submissionId) {
    // Resume — we already hold it for some submission.
    const hit = findChitById(opts.corpRoot, lock.submissionId);
    if (!hit || hit.chit.type !== 'clearance-submission') {
      // Lock points at a submission that doesn't exist or has the
      // wrong type. Force-release so the next pick can advance.
      releaseClearinghouseLock({ corpRoot: opts.corpRoot, slug: opts.pressmanSlug });
      return err(failure(
        'unknown',
        `pickNext: lock pointed at submission '${lock.submissionId}' which no longer exists. Lock force-released; retry.`,
        `lock=${JSON.stringify(lock)}`,
      ));
    }
    const subChit = hit.chit as Chit<'clearance-submission'>;
    const f = subChit.fields['clearance-submission'];
    return ok(toPickedSubmission(subChit.id, f, undefined, true));
  }

  // 3. Lock is free. Rank the queue.
  const ranked = rankQueue(opts.corpRoot);
  if (ranked.length === 0) {
    return ok(null);
  }
  const top = ranked[0]!;
  const topFields = top.chit.fields['clearance-submission'];

  // 4. Claim. Race-tolerant: if another Pressman beats us, claim
  // returns false and we yield this tick.
  const claimed = claimClearinghouseLock({
    corpRoot: opts.corpRoot,
    slug: opts.pressmanSlug,
    submissionId: top.chit.id,
  });
  if (!claimed) {
    return ok(null);
  }

  // 5. Flip submissionStatus → 'processing' and stamp processingBy.
  // The orphan-recovery sweeper depends on these fields being set —
  // without them, a Pressman crash mid-process would leave the
  // submission visible as 'queued' but locked, untouchable until
  // the lock's stale-detection fires. Setting both in one update
  // closes that hole. (The wrong-shape PressmanScheduler skipped
  // this; orphan recovery silently never matched anything.)
  const now = new Date().toISOString();
  try {
    updateChit<'clearance-submission'>(opts.corpRoot, 'corp', 'clearance-submission', top.chit.id, {
      updatedBy: opts.pressmanSlug,
      fields: {
        'clearance-submission': {
          ...topFields,
          submissionStatus: 'processing',
          processingBy: opts.pressmanSlug,
          processingStartedAt: now,
        },
      },
    });
  } catch (cause) {
    // Could not flip to processing — release the lock so the next
    // Pressman tick can re-claim cleanly. Surface the failure.
    releaseClearinghouseLock({ corpRoot: opts.corpRoot, slug: opts.pressmanSlug });
    return err(failure(
      'unknown',
      `pickNext: claimed lock for ${top.chit.id} but couldn't flip submissionStatus to 'processing'. Lock released; retry.`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }

  // Emit submission-claimed lane-event. Resume path doesn't emit
  // (no new state transition; the same Pressman is just picking
  // back up where they left off).
  emitLaneEvent({
    corpRoot: opts.corpRoot,
    submissionId: top.chit.id,
    taskId: topFields.taskId,
    kind: 'submission-claimed',
    emittedBy: opts.pressmanSlug,
    payload: { branch: topFields.branch },
  });

  return ok(toPickedSubmission(top.chit.id, topFields, top.score, false));
}

function toPickedSubmission(
  id: string,
  f: ClearanceSubmissionFields,
  score: number | undefined,
  resumed: boolean,
): PickedSubmission {
  return {
    submissionId: id,
    branch: f.branch,
    taskId: f.taskId,
    contractId: f.contractId,
    submitter: f.submitter,
    priority: f.priority,
    retryCount: f.retryCount,
    ...(score !== undefined ? { score } : {}),
    resumed,
  };
}

// ─── acquireWorktree ─────────────────────────────────────────────────

export interface AcquireWorktreeOpts {
  corpRoot: string;
  /** The submission id whose branch we're checking out. Used for the deterministic path. */
  submissionId: string;
  /** Branch to check out into the worktree. */
  branch: string;
  /** Inject a mock GitOps for tests. */
  gitOps?: GitOps;
  /**
   * Path prefix under `<corpRoot>/.clearinghouse/`. Defaults to `'wt'`
   * for Pressman's submission-keyed worktrees. Editor passes
   * `'editor-wt'` (with an id derived from taskId) so its worktrees
   * land in a separate namespace and can't collide with Pressman's.
   * 1.12.2 widened this so the same primitive serves both lanes.
   */
  pathPrefix?: string;
}

export interface AcquiredWorktree {
  /** Absolute path on disk. */
  readonly path: string;
}

/**
 * Ensure an isolated worktree exists for the submission's branch.
 * Idempotent on the path: calling twice with the same submission id
 * yields the same on-disk path. The branch checkout is recreated
 * fresh on every call — if a prior session left the worktree in a
 * mid-rebase state, this acquire wipes it and starts clean.
 *
 * Path is `<corpRoot>/.clearinghouse/wt-<submissionId-prefix>`.
 * Deterministic so a session-restart can find its prior worktree
 * without coordinating through external state.
 *
 * Strategy:
 *   - Ensure parent dir + .gitignore (one-time, idempotent).
 *   - If path exists: force-remove first (handles mid-rebase /
 *     wrong-branch / corrupt-state without case-splitting).
 *   - worktreeAdd at the deterministic path.
 *
 * The extra remove on resumption costs a single git invocation;
 * not branching on prior state keeps the function honest and
 * removes a class of "what if the existing worktree is in some
 * unexpected mode" edge cases.
 */
export async function acquireWorktree(opts: AcquireWorktreeOpts): Promise<Result<AcquiredWorktree>> {
  const gitOps = opts.gitOps ?? realGitOps;

  // 1. Ensure parent dir + gitignore. Both are corp-state, written
  // once and idempotent on every acquire (cheap; <1ms).
  const parent = join(opts.corpRoot, WORKTREE_PARENT_DIR);
  try {
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    const gitignore = join(parent, '.gitignore');
    if (!existsSync(gitignore)) writeFileSync(gitignore, WORKTREE_GITIGNORE, 'utf-8');
  } catch (cause) {
    return err(failure(
      'unknown',
      `acquireWorktree: cannot ensure ${parent} exists. Disk full or permission denied?`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }

  // 2. Compute deterministic path from the id (not the branch —
  // branches can be renamed; ids are immutable). Prefix
  // 'wt'|'editor-wt' separates Pressman + Editor worktrees so the
  // two lanes can't collide.
  const idPrefix = opts.submissionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, WORKTREE_PREFIX_LEN);
  const dirPrefix = opts.pathPrefix ?? 'wt';
  const path = join(parent, `${dirPrefix}-${idPrefix}`);

  // 3. If path exists, force-remove first. We don't try to inspect
  // its state and reuse — leftover rebase / merge / index state
  // from a prior crashed session is too varied to handle safely.
  // Best to start clean.
  if (existsSync(path)) {
    await gitOps.worktreeRemove(path, { force: true, cwd: opts.corpRoot }).catch(() => undefined);
  }

  // 4. Add a fresh worktree.
  const add = await gitOps.worktreeAdd(opts.branch, path, { cwd: opts.corpRoot });
  if (!add.ok) return err(add.failure);

  // Emit worktree-acquired. Best-effort taskId lookup; if the
  // submission has been deleted between caller's pickNext and
  // here, we just skip the event — primitive's main return is
  // still valid.
  const taskId = taskIdFromSubmission(opts.corpRoot, opts.submissionId);
  if (taskId) {
    emitLaneEvent({
      corpRoot: opts.corpRoot,
      submissionId: opts.submissionId,
      taskId,
      kind: 'worktree-acquired',
      emittedBy: null, // primitive-emitted; agent didn't author this transition
      payload: { branch: opts.branch },
    });
  }

  return ok({ path });
}

// ─── rebaseStep ──────────────────────────────────────────────────────

export interface RebaseStepOpts {
  corpRoot: string;
  /** Submission id — for logging + cascading on failure. */
  submissionId: string;
  /** Worktree to operate in (from acquireWorktree). */
  worktreePath: string;
  /** Branch the worktree has checked out (the PR's branch). */
  branch: string;
  /** Base branch the rebase targets. Defaults to {@link DEFAULT_BASE_BRANCH}. */
  baseBranch?: string;
  gitOps?: GitOps;
  /**
   * Project 1.12.3 — optional 1-line agent prose recorded on the
   * emitted lane-event. Agent's voice for what just happened
   * ("rebase from hell — 7 conflicts, 4 substantive, routed").
   * Null/absent fine when the kind-derived auto-summary is enough.
   */
  narrative?: string | null;
  /**
   * Project 1.12.3 — agent slug authoring the action. Threaded
   * through to the emitted lane-event's emittedBy. Null when this
   * primitive is daemon-emitted (rare for rebaseStep — typically
   * agent-driven).
   */
  emittedBy?: string | null;
}

/**
 * Fetch the base + run attemptRebase. Returns the typed
 * RebaseAttemptResult unchanged so the agent can branch on `outcome`
 * via the structured JSON output:
 *
 *   clean / auto-resolved → proceed to testStep.
 *   needs-author          → fileBlocker(kind='rebase-conflict').
 *   sanity-failed         → markFailedAndRelease (route in failureRecord
 *                           is engineering-lead).
 *   fatal                 → markFailedAndRelease (route is founder for
 *                           tool/disk/network categories).
 *
 * Wraps fetch failures into `outcome: 'fatal'` so callers have a
 * uniform branching surface — the rebase-flow primitive already
 * does this for git.rebase failures, and we extend the convention
 * to git.fetch.
 */
export async function rebaseStep(opts: RebaseStepOpts): Promise<Result<RebaseAttemptResult>> {
  const gitOps = opts.gitOps ?? realGitOps;
  const baseBranch = opts.baseBranch ?? DEFAULT_BASE_BRANCH;
  const taskId = taskIdFromSubmission(opts.corpRoot, opts.submissionId);

  // Fetch first — without an updated origin/<base>, the rebase
  // would target a stale commit.
  const fetchResult = await gitOps.fetchOrigin({ branch: baseBranch, cwd: opts.worktreePath });
  if (!fetchResult.ok) {
    if (taskId) {
      emitLaneEvent({
        corpRoot: opts.corpRoot,
        submissionId: opts.submissionId,
        taskId,
        kind: 'rebase-fatal',
        emittedBy: opts.emittedBy ?? null,
        narrative: opts.narrative ?? null,
        payload: {
          branch: opts.branch,
          failureCategory: fetchResult.failure.category,
          failureSummary: fetchResult.failure.pedagogicalSummary,
        },
      });
    }
    return ok({
      outcome: 'fatal',
      failureRecord: fetchResult.failure,
    });
  }

  const result = await attemptRebase({
    worktreePath: opts.worktreePath,
    baseBranch: `origin/${baseBranch}`,
    prBranch: opts.branch,
    gitOps,
  });

  // Emit a lane-event keyed off the typed outcome. Five kinds map
  // 1:1 with RebaseAttemptOutcome.
  if (result.ok && taskId) {
    const r = result.value;
    const kind: LaneEventKind =
      r.outcome === 'clean' ? 'rebase-clean'
      : r.outcome === 'auto-resolved' ? 'rebase-auto-resolved'
      : r.outcome === 'needs-author' ? 'rebase-needs-author'
      : r.outcome === 'sanity-failed' ? 'rebase-sanity-failed'
      : 'rebase-fatal';
    const payload: LaneEventPayload = { branch: opts.branch };
    if (r.conflictedFiles?.length) payload.conflictedFiles = [...r.conflictedFiles];
    if (r.autoResolvedFiles?.length) payload.autoResolvedFiles = [...r.autoResolvedFiles];
    if (r.autoResolutionRounds !== undefined) payload.autoResolutionRounds = r.autoResolutionRounds;
    if (r.failureRecord) {
      payload.failureCategory = r.failureRecord.category;
      payload.failureSummary = r.failureRecord.pedagogicalSummary;
    }
    emitLaneEvent({
      corpRoot: opts.corpRoot,
      submissionId: opts.submissionId,
      taskId,
      kind,
      emittedBy: opts.emittedBy ?? null,
      narrative: opts.narrative ?? null,
      payload,
    });
  }

  return result;
}

// ─── testStep ────────────────────────────────────────────────────────

export interface TestStepOpts {
  corpRoot: string;
  submissionId: string;
  worktreePath: string;
  /** Optional override for the test command (shell string, e.g. "pnpm test"). */
  testCommand?: string;
  /** Direct program + args — bypasses shell parsing for safer execution. */
  testProgram?: string;
  testArgs?: readonly string[];
  /** Override flake-retry count (default 1 from runWithFlakeRetry). */
  maxRetries?: number;
  /** Project 1.12.3 — agent's voice on the emitted lane-event. */
  narrative?: string | null;
  /** Project 1.12.3 — agent slug authoring the action. */
  emittedBy?: string | null;
}

/**
 * Run the corp's test command against the (rebased) worktree, with
 * one flake-retry on initial failure. Returns the typed
 * RunWithFlakeRetryResult so the agent branches on `classifiedAs`:
 *
 *   passed-first / flake → proceed to mergeStep.
 *   consistent-fail      → fileBlocker(kind='test-fail').
 *   inconclusive         → markFailedAndRelease (timeout / crash /
 *                          tool-missing — environmental, not the PR).
 */
export async function testStep(opts: TestStepOpts): Promise<Result<RunWithFlakeRetryResult>> {
  const runOpts: Parameters<typeof runWithFlakeRetry>[0]['runOpts'] = {
    cwd: opts.worktreePath,
    ...(opts.testCommand ? { command: opts.testCommand } : {}),
    ...(opts.testProgram ? { program: opts.testProgram } : {}),
    ...(opts.testArgs ? { args: opts.testArgs } : {}),
  };
  const result = await runWithFlakeRetry({
    runOpts,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  });

  // Emit a lane-event per classifiedAs outcome. 'passed-first' and
  // 'flake' both map to 'tests-passed' / 'tests-flake' kinds; the
  // distinction Pressman cares about (re-run was needed) is on the
  // kind itself.
  if (result.ok) {
    const taskId = taskIdFromSubmission(opts.corpRoot, opts.submissionId);
    if (taskId) {
      const t = result.value;
      const kind: LaneEventKind =
        t.classifiedAs === 'passed-first' ? 'tests-passed'
        : t.classifiedAs === 'flake' ? 'tests-flake'
        : t.classifiedAs === 'consistent-fail' ? 'tests-consistent-fail'
        : 'tests-inconclusive';
      const payload: LaneEventPayload = { testDurationMs: t.finalRun.durationMs };
      if (t.finalRun.failures.length > 0) {
        payload.failureNames = t.finalRun.failures.map((f) => f.name);
      }
      emitLaneEvent({
        corpRoot: opts.corpRoot,
        submissionId: opts.submissionId,
        taskId,
        kind,
        emittedBy: opts.emittedBy ?? null,
        narrative: opts.narrative ?? null,
        payload,
      });
    }
  }

  return result;
}

// ─── attributeStep ───────────────────────────────────────────────────

export interface AttributeStepOpts {
  corpRoot: string;
  submissionId: string;
  /** Worktree where the PR's tests already failed. */
  worktreePath: string;
  /** The PR branch — the worktree's current ref, restored after main test. */
  branch: string;
  /** Base ref to attribute against. Default 'origin/main'. */
  baseRef?: string;
  /** Optional override for the test command. Mirrors testStep's options. */
  testCommand?: string;
  testProgram?: string;
  testArgs?: readonly string[];
  gitOps?: GitOps;
  /** Project 1.12.3 — agent's voice on the emitted lane-event. */
  narrative?: string | null;
  /** Project 1.12.3 — agent slug authoring the action. */
  emittedBy?: string | null;
}

export interface AttributeStepResult {
  /** Attribution outcome — pr-introduced / main-regression / mixed / inconclusive / no-failure. */
  readonly attribution: AttributedFailure;
  /**
   * The main-side test result, exposed so the agent can include
   * specifics in the blocker body (which tests failed on main, etc).
   */
  readonly mainResult: TestRunResult;
  /**
   * Set when the post-attribution restore-checkout failed; the
   * worktree is in an unknown state and the agent should release
   * (or re-acquire) before further use. The attribution data is
   * still valid.
   */
  readonly restoreFailure?: FailureRecord;
}

/**
 * Project 1.12.3 — attribution step the agent calls AFTER testStep
 * returns `consistent-fail`. Re-runs the same test command on the
 * base ref (default `origin/main`), compares failure sets, returns
 * an AttributedFailure the agent uses to decide blocker routing:
 *
 *   pr-introduced  → fileBlocker default-routes to author.
 *   main-regression → fileBlocker(routeTo: 'engineering-lead').
 *                     The PR is innocent; engineering-lead is the
 *                     role responsible for main's health.
 *   mixed          → fileBlocker default-routes to author with
 *                    shared-with-main flagged in the detail body
 *                    so the substitute sees both the author-owned
 *                    and pre-existing failures.
 *   inconclusive   → fileBlocker default-routes to author (fall
 *                    back to current behavior; agent might also
 *                    DM founder if attribution stays inconclusive
 *                    across multiple submissions).
 *   no-failure     → unreachable on the consistent-fail path; the
 *                    agent's session would have moved to merge already.
 *
 * The attribution involves an extra full test run, so the agent
 * decides when it's worth running. Default: always for consistent-
 * fail. Cap-bypassed submissions or low-priority work might skip
 * to save the cost — agent's call.
 *
 * Restore semantics: the worktree is checked out back to `branch`
 * after the main run. If the restore fails, the test data still
 * surfaces but `restoreFailure` is set so the agent knows to
 * release before the next acquire.
 */
export async function attributeStep(
  opts: AttributeStepOpts,
): Promise<Result<AttributeStepResult>> {
  const gitOps = opts.gitOps ?? realGitOps;
  const baseRef = opts.baseRef ?? 'origin/main';

  // We need the PR-side test result to compare against. The agent
  // is calling attributeStep AFTER testStep returned consistent-
  // fail, so we re-run on the PR branch first to get a fresh
  // failure set (matches the same conditions as the main run).
  // Alternative: have the agent pass the prior testStep result.
  // We re-run for honesty — same environment, same time window.
  const prResult = await runTests({
    cwd: opts.worktreePath,
    ...(opts.testCommand ? { command: opts.testCommand } : {}),
    ...(opts.testProgram ? { program: opts.testProgram } : {}),
    ...(opts.testArgs ? { args: opts.testArgs } : {}),
  });
  if (!prResult.ok) return err(prResult.failure);

  // Run the same tests on the base ref via runTestsOnRef, which
  // handles checkout-to-ref + run + restore-to-branch. Restore
  // failures surface via the return shape.
  const refResult = await runTestsOnRef({
    worktreePath: opts.worktreePath,
    refToTest: baseRef,
    restoreRef: opts.branch,
    gitOps,
    ...(opts.testCommand || opts.testProgram || opts.testArgs
      ? {
          testOpts: {
            ...(opts.testCommand ? { command: opts.testCommand } : {}),
            ...(opts.testProgram ? { program: opts.testProgram } : {}),
            ...(opts.testArgs ? { args: opts.testArgs } : {}),
          },
        }
      : {}),
  });
  if (!refResult.ok) return err(refResult.failure);

  const attribution = attributeFailure(prResult.value, refResult.value.result);

  // Emit attribution lane-event keyed off the typed kind. Four
  // outcome kinds map to the AttributedFailure union (no-failure
  // is unreachable on the consistent-fail caller path, but we
  // handle it defensively).
  const taskId = taskIdFromSubmission(opts.corpRoot, opts.submissionId);
  if (taskId) {
    const kind: LaneEventKind =
      attribution.kind === 'pr-introduced' ? 'tests-attributed-pr'
      : attribution.kind === 'main-regression' ? 'tests-attributed-main'
      : attribution.kind === 'mixed' ? 'tests-attributed-mixed'
      : 'tests-attributed-inconclusive';
    const payload: LaneEventPayload = { branch: opts.branch };
    if (attribution.kind === 'pr-introduced') {
      payload.failureNames = attribution.prFailures.map((f) => f.name);
    } else if (attribution.kind === 'main-regression') {
      payload.failureNames = attribution.sharedFailures.map((f) => f.name);
    } else if (attribution.kind === 'mixed') {
      payload.failureNames = [
        ...attribution.prOnly.map((f) => f.name),
        ...attribution.sharedWithMain.map((f) => f.name),
      ];
    }
    emitLaneEvent({
      corpRoot: opts.corpRoot,
      submissionId: opts.submissionId,
      taskId,
      kind,
      emittedBy: opts.emittedBy ?? null,
      narrative: opts.narrative ?? null,
      payload,
    });
  }

  const out: AttributeStepResult = refResult.value.restoreFailure
    ? { attribution, mainResult: refResult.value.result, restoreFailure: refResult.value.restoreFailure }
    : { attribution, mainResult: refResult.value.result };
  return ok(out);
}

// ─── mergeStep ───────────────────────────────────────────────────────

export interface MergeStepOpts {
  corpRoot: string;
  submissionId: string;
  worktreePath: string;
  branch: string;
  gitOps?: GitOps;
  /** Project 1.12.3 — agent's voice on the emitted lane-event. */
  narrative?: string | null;
  /** Project 1.12.3 — agent slug authoring the action. */
  emittedBy?: string | null;
}

/**
 * Push the rebased branch to origin. Returns the typed
 * MergeAttemptResult so the agent branches on `outcome`:
 *
 *   merged         → finalizeMerged.
 *   race           → markFailedAndRelease(requeue=true) up to
 *                    PRESSMAN_RETRY_CAP, then terminal-fail.
 *   hook-rejected  → fileBlocker(kind='hook-reject') with hookOutput
 *                    as the detail body.
 *   branch-deleted → markFailedAndRelease (route=author).
 *   fatal          → markFailedAndRelease (route=founder typically).
 */
export async function mergeStep(opts: MergeStepOpts): Promise<Result<MergeAttemptResult>> {
  const gitOps = opts.gitOps ?? realGitOps;
  const result = await attemptMerge({
    worktreePath: opts.worktreePath,
    prBranch: opts.branch,
    gitOps,
  });

  if (result.ok) {
    const taskId = taskIdFromSubmission(opts.corpRoot, opts.submissionId);
    if (taskId) {
      const m = result.value;
      const kind: LaneEventKind =
        m.outcome === 'merged' ? 'merge-success'
        : m.outcome === 'race' ? 'merge-race'
        : m.outcome === 'hook-rejected' ? 'merge-hook-rejected'
        : m.outcome === 'branch-deleted' ? 'merge-branch-deleted'
        : 'merge-fatal';
      const payload: LaneEventPayload = { branch: opts.branch };
      if (m.mergeCommitSha) payload.mergeCommitSha = m.mergeCommitSha;
      if (m.hookOutput) payload.hookOutput = m.hookOutput;
      if (m.failureRecord) {
        payload.failureCategory = m.failureRecord.category;
        payload.failureSummary = m.failureRecord.pedagogicalSummary;
      }
      emitLaneEvent({
        corpRoot: opts.corpRoot,
        submissionId: opts.submissionId,
        taskId,
        kind,
        emittedBy: opts.emittedBy ?? null,
        narrative: opts.narrative ?? null,
        payload,
      });
    }
  }

  return result;
}

// ─── finalizeMerged ──────────────────────────────────────────────────

export interface FinalizeMergedOpts {
  corpRoot: string;
  submissionId: string;
  /** Pressman's Member.id, for cascade `updatedBy` and lock release. */
  slug: string;
  /** The post-push HEAD sha, for the audit trail on the submission chit. */
  mergeCommitSha?: string;
  /** Worktree to remove. Optional — if omitted, no cleanup. */
  worktreePath?: string;
  gitOps?: GitOps;
  /** Project 1.12.3 — agent's voice on the emitted lane-event. */
  narrative?: string | null;
}

/**
 * Cascade success on a merged submission: mark merged, advance the
 * task to completed, advance the contract if all sibling tasks are
 * done, release the lock, remove the worktree.
 *
 * Order matters: chit cascade first, then lock release, then worktree.
 * If any step throws, later steps still run via the finally chain so
 * we don't leak a held lock or stranded worktree on a transient
 * filesystem hiccup.
 */
export async function finalizeMerged(opts: FinalizeMergedOpts): Promise<Result<void>> {
  const gitOps = opts.gitOps ?? realGitOps;
  let cascadeError: Error | undefined;

  // Capture taskId BEFORE the cascade — markSubmissionMerged updates
  // the submission chit but doesn't change the taskId field. Reading
  // up-front means even cascade-failure paths can still emit the
  // submission-finalized event with the right linkage.
  const taskId = taskIdFromSubmission(opts.corpRoot, opts.submissionId);

  try {
    markSubmissionMerged({
      corpRoot: opts.corpRoot,
      submissionId: opts.submissionId,
      ...(opts.mergeCommitSha ? { mergeCommitSha: opts.mergeCommitSha } : {}),
      updatedBy: opts.slug,
    });
  } catch (cause) {
    cascadeError = cause instanceof Error ? cause : new Error(String(cause));
  }

  // Always release the lock — even if cascade threw, the work is
  // done on origin and the next Pressman tick should be unblocked.
  releaseClearinghouseLock({ corpRoot: opts.corpRoot, slug: opts.slug });

  // Best-effort worktree removal. A leaked worktree is recoverable
  // (cleanupOrphanWorktrees on next daemon boot); a stranded lock is
  // not, hence the ordering.
  if (opts.worktreePath) {
    await gitOps.worktreeRemove(opts.worktreePath, { force: true, cwd: opts.corpRoot }).catch(() => undefined);
  }

  // Emit submission-finalized — the journey ended in success. We
  // emit even when cascadeError fired because the merge DID land
  // on origin (the cascade failure is about chit-graph
  // bookkeeping, not the actual ship). The lane diary should
  // reflect "shipped" + a separate signal about the cascade.
  if (taskId) {
    const payload: LaneEventPayload = {};
    if (opts.mergeCommitSha) payload.mergeCommitSha = opts.mergeCommitSha;
    if (cascadeError) {
      payload.failureCategory = 'cascade-error';
      payload.failureSummary = cascadeError.message;
    }
    emitLaneEvent({
      corpRoot: opts.corpRoot,
      submissionId: opts.submissionId,
      taskId,
      kind: 'submission-finalized',
      emittedBy: opts.slug,
      narrative: opts.narrative ?? null,
      payload,
    });
  }

  if (cascadeError) {
    return err(failure(
      'unknown',
      `finalizeMerged: cascade failed for submission ${opts.submissionId}. The merge landed on origin but the chit graph wasn't fully advanced. Manual repair via cc-cli chit update.`,
      cascadeError.stack ?? cascadeError.message,
    ));
  }
  return ok(undefined);
}

// ─── fileBlocker ─────────────────────────────────────────────────────

/**
 * Why the submission is being blocked. Drives the escalation chit's
 * summary + the submission's failure reason. Each kind maps to a
 * known agent-judgment moment in `patrol/clearing`.
 */
export type BlockerKind = 'rebase-conflict' | 'test-fail' | 'hook-reject';

export interface FileBlockerOpts {
  corpRoot: string;
  submissionId: string;
  kind: BlockerKind;
  /** One-sentence summary for the escalation chit's `reason` headline. */
  summary: string;
  /** Full pedagogical body — what failed, why, what the author should do. */
  detail: string;
  /** Pressman's Member.id. */
  slug: string;
  /** Worktree to remove on close. Optional. */
  worktreePath?: string;
  gitOps?: GitOps;
  /**
   * Project 1.12.3 — optional override for the escalation chit's
   * `to` field. Default routes to the submission's submitter (the
   * PR author). Set to a role id (e.g. `'engineering-lead'`) when
   * the blocker is for someone other than the author — typically
   * after attribution determined the failure was a main regression
   * the author is innocent of. Hand 1.4.1's role-resolver finds an
   * Employee at that role.
   */
  routeTo?: string | null;
}

export interface FileBlockerResult {
  /** Chit id of the created escalation. */
  readonly escalationId: string;
}

/**
 * Cut an escalation chit (severity=blocker) for the submission's
 * author, mark the submission failed, release the lock, remove the
 * worktree.
 *
 * The escalation chit is the routing surface — Hand (1.4 / 1.4.1)
 * resolves the author's role and dispatches a substitute Employee
 * if the original is gone. The escalation body is pedagogical so
 * a substitute can act on it cold.
 *
 * Errors during chit creation are surfaced — the agent can re-try
 * via cc-cli or fall through to markFailedAndRelease as a degraded
 * path. The lock + worktree are released regardless, because
 * leaving them held strands the lane.
 */
export async function fileBlocker(opts: FileBlockerOpts): Promise<Result<FileBlockerResult>> {
  const gitOps = opts.gitOps ?? realGitOps;

  // 1. Resolve the submission to grab the author + branch metadata
  // for the escalation body.
  const subHit = findChitById(opts.corpRoot, opts.submissionId);
  if (!subHit || subHit.chit.type !== 'clearance-submission') {
    // Without the submission we can't author a meaningful escalation.
    // Release lock + worktree anyway so the lane unblocks.
    releaseClearinghouseLock({ corpRoot: opts.corpRoot, slug: opts.slug });
    if (opts.worktreePath) {
      await gitOps.worktreeRemove(opts.worktreePath, { force: true, cwd: opts.corpRoot }).catch(() => undefined);
    }
    return err(failure(
      'unknown',
      `fileBlocker: submission ${opts.submissionId} not found or wrong type. Lock + worktree released; escalation NOT created.`,
      `submissionId=${opts.submissionId}`,
    ));
  }
  const subChit = subHit.chit as Chit<'clearance-submission'>;
  const subFields = subChit.fields['clearance-submission'];

  // 2. Create the escalation chit. Body composes both summary and
  // detail in pedagogical shape (issue + why + what to do). The
  // routeTo override (Project 1.12.3) lets the caller route to a
  // role other than the author when attribution determines this
  // isn't the author's bug — e.g. main-regression goes to
  // engineering-lead, with originatingAuthor preserved in the body
  // so the substitute sees who's PR triggered the discovery.
  const recipient = opts.routeTo ?? subFields.submitter;
  const isReroute = recipient !== subFields.submitter;
  let escalationId: string | undefined;
  let escalationError: Error | undefined;
  try {
    const escalationFields: EscalationFields = {
      originatingChit: opts.submissionId,
      reason: opts.summary,
      from: opts.slug,
      to: recipient,
      severity: 'blocker',
    };
    const escalationChit = createChit(opts.corpRoot, {
      type: 'escalation',
      scope: 'corp',
      createdBy: opts.slug,
      fields: { escalation: escalationFields },
      body:
        `# Pressman blocker on ${subFields.branch}\n\n` +
        `**Kind:** ${opts.kind}\n` +
        `**Submission:** ${opts.submissionId}\n` +
        `**Task:** ${subFields.taskId}\n` +
        `**Originating author:** ${subFields.submitter}\n` +
        (isReroute ? `**Routed to:** ${recipient} (not the author — see attribution)\n` : '') +
        `\n## What happened\n\n${opts.summary}\n\n` +
        `## Detail\n\n${opts.detail}\n`,
    });
    escalationId = escalationChit.id;
  } catch (cause) {
    escalationError = cause instanceof Error ? cause : new Error(String(cause));
  }

  // 3. Mark submission failed (regardless of escalation outcome —
  // the submission isn't salvageable in this lane attempt).
  let markFailedError: Error | undefined;
  try {
    markSubmissionFailed({
      corpRoot: opts.corpRoot,
      submissionId: opts.submissionId,
      reason: `${opts.kind}: ${opts.summary}`,
      updatedBy: opts.slug,
    });
  } catch (cause) {
    markFailedError = cause instanceof Error ? cause : new Error(String(cause));
  }

  // 4. Release the lock + worktree no matter what.
  releaseClearinghouseLock({ corpRoot: opts.corpRoot, slug: opts.slug });
  if (opts.worktreePath) {
    await gitOps.worktreeRemove(opts.worktreePath, { force: true, cwd: opts.corpRoot }).catch(() => undefined);
  }

  // Emit submission-blocked. The agent's narrative comes from the
  // summary/detail it already supplied — we don't duplicate as a
  // separate narrative; the kind + payload tell the lane diary
  // what kind of blocker fired.
  emitLaneEvent({
    corpRoot: opts.corpRoot,
    submissionId: opts.submissionId,
    taskId: subFields.taskId,
    kind: 'submission-blocked',
    emittedBy: opts.slug,
    narrative: opts.summary,
    payload: {
      branch: subFields.branch,
      ...(escalationId ? { escalationId } : {}),
      failureCategory: opts.kind,
      failureSummary: opts.summary,
    },
  });

  if (escalationError) {
    return err(failure(
      'unknown',
      `fileBlocker: escalation chit creation failed for submission ${opts.submissionId}. Lock + worktree released; submission ${markFailedError ? 'NOT' : ''} marked failed.`,
      escalationError.stack ?? escalationError.message,
    ));
  }
  if (markFailedError) {
    return err(failure(
      'unknown',
      `fileBlocker: escalation ${escalationId} created but markSubmissionFailed threw. Submission may show as 'processing' until orphan recovery sweeps it.`,
      markFailedError.stack ?? markFailedError.message,
    ));
  }
  return ok({ escalationId: escalationId! });
}

// ─── markFailedAndRelease ────────────────────────────────────────────

export interface MarkFailedAndReleaseOpts {
  corpRoot: string;
  submissionId: string;
  /** One-sentence reason for the audit trail. Stored as `lastFailureReason`. */
  reason: string;
  slug: string;
  /**
   * If true, push-race re-queue path: increment retryCount, flip
   * back to 'queued' if under PRESSMAN_RETRY_CAP, otherwise terminal-fail.
   * Default false — terminal-fail without retry consideration.
   */
  requeue?: boolean;
  worktreePath?: string;
  gitOps?: GitOps;
  /**
   * Project 1.12.3 — agent's voice on the emitted lane-event when
   * the path terminal-fails (not on requeue, which doesn't emit).
   */
  narrative?: string | null;
}

export interface MarkFailedAndReleaseResult {
  /** True iff the submission was re-queued for another attempt. */
  readonly requeued: boolean;
  /** Final retryCount on the submission (post-update). */
  readonly retryCount: number;
}

/**
 * Terminal-fail OR re-queue + release. Two flavors driven by
 * `requeue`:
 *
 *   requeue=false (default): markSubmissionFailed cascades the
 *     task to failed. Lock + worktree released. Used for sanity-failed,
 *     branch-deleted, fatal, inconclusive-tests.
 *
 *   requeue=true: increment retryCount. If under PRESSMAN_RETRY_CAP,
 *     flip back to 'queued' for the next pick. Otherwise terminal-fail
 *     with reason "{reason}; retry cap exhausted." Used for push-race.
 *
 * The lock is always released. The worktree is best-effort removed.
 */
export async function markFailedAndRelease(
  opts: MarkFailedAndReleaseOpts,
): Promise<Result<MarkFailedAndReleaseResult>> {
  const gitOps = opts.gitOps ?? realGitOps;
  const requeue = opts.requeue === true;

  const subHit = findChitById(opts.corpRoot, opts.submissionId);
  if (!subHit || subHit.chit.type !== 'clearance-submission') {
    releaseClearinghouseLock({ corpRoot: opts.corpRoot, slug: opts.slug });
    if (opts.worktreePath) {
      await gitOps.worktreeRemove(opts.worktreePath, { force: true, cwd: opts.corpRoot }).catch(() => undefined);
    }
    return err(failure(
      'unknown',
      `markFailedAndRelease: submission ${opts.submissionId} not found.`,
      `submissionId=${opts.submissionId}`,
    ));
  }
  const subChit = subHit.chit as Chit<'clearance-submission'>;
  const subFields = subChit.fields['clearance-submission'];

  let requeued = false;
  let finalRetryCount = subFields.retryCount;

  try {
    if (requeue && subFields.retryCount < PRESSMAN_RETRY_CAP) {
      // Re-queue path: bump retryCount, flip status, clear processing slot.
      finalRetryCount = subFields.retryCount + 1;
      updateChit<'clearance-submission'>(opts.corpRoot, 'corp', 'clearance-submission', opts.submissionId, {
        updatedBy: opts.slug,
        fields: {
          'clearance-submission': {
            ...subFields,
            submissionStatus: 'queued',
            retryCount: finalRetryCount,
            processingBy: null,
            processingStartedAt: null,
            lastFailureReason: opts.reason,
          },
        },
      });
      requeued = true;
    } else {
      // Terminal fail. Reason notes cap exhaustion when requeue was
      // requested but we're past the cap.
      const reasonText = requeue
        ? `${opts.reason}; retry cap (${PRESSMAN_RETRY_CAP}) exhausted.`
        : opts.reason;
      markSubmissionFailed({
        corpRoot: opts.corpRoot,
        submissionId: opts.submissionId,
        reason: reasonText,
        updatedBy: opts.slug,
      });
    }
  } finally {
    releaseClearinghouseLock({ corpRoot: opts.corpRoot, slug: opts.slug });
    if (opts.worktreePath) {
      await gitOps.worktreeRemove(opts.worktreePath, { force: true, cwd: opts.corpRoot }).catch(() => undefined);
    }
  }

  // Emit submission-failed only on terminal fail. Requeue means
  // the submission isn't actually failing — it's going back in line
  // for another attempt; the next pickNext will emit submission-
  // claimed when it's re-claimed. No event for the requeue itself
  // (would clutter the diary with state-machine bookkeeping the
  // agent's voice can't enrich anyway).
  if (!requeued) {
    emitLaneEvent({
      corpRoot: opts.corpRoot,
      submissionId: opts.submissionId,
      taskId: subFields.taskId,
      kind: 'submission-failed',
      emittedBy: opts.slug,
      narrative: opts.narrative ?? null,
      payload: {
        branch: subFields.branch,
        failureSummary: opts.reason,
      },
    });
  }

  return ok({ requeued, retryCount: finalRetryCount });
}

// ─── cleanupOrphanWorktrees ──────────────────────────────────────────

export interface CleanupOrphanWorktreesOpts {
  corpRoot: string;
  gitOps?: GitOps;
}

export interface CleanupOrphanWorktreesResult {
  /** Worktree directories removed. */
  readonly removed: number;
  /** Worktree directories that failed to remove (logged but not surfaced as error). */
  readonly failed: number;
}

/**
 * Walk `<corpRoot>/.clearinghouse/{wt,editor-wt}-*` directories; remove
 * any whose id prefix doesn't match a live chit. Used at daemon boot
 * to clean up after a prior session that died mid-walk.
 *
 * Live sets:
 *   - For `wt-*` dirs: active clearance-submission chits.
 *   - For `editor-wt-*` dirs: active task chits whose
 *     `branchUnderReview` is non-null AND the task isn't terminal.
 *     We err on the side of keeping editor worktrees while a task is
 *     under_review or in any review-requested state — the next
 *     acquire force-removes anyway, so a stale dir from a recent
 *     session is harmless to keep around briefly.
 *
 * Best-effort per dir: a single failure doesn't poison the rest.
 * Returns counts so the caller can log a summary.
 */
export async function cleanupOrphanWorktrees(
  opts: CleanupOrphanWorktreesOpts,
): Promise<Result<CleanupOrphanWorktreesResult>> {
  const gitOps = opts.gitOps ?? realGitOps;
  const parent = join(opts.corpRoot, WORKTREE_PARENT_DIR);
  if (!existsSync(parent)) return ok({ removed: 0, failed: 0 });

  // Collect prefixes of submissions + review-eligible tasks that
  // should keep their worktrees.
  const liveSubmissionPrefixes = new Set<string>();
  const liveTaskPrefixes = new Set<string>();
  try {
    const shared = await import('@claudecorp/shared');
    const subs = shared.queryChits<'clearance-submission'>(opts.corpRoot, {
      types: ['clearance-submission'],
      scopes: ['corp'],
      statuses: ['active'],
    });
    for (const c of subs.chits) {
      const prefix = c.chit.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, WORKTREE_PREFIX_LEN);
      liveSubmissionPrefixes.add(prefix);
    }
    const tasks = shared.queryChits<'task'>(opts.corpRoot, {
      types: ['task'],
      statuses: ['active'],
    });
    for (const c of tasks.chits) {
      const f = c.chit.fields.task;
      // Keep editor-wt for tasks whose review state is in flight —
      // either explicitly requested or held by a claim.
      if (f.editorReviewRequested === true || (f.reviewerClaim ?? null) !== null) {
        const prefix = c.chit.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, WORKTREE_PREFIX_LEN);
        liveTaskPrefixes.add(prefix);
      }
    }
  } catch {
    // Chit query failure: be conservative and don't remove anything.
    // The next sweep / acquire path force-removes individually.
    return ok({ removed: 0, failed: 0 });
  }

  let entries: string[];
  try {
    const fs = await import('node:fs');
    entries = fs.readdirSync(parent);
  } catch (cause) {
    return err(failure(
      'unknown',
      `cleanupOrphanWorktrees: cannot read ${parent}`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }

  let removed = 0;
  let failed = 0;
  for (const name of entries) {
    let prefix: string | null = null;
    let kindLive: Set<string> | null = null;
    const editorMatch = name.match(/^editor-wt-([a-zA-Z0-9_-]+)$/);
    if (editorMatch) {
      prefix = editorMatch[1]!;
      kindLive = liveTaskPrefixes;
    } else {
      const pressmanMatch = name.match(/^wt-([a-zA-Z0-9_-]+)$/);
      if (pressmanMatch) {
        prefix = pressmanMatch[1]!;
        kindLive = liveSubmissionPrefixes;
      }
    }
    if (!prefix || !kindLive) continue;
    if (kindLive.has(prefix)) continue;
    const path = join(parent, name);
    const result = await gitOps.worktreeRemove(path, { force: true, cwd: opts.corpRoot });
    if (result.ok) removed++;
    else failed++;
  }
  return ok({ removed, failed });
}

// ─── releaseAll ──────────────────────────────────────────────────────

export interface ReleaseAllOpts {
  corpRoot: string;
  slug: string;
  worktreePath?: string;
  gitOps?: GitOps;
}

/**
 * Bare cleanup — release the lock + remove the worktree, no chit
 * changes. Used by the agent on graceful exit paths where the
 * submission state has already been written by an earlier primitive
 * (e.g. agent realized it had nothing to do mid-walk; or a prior
 * call handled the terminal state and the agent just needs to tidy).
 */
export async function releaseAll(opts: ReleaseAllOpts): Promise<Result<void>> {
  const gitOps = opts.gitOps ?? realGitOps;
  releaseClearinghouseLock({ corpRoot: opts.corpRoot, slug: opts.slug });
  if (opts.worktreePath) {
    await gitOps.worktreeRemove(opts.worktreePath, { force: true, cwd: opts.corpRoot }).catch(() => undefined);
  }
  return ok(undefined);
}
