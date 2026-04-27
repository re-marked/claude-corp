/**
 * enterClearance — bridge from "audit approved" to "in the merge lane"
 * (Project 1.12 PR 3).
 *
 * The author never types `cc-cli clear`. Audit's approve path (the
 * Stop-hook flow that promotes pending handoffs today) fires this
 * function on 1.12-aware corps, which:
 *
 *   1. Pushes the author's branch to origin (from their sandbox).
 *   2. Creates a `clearance-submission` chit with reviewBypassed: true
 *      (until PR 4 lands Editor — at that point Editor runs first
 *      and decides reviewBypassed based on cap-hit vs approval).
 *   3. Advances the task workflow `under_review → clearance`.
 *
 * Atomicity-ish: the three steps are sequenced, not transactional.
 * If push fails, we return early without creating the submission or
 * advancing state — the task stays at `under_review` and the agent
 * can retry. If chit creation fails after a successful push, the
 * branch is on origin but no submission exists; the audit logs
 * surface this so the founder can manually re-fire via the admin
 * `cc-cli clearinghouse submit` fallback.
 *
 * ### Why direct-import, not daemon HTTP
 *
 * `cc-cli audit` runs synchronously in the Stop hook. Adding an
 * HTTP roundtrip + daemon-not-running fallback would complicate
 * the path for no real benefit — the push and chit ops both work
 * in the CLI process (push spawns git, chit ops are filesystem).
 * The daemon's role here is nothing the CLI can't do itself, so
 * we don't introduce one.
 *
 * Future enhancement: if push latency becomes a UX problem, async
 * via daemon endpoint becomes the right shape. Not v1.
 */

import {
  createChit,
  findChitById,
  updateChit,
  chitScopeFromPath,
  type Chit,
  type ClearanceSubmissionFields,
  type TaskFields,
} from '@claudecorp/shared';
import { failure, ok, err, type Result } from './failure-taxonomy.js';
import { realGitOps, type GitOps } from './git-ops.js';

export interface EnterClearanceOpts {
  corpRoot: string;
  /** Chit id of the task being submitted. Must be at workflowStatus='under_review'. */
  taskId: string;
  /** Chit id of the parent contract. Submitted on the submission for cascade purposes. */
  contractId: string;
  /** Git branch name to push. */
  branch: string;
  /** Member.id of the agent who triggered audit (the submission's author). */
  submitter: string;
  /**
   * Absolute path to the author's sandbox / worktree where the
   * branch is checked out. Used as the cwd for `git push`.
   */
  worktreePath: string;
  /** Inject a mock GitOps for testing. Defaults to realGitOps. */
  gitOps?: GitOps;
  /**
   * For PR 3 we hardcode reviewBypassed: true because Editor doesn't
   * exist yet. PR 4 will pass this from the Editor approve / cap-hit
   * path. Default true keeps the v1 flow degraded-but-functional.
   */
  reviewBypassed?: boolean;
  /**
   * Number of review rounds the submission went through. PR 3
   * defaults to 0 (no Editor). PR 4 fills this in.
   */
  reviewRound?: number;
}

export interface EnterClearanceResult {
  /** Chit id of the newly-created clearance-submission. */
  readonly submissionId: string;
  /** Sha of the pushed branch tip on origin. */
  readonly pushedSha?: string;
}

/**
 * Run the audit-approve → push → submit → cascade pipeline.
 * Returns a Result<EnterClearanceResult> — the typed failure
 * shape lets audit decide whether to retry or surface to the
 * agent on each failure category.
 */
export async function enterClearance(opts: EnterClearanceOpts): Promise<Result<EnterClearanceResult>> {
  const gitOps = opts.gitOps ?? realGitOps;

  // 1. Validate the task is in the expected pre-state. Cheap
  // pre-check — if the task isn't at under_review, audit is
  // calling us at the wrong time. Surface a clear error rather
  // than corrupting state.
  const taskHit = findChitById(opts.corpRoot, opts.taskId);
  if (!taskHit || taskHit.chit.type !== 'task') {
    return err(failure(
      'unknown',
      `enterClearance: task ${opts.taskId} not found or wrong type`,
      `corpRoot=${opts.corpRoot}, taskId=${opts.taskId}`,
    ));
  }
  const taskChit = taskHit.chit as Chit<'task'>;
  const currentStatus = taskChit.fields.task.workflowStatus;
  if (currentStatus !== 'under_review') {
    return err(failure(
      'unknown',
      `enterClearance: task ${opts.taskId} is at workflowStatus='${currentStatus}', expected 'under_review'. Audit fired enterClearance at the wrong point in the chain.`,
      `task chit: ${taskHit.path}`,
    ));
  }

  // 2. Validate contract exists (best-effort — if the lookup
  // fails we surface but don't block; contract reference may be
  // stale but the submission still flows).
  const contractHit = findChitById(opts.corpRoot, opts.contractId);
  if (!contractHit || contractHit.chit.type !== 'contract') {
    // Soft fail — log but proceed. The clearance-submission can
    // still be created with the recorded contractId; cascade
    // will skip the contract advancement when the chit is missing.
    // This matches the pattern in markSubmissionMerged (cascade
    // helpers tolerate missing references).
  }

  // 3. Push the branch. Returns typed failure on rejection /
  // network / hook / etc — surface unchanged (don't create the
  // submission until origin has the branch).
  const pushResult = await gitOps.push(opts.branch, {
    worktreePath: opts.worktreePath,
    force: true, // rebases rewrite history; --force-with-lease at the gitOps layer
  });
  if (!pushResult.ok) {
    return err(pushResult.failure);
  }
  const push = pushResult.value;
  if (push.state === 'rejected-race') {
    return err(failure(
      'push-rejection-race',
      `enterClearance: push to origin/${opts.branch} rejected — origin moved. Re-fetch and retry the audit cycle.`,
      `state=race`,
    ));
  }
  if (push.state === 'rejected-hook') {
    return err(failure(
      'push-rejection-hook',
      `enterClearance: origin's push hook refused. Address the hook output and retry.`,
      push.hookOutput ?? '(no hook output captured)',
    ));
  }
  if (push.state === 'fatal') {
    return err(failure(
      'unknown',
      `enterClearance: push to origin/${opts.branch} failed for an unknown reason.`,
      'see daemon log',
    ));
  }
  // push.state === 'pushed'.

  // Capture the post-push HEAD sha for audit + later verification.
  const shaResult = await gitOps.currentSha(opts.worktreePath, 'HEAD');
  const pushedSha = shaResult.ok ? shaResult.value : undefined;

  // 4. Create the clearance-submission chit. Status='active'
  // (chit lifecycle); submissionStatus='queued' (rich state).
  const now = new Date().toISOString();
  const submissionFields: ClearanceSubmissionFields = {
    branch: opts.branch,
    contractId: opts.contractId,
    taskId: opts.taskId,
    submitter: opts.submitter,
    priority: taskChit.fields.task.priority,
    submittedAt: now,
    submissionStatus: 'queued',
    retryCount: 0,
    reviewRound: opts.reviewRound ?? 0,
    reviewBypassed: opts.reviewBypassed ?? true,
    processingBy: null,
    mergeCommitSha: null,
    lastFailureReason: null,
  };

  let submissionChit: Chit<'clearance-submission'>;
  try {
    submissionChit = createChit<'clearance-submission'>(opts.corpRoot, {
      type: 'clearance-submission',
      scope: 'corp',
      createdBy: opts.submitter,
      fields: { 'clearance-submission': submissionFields },
    });
  } catch (cause) {
    return err(failure(
      'unknown',
      `enterClearance: clearance-submission chit creation failed AFTER successful push to origin/${opts.branch}. Branch is on origin; no submission exists. Use \`cc-cli clearinghouse submit --task ${opts.taskId}\` to recover, or investigate via daemon log.`,
      cause instanceof Error ? cause.stack ?? cause.message : String(cause),
    ));
  }

  // 5. Cascade: advance task workflow under_review → clearance.
  // Best-effort with surface — if this fails, the submission exists
  // but the task is still at under_review, which would cause the
  // submission to be ignored. Surface the failure so audit can
  // log + retry the cascade.
  const taskScope = chitScopeFromPath(opts.corpRoot, taskHit.path);
  try {
    updateChit<'task'>(opts.corpRoot, taskScope, 'task', taskChit.id, {
      updatedBy: opts.submitter,
      fields: {
        task: {
          ...taskChit.fields.task,
          workflowStatus: 'clearance',
        },
      },
    });
  } catch (cause) {
    return err(failure(
      'unknown',
      `enterClearance: task workflow cascade under_review → clearance failed after submission ${submissionChit.id} was created. Branch is on origin AND submission exists, but task state is inconsistent. Manually advance via \`cc-cli chit update --type task --id ${opts.taskId} --field workflowStatus=clearance\`.`,
      cause instanceof Error ? cause.stack ?? cause.message : String(cause),
    ));
  }

  return ok({
    submissionId: submissionChit.id,
    ...(pushedSha ? { pushedSha } : {}),
  });
}

/**
 * Pre-check: is this CORP using the clearinghouse flow? Audit calls
 * this to decide whether to fire enterClearance — corps that haven't
 * hired a Pressman (or fired theirs) shouldn't have their audit flow
 * rerouted, otherwise submissions accumulate with no worker to
 * process them and tasks strand.
 *
 * Detection: presence of any non-archived Member with
 * `role === 'pressman'` in the corp's members.json. The archived
 * filter mirrors `dispatchPressman`'s active-Pressman filter — both
 * paths must agree on what "Pressman exists" means, otherwise audit
 * defers task closes for a Pressman that dispatch silently skips.
 * (Codex P2 catch on PR #194.)
 *
 * Returns false when members.json can't be read (defensive — a
 * corp with broken members.json shouldn't have audit divert into
 * a new flow until the substrate is healthy again).
 */
export function isClearinghouseAwareCorp(corpRoot: string): boolean {
  try {
    const { readConfig, MEMBERS_JSON } = require('@claudecorp/shared') as typeof import('@claudecorp/shared');
    const { join } = require('node:path') as typeof import('node:path');
    const members = readConfig<Array<{ role?: string; type?: string; status?: string }>>(join(corpRoot, MEMBERS_JSON));
    return members.some(
      (m) => m.role === 'pressman' && m.type === 'agent' && m.status !== 'archived',
    );
  } catch {
    return false;
  }
}
