/**
 * Editor workflow primitives (Project 1.12.2).
 *
 * Stateless step functions composed by the Editor session via
 * `cc-cli editor <verb>` subcommands. Mirrors {@link ./workflow.ts}'s
 * shape for Pressman: every primitive runs in a fresh CLI process,
 * returns Result<T>, operates only on on-disk state.
 *
 * ### The two-pass review
 *
 * Editor's job is to read the author's diff before it leaves the
 * sandbox and apply two passes:
 *
 *   - **Bug pass** — Codex's 8+8 rules over the diff + related
 *     unmodified files. Comments tagged `category: 'bug'`.
 *   - **Drift pass** — implementation vs. spec. Read
 *     task.acceptanceCriteria + contract.goal alongside the diff;
 *     flag underdevelopment, scope creep, underplanning. Comments
 *     tagged `category: 'drift'`. Where Editor beats Codex.
 *
 * Both passes use the same severity vocabulary (blocker / suggestion /
 * nit). A drift-blocker is "missed half the acceptance criteria"; a
 * bug-nit is a typo in a comment. The category × severity matrix is
 * what surfaces in Sexton's wake digest.
 *
 * ### Lane state lives on the task chit
 *
 * Pressman's lane state is a clearance-submission chit. Editor's
 * lane state is on the task itself: `editorReviewRequested`,
 * `editorReviewRound`, `editorReviewCapHit`, `reviewerClaim`,
 * `branchUnderReview`. That's because Editor runs PRE-submission —
 * the clearance-submission chit is created by enterClearance after
 * Editor approves.
 *
 * ### Branch capture
 *
 * Audit captures the author's branch into `task.branchUnderReview`
 * at the moment it sets `editorReviewRequested = true`. Editor reads
 * it from the task — never touches the author's sandbox. This
 * decouples Editor's review timing from whatever the author's
 * sandbox is doing later.
 */

import { join } from 'node:path';
import {
  createChit,
  findChitById,
  updateChit,
  chitScopeFromPath,
  queryChits,
  readConfig,
  validateTransition,
  TaskTransitionError,
  ChitConcurrentModificationError,
  MEMBERS_JSON,
  EDITOR_REVIEW_ROUND_CAP_DEFAULT,
  getRole,
  type Chit,
  type Member,
  type ContractFields,
  type EscalationFields,
  type LaneEventFields,
  type LaneEventKind,
  type LaneEventPayload,
  type ReviewCommentFields,
  type TaskFields,
  type TaskWorkflowStatus,
} from '@claudecorp/shared';
import { failure, ok, err, type Result } from './failure-taxonomy.js';
import { realGitOps, type GitOps } from './git-ops.js';
import { acquireWorktree, emitLaneEvent, type AcquiredWorktree } from './workflow.js';
import { enterClearance } from './enter-clearance.js';

// ─── Shapes ──────────────────────────────────────────────────────────

export interface PickedReview {
  readonly taskId: string;
  readonly contractId: string | null;
  readonly branch: string;
  readonly submitter: string;
  readonly priority: 'critical' | 'high' | 'normal' | 'low';
  /** Number of prior rejections — comment.reviewRound on this pass = currentRound + 1. */
  readonly currentRound: number;
  /** True iff this Editor's claim was already on the task at pick time. */
  readonly resumed: boolean;
}

export interface ReviewContext {
  readonly taskId: string;
  readonly branchUnderReview: string;
  readonly currentRound: number;
  readonly task: TaskFields;
  readonly contract: ContractFields | null;
  readonly contractId: string | null;
}

export interface ApproveReviewResult {
  readonly submissionId: string;
  readonly pushedSha?: string;
  readonly reviewRound: number;
}

export interface RejectReviewResult {
  readonly newRound: number;
  readonly capHit: boolean;
  readonly escalationId: string;
}

export interface BypassReviewResult {
  readonly submissionId: string;
  readonly pushedSha?: string;
  readonly reviewRound: number;
}

// ─── isEditorAwareCorp ───────────────────────────────────────────────

/**
 * Pre-check: is this corp using the Editor review phase? Audit
 * calls this to decide whether to dispatch Editor before firing
 * enterClearance. Mirrors `isClearinghouseAwareCorp` — both filters
 * (role + type=agent + non-archived) so audit and dispatch agree.
 */
export function isEditorAwareCorp(corpRoot: string): boolean {
  try {
    const members = readConfig<Array<{ role?: string; type?: string; status?: string }>>(
      join(corpRoot, MEMBERS_JSON),
    );
    return members.some(
      (m) => m.role === 'editor' && m.type === 'agent' && m.status !== 'archived',
    );
  } catch {
    return false;
  }
}

// ─── setEditorReviewRequested ────────────────────────────────────────

export interface SetEditorReviewRequestedOpts {
  corpRoot: string;
  taskId: string;
  /** Author's branch — captured snapshot Editor will check out. */
  branchUnderReview: string;
  /** Member.id of who fired the request (typically the author / audit-running agent). */
  requestedBy: string;
}

/**
 * Audit calls this on the editor-aware-approve path. Sets
 * `editorReviewRequested = true` and stamps `branchUnderReview`.
 * No claim is set — Editor's `pickNextReview` claims atomically.
 *
 * Idempotent against re-fires: if the task already has the flag
 * set (and no claim is held), this is a no-op success. If a claim
 * IS held (Editor mid-review), it's also a no-op — the in-flight
 * review will resolve via approve / reject and audit re-fires next
 * cycle if needed.
 *
 * Defensive: refuses to set the flag on a task that isn't at
 * `workflowStatus === 'under_review'`. Audit's invariant is to
 * only call from the approve path (which always lands tasks at
 * under_review) — but if a future caller fires this from elsewhere
 * we'd silently mark non-review-eligible tasks for review and
 * Editor would either skip them (workflowStatus filter in
 * pickNextReview) or process them incorrectly. Reject loudly.
 */
export function setEditorReviewRequested(
  opts: SetEditorReviewRequestedOpts,
): Result<void> {
  const hit = findChitById(opts.corpRoot, opts.taskId);
  if (!hit || hit.chit.type !== 'task') {
    return err(failure(
      'unknown',
      `setEditorReviewRequested: task ${opts.taskId} not found or wrong type`,
      `taskId=${opts.taskId}`,
    ));
  }
  const taskChit = hit.chit as Chit<'task'>;
  const taskFields = taskChit.fields.task;

  if (taskFields.workflowStatus !== 'under_review') {
    return err(failure(
      'unknown',
      `setEditorReviewRequested: task ${opts.taskId} is at workflowStatus='${taskFields.workflowStatus ?? 'unknown'}', expected 'under_review'`,
      'audit fires this only on the approve path; non-approve callers indicate a logic error',
    ));
  }

  // Already requested + no in-flight claim? Idempotent no-op.
  if (taskFields.editorReviewRequested === true && (taskFields.reviewerClaim ?? null) === null) {
    // Update branch in case author rebased between requests.
    if (taskFields.branchUnderReview === opts.branchUnderReview) {
      return ok(undefined);
    }
  }

  const scope = chitScopeFromPath(opts.corpRoot, hit.path);
  try {
    updateChit<'task'>(opts.corpRoot, scope, 'task', taskChit.id, {
      updatedBy: opts.requestedBy,
      fields: {
        task: {
          ...taskFields,
          editorReviewRequested: true,
          branchUnderReview: opts.branchUnderReview,
        },
      },
    });
  } catch (cause) {
    return err(failure(
      'unknown',
      `setEditorReviewRequested: chit update failed for ${opts.taskId}`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }
  return ok(undefined);
}

// ─── pickNextReview ──────────────────────────────────────────────────

export interface PickNextReviewOpts {
  corpRoot: string;
  /** Editor's Member.id. Must exist with role='editor' in members.json. */
  editorSlug: string;
}

const PRIORITY_RANK: Record<NonNullable<TaskFields['priority']>, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Pick the next task ready for review. Three outcomes:
 *
 *   - ok(picked, resumed=true): the task already has this Editor's
 *     claim. Resume mid-review (e.g. session crash recovery).
 *   - ok(picked, resumed=false): pick a fresh review-eligible task,
 *     atomically claim it (set reviewerClaim).
 *   - ok(null): nothing to do — either no requested tasks, or the
 *     ones requested are claimed by another live Editor.
 *
 * Eligibility: editorReviewRequested === true AND
 * !editorReviewCapHit AND workflowStatus === 'under_review' AND
 * branchUnderReview is non-null.
 *
 * Ordering: priority asc (critical first) then createdAt asc
 * (FIFO within priority). Same intuition as the Pressman queue
 * but on the task chit's priority field.
 */
export function pickNextReview(opts: PickNextReviewOpts): Result<PickedReview | null> {
  // 1. Validate the slug resolves to a hired Editor.
  let editor: Member | undefined;
  try {
    const members = readConfig<Member[]>(join(opts.corpRoot, MEMBERS_JSON));
    editor = members.find(
      (m) => m.id === opts.editorSlug && m.role === 'editor' && m.status !== 'archived',
    );
  } catch (cause) {
    return err(failure(
      'unknown',
      `pickNextReview: cannot read members.json (${MEMBERS_JSON})`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }
  if (!editor) {
    return err(failure(
      'unknown',
      `pickNextReview: no Editor with id='${opts.editorSlug}' (or archived)`,
      `slug=${opts.editorSlug}`,
    ));
  }

  // 2. Query all active tasks. We filter in code rather than via
  // the chit-store query because review-eligibility depends on
  // multiple field combinations.
  let tasks: ReturnType<typeof queryChits<'task'>>;
  try {
    tasks = queryChits<'task'>(opts.corpRoot, {
      types: ['task'],
      statuses: ['active'],
    });
  } catch (cause) {
    return err(failure(
      'unknown',
      'pickNextReview: queryChits failed',
      cause instanceof Error ? cause.message : String(cause),
    ));
  }

  // 3. Resume path — if a task already has this Editor's claim,
  // return it without re-claiming. BUT recheck eligibility before
  // returning: clearTaskReviewState (called from approveReview) is
  // best-effort and swallows update failures, so a task that
  // actually moved to clearance state may still carry our stale
  // claim. Without the recheck, this resume branch would keep
  // returning that ghost task forever, starving real pending
  // reviews. (Codex P2 #2 from PR #195 round 4.)
  for (const c of tasks.chits) {
    const t = c.chit as Chit<'task'>;
    const f = t.fields.task;
    if (f.reviewerClaim?.slug !== opts.editorSlug) continue;

    const stillEligible =
      f.editorReviewRequested === true
      && f.editorReviewCapHit !== true
      && f.workflowStatus === 'under_review'
      && Boolean(f.branchUnderReview);

    if (stillEligible) {
      const resumed = toPickedReview(t, opts.corpRoot, true);
      if (resumed) return ok(resumed);
      continue;
    }

    // Stale self-claim — task moved on (approve cascade dropped its
    // request flag, audit moved it to clearance, etc). Best-effort
    // clear the stale claim so the slot frees up; fall through to
    // the fresh-pick path so we don't return null when other work
    // is ready.
    try {
      const scope = chitScopeFromPath(opts.corpRoot, c.path);
      updateChit<'task'>(opts.corpRoot, scope, 'task', t.id, {
        updatedBy: opts.editorSlug,
        expectedUpdatedAt: t.updatedAt,
        fields: {
          task: {
            ...f,
            reviewerClaim: null,
          },
        },
      });
    } catch {
      // Concurrent write or any failure — leave for the
      // resumeEditorReviews sweep to clean up.
    }
  }

  // 4. Fresh-pick path. Filter for eligibility, sort, claim top.
  const eligible: Array<Chit<'task'>> = [];
  for (const c of tasks.chits) {
    const t = c.chit as Chit<'task'>;
    const f = t.fields.task;
    if (f.editorReviewRequested !== true) continue;
    if (f.editorReviewCapHit === true) continue;
    if ((f.reviewerClaim ?? null) !== null) continue; // claimed by someone else
    if (f.workflowStatus !== 'under_review') continue;
    if (!f.branchUnderReview) continue;
    eligible.push(t);
  }
  if (eligible.length === 0) return ok(null);

  eligible.sort((a, b) => {
    const pa = PRIORITY_RANK[a.fields.task.priority] ?? 2;
    const pb = PRIORITY_RANK[b.fields.task.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    const aCreated = (a.createdAt ?? '');
    const bCreated = (b.createdAt ?? '');
    return aCreated.localeCompare(bCreated);
  });

  const top = eligible[0]!;
  // 5. Claim atomically — re-read the task to confirm no other
  // Editor beat us, then write with expectedUpdatedAt so a
  // concurrent claim between our read and our write throws
  // ChitConcurrentModificationError instead of clobbering.
  // Without optimistic concurrency, two Editors running in
  // parallel can both pass the null-claim check and both
  // overwrite each other's claim — last writer wins, both
  // sessions believe they have the claim, one fails downstream
  // in approveReview / fileReviewComment after doing review work.
  // (Codex P2 #1 from PR #195 round 4.)
  const reread = findChitById(opts.corpRoot, top.id);
  if (!reread || reread.chit.type !== 'task') return ok(null);
  const rereadTask = reread.chit as Chit<'task'>;
  if ((rereadTask.fields.task.reviewerClaim ?? null) !== null) return ok(null);

  const scope = chitScopeFromPath(opts.corpRoot, reread.path);
  const now = new Date().toISOString();
  try {
    updateChit<'task'>(opts.corpRoot, scope, 'task', rereadTask.id, {
      updatedBy: opts.editorSlug,
      expectedUpdatedAt: rereadTask.updatedAt,
      fields: {
        task: {
          ...rereadTask.fields.task,
          reviewerClaim: { slug: opts.editorSlug, claimedAt: now },
        },
      },
    });
  } catch (cause) {
    if (cause instanceof ChitConcurrentModificationError) {
      // Lost the race to a concurrent Editor. Yield — next wake
      // re-evaluates, and the winner is now claim-holder.
      return ok(null);
    }
    return err(failure(
      'unknown',
      `pickNextReview: failed to claim task ${rereadTask.id}`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }

  const picked = toPickedReview(rereadTask, opts.corpRoot, false);

  // Emit editor-claimed. submissionId is null — Editor runs pre-
  // submission, the clearance-submission chit doesn't exist yet.
  // The taskId carries the canonical link.
  if (picked) {
    emitLaneEvent({
      corpRoot: opts.corpRoot,
      submissionId: null,
      taskId: rereadTask.id,
      kind: 'editor-claimed',
      emittedBy: opts.editorSlug,
      payload: {
        branch: rereadTask.fields.task.branchUnderReview ?? undefined,
        reviewRound: rereadTask.fields.task.editorReviewRound ?? 0,
      },
    });
  }

  return ok(picked);
}

function toPickedReview(taskChit: Chit<'task'>, corpRoot: string, resumed: boolean): PickedReview | null {
  const f = taskChit.fields.task;
  if (!f.branchUnderReview) return null;
  const contractId = findContractContainingTask(corpRoot, taskChit.id);
  return {
    taskId: taskChit.id,
    contractId,
    branch: f.branchUnderReview,
    submitter: f.assignee ?? f.handedBy ?? 'unknown',
    priority: f.priority,
    currentRound: f.editorReviewRound ?? 0,
    resumed,
  };
}

function findContractContainingTask(corpRoot: string, taskId: string): string | null {
  try {
    const result = queryChits<'contract'>(corpRoot, { types: ['contract'] });
    for (const c of result.chits) {
      const fields = c.chit.fields.contract;
      if (fields.taskIds?.includes(taskId)) return c.chit.id;
    }
  } catch {
    return null;
  }
  return null;
}

// ─── acquireEditorWorktree ───────────────────────────────────────────

export interface AcquireEditorWorktreeOpts {
  corpRoot: string;
  /** Task being reviewed. Drives the deterministic worktree path. */
  taskId: string;
  /** Branch to check out — typically task.branchUnderReview. */
  branch: string;
  gitOps?: GitOps;
}

/**
 * Editor's worktree-acquire — same primitive as Pressman's, but
 * keyed off taskId (immutable) and namespaced under
 * `<corpRoot>/.clearinghouse/editor-wt-<taskId-prefix>` so it
 * can't collide with Pressman's `wt-<submissionId-prefix>` dirs.
 */
export async function acquireEditorWorktree(
  opts: AcquireEditorWorktreeOpts,
): Promise<Result<AcquiredWorktree>> {
  return acquireWorktree({
    corpRoot: opts.corpRoot,
    submissionId: opts.taskId, // doubles as the deterministic-id input
    branch: opts.branch,
    pathPrefix: 'editor-wt',
    ...(opts.gitOps ? { gitOps: opts.gitOps } : {}),
  });
}

// ─── loadReviewContext ───────────────────────────────────────────────

export interface LoadReviewContextOpts {
  corpRoot: string;
  taskId: string;
}

/**
 * Bundle the task + contract metadata Editor needs to do both
 * passes: the diff context for the bug pass, the spec context
 * (acceptanceCriteria, contract.goal) for the drift pass.
 *
 * Failure modes:
 *   - task missing → err
 *   - branchUnderReview missing → err (not review-eligible)
 *   - contract missing → ok with contract=null (standalone task;
 *     Editor still reviews acceptanceCriteria but skips
 *     contract.goal alignment)
 */
export function loadReviewContext(opts: LoadReviewContextOpts): Result<ReviewContext> {
  const hit = findChitById(opts.corpRoot, opts.taskId);
  if (!hit || hit.chit.type !== 'task') {
    return err(failure(
      'unknown',
      `loadReviewContext: task ${opts.taskId} not found`,
      `taskId=${opts.taskId}`,
    ));
  }
  const taskChit = hit.chit as Chit<'task'>;
  const taskFields = taskChit.fields.task;
  if (!taskFields.branchUnderReview) {
    return err(failure(
      'unknown',
      `loadReviewContext: task ${opts.taskId} has no branchUnderReview — not review-eligible`,
      'expected branchUnderReview to be set by audit',
    ));
  }

  let contractId: string | null = null;
  let contract: ContractFields | null = null;
  try {
    const result = queryChits<'contract'>(opts.corpRoot, { types: ['contract'] });
    for (const c of result.chits) {
      if (c.chit.fields.contract.taskIds?.includes(opts.taskId)) {
        contractId = c.chit.id;
        contract = c.chit.fields.contract;
        break;
      }
    }
  } catch {
    // Soft-fail — contract lookup is best-effort.
  }

  return ok({
    taskId: opts.taskId,
    branchUnderReview: taskFields.branchUnderReview,
    currentRound: taskFields.editorReviewRound ?? 0,
    task: taskFields,
    contract,
    contractId,
  });
}

// ─── fileReviewComment ───────────────────────────────────────────────

export interface FileReviewCommentOpts {
  corpRoot: string;
  taskId: string;
  reviewerSlug: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  severity: 'blocker' | 'suggestion' | 'nit';
  category: 'bug' | 'drift';
  issue: string;
  why: string;
  suggestedPatch?: string | null;
  /** 1-indexed review pass number — typically `task.editorReviewRound + 1`. */
  reviewRound: number;
}

export interface FileReviewCommentResult {
  readonly commentId: string;
}

/**
 * Create a review-comment chit. Verifies the slug holds the
 * task's claim — comments authored without a claim risk being
 * out-of-band noise. Fails with err if no claim or wrong holder.
 */
export function fileReviewComment(
  opts: FileReviewCommentOpts,
): Result<FileReviewCommentResult> {
  const hit = findChitById(opts.corpRoot, opts.taskId);
  if (!hit || hit.chit.type !== 'task') {
    return err(failure(
      'unknown',
      `fileReviewComment: task ${opts.taskId} not found`,
      `taskId=${opts.taskId}`,
    ));
  }
  const taskFields = (hit.chit as Chit<'task'>).fields.task;
  if (taskFields.reviewerClaim?.slug !== opts.reviewerSlug) {
    return err(failure(
      'unknown',
      `fileReviewComment: ${opts.reviewerSlug} does not hold the claim on ${opts.taskId}`,
      `claim=${JSON.stringify(taskFields.reviewerClaim)}`,
    ));
  }

  const fields: ReviewCommentFields = {
    submissionId: null, // pre-submission; submission may be created later by approve
    taskId: opts.taskId,
    reviewerSlug: opts.reviewerSlug,
    filePath: opts.filePath,
    lineStart: opts.lineStart,
    lineEnd: opts.lineEnd,
    severity: opts.severity,
    category: opts.category,
    issue: opts.issue,
    why: opts.why,
    ...(opts.suggestedPatch !== undefined ? { suggestedPatch: opts.suggestedPatch } : {}),
    reviewRound: opts.reviewRound,
  };

  let commentChit: Chit<'review-comment'>;
  try {
    commentChit = createChit<'review-comment'>(opts.corpRoot, {
      type: 'review-comment',
      scope: 'corp',
      createdBy: opts.reviewerSlug,
      fields: { 'review-comment': fields },
    });
  } catch (cause) {
    return err(failure(
      'unknown',
      `fileReviewComment: chit creation failed`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }
  return ok({ commentId: commentChit.id });
}

// ─── approveReview ───────────────────────────────────────────────────

export interface ApproveReviewOpts {
  corpRoot: string;
  taskId: string;
  reviewerSlug: string;
  /** Editor's worktree path — used as cwd for `git push`. */
  worktreePath: string;
  gitOps?: GitOps;
  /** Project 1.12.3 — agent's voice on the emitted lane-event. */
  narrative?: string | null;
}

/**
 * Editor's "this passes review" exit. Verifies claim, fires
 * enterClearance with reviewBypassed=false + the current round
 * count, clears the review state on the task on success.
 *
 * Failures from enterClearance bubble — the task stays at
 * under_review with the claim still held, so a retry path
 * (Editor re-running approve) can address. Editor's session
 * decides whether to retry or bail to releaseReview.
 */
export async function approveReview(
  opts: ApproveReviewOpts,
): Promise<Result<ApproveReviewResult>> {
  const gitOps = opts.gitOps ?? realGitOps;
  const ctx = loadReviewContext({ corpRoot: opts.corpRoot, taskId: opts.taskId });
  if (!ctx.ok) return err(ctx.failure);
  const { branchUnderReview, currentRound, task, contractId } = ctx.value;

  if (task.reviewerClaim?.slug !== opts.reviewerSlug) {
    return err(failure(
      'unknown',
      `approveReview: ${opts.reviewerSlug} does not hold the claim on ${opts.taskId}`,
      `claim=${JSON.stringify(task.reviewerClaim)}`,
    ));
  }

  if (!contractId) {
    return err(failure(
      'unknown',
      `approveReview: task ${opts.taskId} has no parent contract — Editor's approve path requires one`,
      'standalone tasks should bypass Editor entirely',
    ));
  }

  const submitter = task.assignee ?? task.handedBy ?? null;
  if (!submitter) {
    return err(failure(
      'unknown',
      `approveReview: task ${opts.taskId} has no assignee or handedBy — cannot resolve submitter`,
      'expected task.assignee or task.handedBy to be set',
    ));
  }

  const ec = await enterClearance({
    corpRoot: opts.corpRoot,
    taskId: opts.taskId,
    contractId,
    branch: branchUnderReview,
    submitter,
    worktreePath: opts.worktreePath,
    reviewBypassed: false,
    reviewRound: currentRound,
    gitOps,
  });
  if (!ec.ok) return err(ec.failure);

  // Clear review state on success.
  clearTaskReviewState(opts.corpRoot, opts.taskId, opts.reviewerSlug);

  // Emit editor-approved. The submission was just created by
  // enterClearance — populate submissionId so log-readers can
  // join Editor's approve to the subsequent Pressman events on
  // the same submission.
  emitLaneEvent({
    corpRoot: opts.corpRoot,
    submissionId: ec.value.submissionId,
    taskId: opts.taskId,
    kind: 'editor-approved',
    emittedBy: opts.reviewerSlug,
    narrative: opts.narrative ?? null,
    payload: {
      branch: branchUnderReview,
      reviewRound: currentRound,
      ...(ec.value.pushedSha ? { mergeCommitSha: ec.value.pushedSha } : {}),
    },
  });

  const out: ApproveReviewResult = {
    submissionId: ec.value.submissionId,
    reviewRound: currentRound,
    ...(ec.value.pushedSha ? { pushedSha: ec.value.pushedSha } : {}),
  };
  return ok(out);
}

// ─── rejectReview ────────────────────────────────────────────────────

export interface RejectReviewOpts {
  corpRoot: string;
  taskId: string;
  reviewerSlug: string;
  /** One-line summary of the rejection — appears in escalation chit reason. */
  reason: string;
  /** Pedagogical body for the escalation chit; should reference the per-comment chits. */
  detail: string;
  /**
   * Project 1.12.3 — agent's voice on the emitted lane-event.
   * Default falls back to opts.reason when null/absent (the
   * rejection summary IS the agent's voice on this transition).
   */
  narrative?: string | null;
}

/**
 * Editor's "needs more work" exit. Increments
 * `task.editorReviewRound`, sets `editorReviewCapHit` if the cap
 * is reached, clears review-request state, files an escalation
 * chit (severity=blocker) routed to the author so Hand 1.4.1
 * dispatches a substitute (or wakes the original).
 *
 * Cap is `RoleEntry.editorReviewRoundCap` for the author's role
 * (defaults to `EDITOR_REVIEW_ROUND_CAP_DEFAULT` from PR 1
 * substrate). Once capHit, audit's next approve pass bypasses
 * Editor and fires enterClearance with reviewBypassed=true.
 */
export function rejectReview(opts: RejectReviewOpts): Result<RejectReviewResult> {
  const hit = findChitById(opts.corpRoot, opts.taskId);
  if (!hit || hit.chit.type !== 'task') {
    return err(failure(
      'unknown',
      `rejectReview: task ${opts.taskId} not found`,
      `taskId=${opts.taskId}`,
    ));
  }
  const taskChit = hit.chit as Chit<'task'>;
  const taskFields = taskChit.fields.task;

  if (taskFields.reviewerClaim?.slug !== opts.reviewerSlug) {
    return err(failure(
      'unknown',
      `rejectReview: ${opts.reviewerSlug} does not hold the claim on ${opts.taskId}`,
      `claim=${JSON.stringify(taskFields.reviewerClaim)}`,
    ));
  }

  const newRound = (taskFields.editorReviewRound ?? 0) + 1;
  const cap = resolveCap(opts.corpRoot, taskFields);
  const capHit = newRound >= cap;
  const submitter = taskFields.assignee ?? taskFields.handedBy ?? 'unknown';

  // Resolve the under_review → in_progress transition via the
  // 'audit-block' trigger (mirrors revertTaskFromUnderReview's
  // pattern). Without flipping workflowStatus back, `cc-cli done`
  // refuses to handoff (it requires in_progress) and the author
  // can't re-submit after fixing the comments. Task would strand
  // until manual intervention. (Codex P1 from PR #195 round 3.)
  //
  // Falls through to keeping the workflowStatus on the rare case
  // where the transition is rejected (pre-1.3 chits without
  // workflowStatus, or a state we don't expect — audit-block
  // doesn't transition from non-under_review states cleanly).
  // The escalation chit still gets filed; the task just doesn't
  // get its workflow advanced. Founder can manually fix.
  let nextWorkflowStatus: TaskWorkflowStatus | null | undefined =
    taskFields.workflowStatus;
  if (taskFields.workflowStatus) {
    try {
      nextWorkflowStatus = validateTransition(
        taskFields.workflowStatus,
        'audit-block',
        taskChit.id,
      );
    } catch (cause) {
      if (!(cause instanceof TaskTransitionError)) throw cause;
      // Keep the existing workflowStatus; escalation will still surface.
    }
  }

  // Order matters for failure recovery: file the escalation chit
  // FIRST. If escalation creation fails, the task is unchanged and
  // the reviewer can retry rejectReview cleanly. The previous order
  // (task mutation first, escalation second) left the task with
  // claim/branch cleared but no escalation when escalation fails —
  // limbo state requiring manual intervention. (Codex P2 from PR
  // #195 round 3.)
  const escalationFields: EscalationFields = {
    originatingChit: opts.taskId,
    reason: opts.reason,
    from: opts.reviewerSlug,
    to: submitter,
    severity: 'blocker',
  };
  let escalationId: string;
  try {
    const escalation = createChit(opts.corpRoot, {
      type: 'escalation',
      scope: 'corp',
      createdBy: opts.reviewerSlug,
      fields: { escalation: escalationFields },
      body:
        `# Editor review — round ${newRound}${capHit ? ' (cap hit)' : ''}\n\n` +
        `**Task:** ${opts.taskId}\n` +
        `**Originating author:** ${submitter}\n` +
        `**Round:** ${newRound} / ${cap}${capHit ? ' (cap reached — next audit will bypass)' : ''}\n\n` +
        `## Rejection summary\n\n${opts.reason}\n\n` +
        `## Detail\n\n${opts.detail}\n\n` +
        `## Comments\n\n` +
        `Per-line comments are filed as review-comment chits with taskId=${opts.taskId}. Query: \`cc-cli chit list --type review-comment --task ${opts.taskId}\`.\n`,
    });
    escalationId = escalation.id;
  } catch (cause) {
    return err(failure(
      'unknown',
      `rejectReview: escalation chit creation failed; task unchanged, reviewer can retry`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }

  // Now mutate the task: increment round, maybe set capHit,
  // transition workflowStatus back to in_progress, clear review
  // state (next audit-approve re-fires with a fresh branch capture).
  // If THIS step fails after the escalation was filed, we have a
  // ghost escalation but the task is at least retryable — better
  // than the inverse failure mode which was caught by Codex.
  const scope = chitScopeFromPath(opts.corpRoot, hit.path);
  try {
    updateChit<'task'>(opts.corpRoot, scope, 'task', taskChit.id, {
      updatedBy: opts.reviewerSlug,
      fields: {
        task: {
          ...taskFields,
          ...(nextWorkflowStatus ? { workflowStatus: nextWorkflowStatus } : {}),
          editorReviewRound: newRound,
          editorReviewCapHit: capHit,
          editorReviewRequested: false,
          reviewerClaim: null,
          branchUnderReview: null,
        },
      },
    });
  } catch (cause) {
    return err(failure(
      'unknown',
      `rejectReview: escalation ${escalationId} created but task chit update failed; task may be retryable but escalation already filed`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }

  // Emit editor-rejected. submissionId is null — Editor's reject
  // never reaches enterClearance; the next round (or cap-bypass)
  // is the one that creates a submission. Narrative defaults to
  // the rejection summary when the caller didn't supply one
  // explicitly.
  emitLaneEvent({
    corpRoot: opts.corpRoot,
    submissionId: null,
    taskId: opts.taskId,
    kind: 'editor-rejected',
    emittedBy: opts.reviewerSlug,
    narrative: opts.narrative ?? opts.reason,
    payload: {
      reviewRound: newRound,
      capHit,
      escalationId,
      failureSummary: opts.reason,
    },
  });

  return ok({ newRound, capHit, escalationId });
}

function resolveCap(corpRoot: string, taskFields: TaskFields): number {
  // Cap lookup walks slug → members.json → role → role's
  // editorReviewRoundCap, falling back to the default. assignee /
  // handedBy fields can hold either a slug (specific Member.id) or
  // a role string — try both interpretations so per-role caps
  // actually apply when the task is slug-assigned (the common case).
  const candidates = [taskFields.assignee, taskFields.handedBy].filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );

  let members: Member[] | null = null;
  try {
    members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  } catch {
    // members.json unreadable — fall through to role-string-only
    // resolution + default.
  }

  for (const candidate of candidates) {
    // First: candidate-as-slug → resolve role via members.json.
    if (members) {
      const member = members.find((m) => m.id === candidate);
      if (member?.role) {
        const role = getRole(member.role);
        if (role && typeof role.editorReviewRoundCap === 'number') {
          return role.editorReviewRoundCap;
        }
      }
    }
    // Second: candidate-as-role-string (legacy / unassigned tasks).
    const role = getRole(candidate);
    if (role && typeof role.editorReviewRoundCap === 'number') {
      return role.editorReviewRoundCap;
    }
  }
  return EDITOR_REVIEW_ROUND_CAP_DEFAULT;
}

// ─── bypassReview ────────────────────────────────────────────────────

export interface BypassReviewOpts {
  corpRoot: string;
  taskId: string;
  reviewerSlug: string;
  /** Why Editor self-bypassed — recorded for retrospective. */
  reason: string;
  worktreePath: string;
  gitOps?: GitOps;
  /**
   * Project 1.12.3 — agent's voice on the emitted lane-event.
   * Defaults to opts.reason when null/absent.
   */
  narrative?: string | null;
}

/**
 * Editor's explicit self-bypass — sets capHit=true, fires
 * enterClearance with reviewBypassed=true. Rare: typical bypass
 * comes from the audit layer when the cap is reached automatically.
 * Editor would use this when its own session decides "this work
 * isn't reviewable in any meaningful way; ship it and let
 * downstream signals handle it."
 */
export async function bypassReview(
  opts: BypassReviewOpts,
): Promise<Result<BypassReviewResult>> {
  const gitOps = opts.gitOps ?? realGitOps;
  const ctx = loadReviewContext({ corpRoot: opts.corpRoot, taskId: opts.taskId });
  if (!ctx.ok) return err(ctx.failure);
  const { branchUnderReview, currentRound, task, contractId } = ctx.value;

  if (task.reviewerClaim?.slug !== opts.reviewerSlug) {
    return err(failure(
      'unknown',
      `bypassReview: ${opts.reviewerSlug} does not hold the claim on ${opts.taskId}`,
      `claim=${JSON.stringify(task.reviewerClaim)}`,
    ));
  }
  if (!contractId) {
    return err(failure(
      'unknown',
      `bypassReview: task ${opts.taskId} has no parent contract`,
      'standalone tasks should bypass Editor at the audit layer',
    ));
  }
  const submitter = task.assignee ?? task.handedBy ?? null;
  if (!submitter) {
    return err(failure(
      'unknown',
      `bypassReview: task ${opts.taskId} has no submitter`,
      'expected task.assignee or task.handedBy to be set',
    ));
  }

  const ec = await enterClearance({
    corpRoot: opts.corpRoot,
    taskId: opts.taskId,
    contractId,
    branch: branchUnderReview,
    submitter,
    worktreePath: opts.worktreePath,
    reviewBypassed: true,
    reviewRound: currentRound,
    gitOps,
  });
  if (!ec.ok) return err(ec.failure);

  // Mark capHit + clear review state + record the reason on the task
  // (via output annotation; cleaner places exist but minimal v1).
  const hit = findChitById(opts.corpRoot, opts.taskId);
  if (hit && hit.chit.type === 'task') {
    const taskChit = hit.chit as Chit<'task'>;
    const scope = chitScopeFromPath(opts.corpRoot, hit.path);
    try {
      updateChit<'task'>(opts.corpRoot, scope, 'task', taskChit.id, {
        updatedBy: opts.reviewerSlug,
        fields: {
          task: {
            ...taskChit.fields.task,
            editorReviewCapHit: true,
            editorReviewRequested: false,
            reviewerClaim: null,
            branchUnderReview: null,
            output: ((taskChit.fields.task.output ?? '') +
              `\n[editor bypass: ${opts.reason}]`).trim(),
          },
        },
      });
    } catch {
      // Best-effort; submission already exists in the lane.
    }
  }

  // Emit editor-bypassed. Submission was just created by enterClearance
  // so submissionId IS populated — log-readers can join Editor's bypass
  // to the subsequent Pressman events.
  emitLaneEvent({
    corpRoot: opts.corpRoot,
    submissionId: ec.value.submissionId,
    taskId: opts.taskId,
    kind: 'editor-bypassed',
    emittedBy: opts.reviewerSlug,
    narrative: opts.narrative ?? opts.reason,
    payload: {
      branch: branchUnderReview,
      reviewRound: currentRound,
      capHit: true,
      failureSummary: opts.reason,
    },
  });

  const out: BypassReviewResult = {
    submissionId: ec.value.submissionId,
    reviewRound: currentRound,
    ...(ec.value.pushedSha ? { pushedSha: ec.value.pushedSha } : {}),
  };
  return ok(out);
}

// ─── releaseReview ───────────────────────────────────────────────────

export interface ReleaseReviewOpts {
  corpRoot: string;
  taskId: string;
  reviewerSlug: string;
}

/**
 * Bare cleanup — clear ONLY the reviewerClaim. Doesn't touch
 * editorReviewRequested (so the next pick will re-claim) or any
 * counter. Used on graceful exit when Editor decides to abandon
 * a task without filing comments / approving / rejecting.
 *
 * No-op if the slug doesn't currently hold the claim.
 */
export function releaseReview(opts: ReleaseReviewOpts): Result<void> {
  const hit = findChitById(opts.corpRoot, opts.taskId);
  if (!hit || hit.chit.type !== 'task') {
    return err(failure('unknown', `releaseReview: task ${opts.taskId} not found`, ''));
  }
  const taskChit = hit.chit as Chit<'task'>;
  const taskFields = taskChit.fields.task;
  if (taskFields.reviewerClaim?.slug !== opts.reviewerSlug) {
    return ok(undefined); // not ours; soft no-op
  }
  const scope = chitScopeFromPath(opts.corpRoot, hit.path);
  try {
    updateChit<'task'>(opts.corpRoot, scope, 'task', taskChit.id, {
      updatedBy: opts.reviewerSlug,
      fields: {
        task: {
          ...taskFields,
          reviewerClaim: null,
        },
      },
    });
  } catch (cause) {
    return err(failure(
      'unknown',
      `releaseReview: task chit update failed`,
      cause instanceof Error ? cause.message : String(cause),
    ));
  }

  // Emit editor-released. submissionId is null — releaseReview
  // never reaches enterClearance.
  emitLaneEvent({
    corpRoot: opts.corpRoot,
    submissionId: null,
    taskId: opts.taskId,
    kind: 'editor-released',
    emittedBy: opts.reviewerSlug,
    payload: {
      reviewRound: taskFields.editorReviewRound ?? 0,
    },
  });

  return ok(undefined);
}

// ─── Stale-claim recovery (mirrors the Pressman lane's resume) ───────

/**
 * A task whose `reviewerClaim.slug` references an Editor that's no
 * longer alive. Identified by the daemon-side sweep so claims left
 * behind by crashed Editors don't strand tasks indefinitely.
 */
export interface OrphanedReviewerClaim {
  readonly taskId: string;
  /** Slug that held the claim — used in the audit-log reason on reset. */
  readonly orphanedFrom: string;
  /** Original claim timestamp, for retrospective. */
  readonly claimedAt: string;
}

/**
 * Walk active tasks, return any whose `reviewerClaim` is held by a
 * slug the supplied predicate reports as not-alive. Pure-ish: only
 * I/O is the chit query; the aliveness predicate is supplied by the
 * caller (typically composed from processManager.getAgent).
 *
 * Mirrors `findOrphanedProcessingSubmissions` in the Pressman lane.
 */
export function findOrphanedReviewerClaims(
  corpRoot: string,
  isAlive: (slug: string) => boolean,
): ReadonlyArray<OrphanedReviewerClaim> {
  let result: ReturnType<typeof queryChits<'task'>>;
  try {
    result = queryChits<'task'>(corpRoot, {
      types: ['task'],
      statuses: ['active'],
    });
  } catch {
    return [];
  }
  const orphans: OrphanedReviewerClaim[] = [];
  for (const c of result.chits) {
    const t = c.chit as Chit<'task'>;
    const claim = t.fields.task.reviewerClaim ?? null;
    if (!claim) continue;
    if (isAlive(claim.slug)) continue;
    orphans.push({
      taskId: t.id,
      orphanedFrom: claim.slug,
      claimedAt: claim.claimedAt,
    });
  }
  return orphans;
}

/**
 * Reset one task's reviewerClaim back to null so the next Editor
 * pickNextReview can re-claim. Idempotent: no-op when the claim
 * has already been cleared. Records `output` annotation for
 * retrospective so a founder grepping later sees what happened.
 *
 * Does NOT increment `editorReviewRound` — the original Editor
 * never finished, so this isn't a rejection. The replacement
 * Editor reviews the same round fresh.
 */
export function resetOrphanedReviewerClaim(
  corpRoot: string,
  taskId: string,
  reason: string,
): void {
  const hit = findChitById(corpRoot, taskId);
  if (!hit || hit.chit.type !== 'task') return;
  const taskChit = hit.chit as Chit<'task'>;
  const taskFields = taskChit.fields.task;
  if ((taskFields.reviewerClaim ?? null) === null) return;

  const scope = chitScopeFromPath(corpRoot, hit.path);
  try {
    updateChit<'task'>(corpRoot, scope, 'task', taskChit.id, {
      updatedBy: 'system:editor-resume',
      fields: {
        task: {
          ...taskFields,
          reviewerClaim: null,
          output: ((taskFields.output ?? '') + `\n[reviewer-claim reset: ${reason}]`).trim(),
        },
      },
    });
  } catch (cause) {
    // Best-effort — surface to stderr so the daemon log captures it
    // but don't throw, mirroring resumeClearinghouse's posture.
    process.stderr.write(
      `[editor-workflow:resume] reset failed for ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  }
}

export interface ResumeEditorReviewsResult {
  readonly claimsReset: number;
}

/**
 * Boot-time + periodic sweeper composer for the editor lane. Walks
 * orphaned reviewer claims (claimer not alive per `isAlive`) and
 * resets each so the next Editor wake re-picks. Best-effort per
 * orphan; one failure doesn't poison the rest.
 *
 * Daemon calls this at startup (after processManager initializes,
 * so `isAlive` returns meaningful values) and from the editor sweep
 * at regular cadence.
 */
export function resumeEditorReviews(
  corpRoot: string,
  isAlive: (slug: string) => boolean,
): ResumeEditorReviewsResult {
  const orphans = findOrphanedReviewerClaims(corpRoot, isAlive);
  let resetCount = 0;
  for (const o of orphans) {
    try {
      resetOrphanedReviewerClaim(
        corpRoot,
        o.taskId,
        `Editor '${o.orphanedFrom}' no longer alive at resume time — claim cleared.`,
      );
      resetCount++;
    } catch (cause) {
      process.stderr.write(
        `[editor-workflow:resume] reset threw for ${o.taskId}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }
  }
  return { claimsReset: resetCount };
}

// ─── Internals ───────────────────────────────────────────────────────

function clearTaskReviewState(corpRoot: string, taskId: string, updatedBy: string): void {
  const hit = findChitById(corpRoot, taskId);
  if (!hit || hit.chit.type !== 'task') return;
  const taskChit = hit.chit as Chit<'task'>;
  const scope = chitScopeFromPath(corpRoot, hit.path);
  try {
    updateChit<'task'>(corpRoot, scope, 'task', taskChit.id, {
      updatedBy,
      fields: {
        task: {
          ...taskChit.fields.task,
          editorReviewRequested: false,
          reviewerClaim: null,
          branchUnderReview: null,
        },
      },
    });
  } catch {
    // Best-effort — submission already created at this point; the
    // sweep will re-clear if state lingers.
  }
}
