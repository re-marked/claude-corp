/**
 * High-level merge orchestrator (Project 1.12).
 *
 * Composes git-ops to push the PR's branch (post-rebase) to origin
 * and capture the resulting commit sha. Handles the three real
 * failure paths:
 *
 *   - Push race: someone pushed to origin between our rebase and
 *     our push. Caller's job is to re-rebase + retry; we surface
 *     the race signal.
 *
 *   - Hook rejection: origin's pre-receive or update hook refused.
 *     We capture the hook output (so the blocker chit can show the
 *     author exactly what hook complained) and surface as needs-
 *     author.
 *
 *   - Network/disk/unknown: surfaces via FailureRecord; the
 *     orchestrator returns ok with outcome='fatal' so the caller
 *     can decide retry vs. surface.
 *
 * ### What this orchestrator does NOT do
 *
 * - It does not rebase. Rebase-flow handles that, then hands off.
 * - It does not run tests. Caller decides when.
 * - It does not file blockers. Caller routes based on the typed
 *   outcome.
 * - It does not interact with GitHub PR state (closing, labeling,
 *   etc). Pressman's CLI surface in PR 3 handles `gh pr merge` if
 *   the founder's flow goes through GitHub PRs vs direct push.
 *
 * ### Outcome shape
 *
 * MergeAttemptResult — five states:
 *   'merged'         — pushed cleanly; mergeCommitSha populated.
 *   'race'           — origin moved; caller re-rebases + retries.
 *   'hook-rejected'  — origin hook refused; hookOutput populated.
 *   'branch-deleted' — branch gone from origin (unrecoverable
 *                     without author intervention).
 *   'fatal'          — git/network failure; failureRecord populated.
 */

import { failure, ok, err, type FailureRecord, type Result } from './failure-taxonomy.js';
import type { GitOps } from './git-ops.js';

// ─── Outcome shape ───────────────────────────────────────────────────

export type MergeAttemptOutcome =
  | 'merged'
  | 'race'
  | 'hook-rejected'
  | 'branch-deleted'
  | 'fatal';

export interface MergeAttemptResult {
  readonly outcome: MergeAttemptOutcome;
  /** Populated when outcome='merged'. The post-push HEAD sha. */
  readonly mergeCommitSha?: string;
  /** Populated when outcome='hook-rejected'. The origin hook's stderr/stdout for the author. */
  readonly hookOutput?: string;
  /** Populated when outcome='fatal'. */
  readonly failureRecord?: FailureRecord;
}

// ─── The orchestrator ────────────────────────────────────────────────

export interface AttemptMergeOpts {
  worktreePath: string;
  /** The PR branch to push. After successful rebase, this is what gets pushed. */
  prBranch: string;
  gitOps: GitOps;
  /**
   * Force-with-lease push? Default true — protects against
   * overwriting concurrent updates while still allowing rebased
   * pushes (which are non-fast-forward by definition).
   */
  force?: boolean;
}

/**
 * Push the PR's (already-rebased) branch to origin. Capture the
 * resulting sha on success. Classify failure modes precisely so
 * Pressman can act on the typed outcome.
 *
 * Strategy:
 *
 *   1. Capture HEAD sha pre-push. We use this as the expected
 *      post-push sha (origin should now point at it).
 *
 *   2. Push with --force-with-lease. (Force is needed because
 *      rebase rewrites history; --force-with-lease protects against
 *      concurrent push by another agent.)
 *
 *   3. Switch on push outcome:
 *        pushed         → return ok with sha.
 *        rejected-race  → return race outcome.
 *        rejected-hook  → return hook-rejected with hookOutput.
 *        fatal          → check if branch was deleted; if so
 *                         return branch-deleted, else fatal.
 *
 *   4. (Optional, defer to v2): re-fetch + verify origin's branch
 *      tip equals our HEAD as a last-mile sanity check. v1 trusts
 *      git's exit code + output classification.
 */
export async function attemptMerge(opts: AttemptMergeOpts): Promise<Result<MergeAttemptResult>> {
  const { worktreePath, prBranch, gitOps, force = true } = opts;

  // 1. Capture pre-push sha.
  const headResult = await gitOps.currentSha(worktreePath, 'HEAD');
  if (!headResult.ok) {
    return ok({ outcome: 'fatal', failureRecord: headResult.failure });
  }
  const expectedSha = headResult.value;

  // 2. Push.
  const pushResult = await gitOps.push(prBranch, { worktreePath, force });
  if (!pushResult.ok) {
    // Categorical failure (network, disk, branch-deleted classify
    // here too because git fetch/push reports it as fatal). Check
    // the category to refine.
    if (pushResult.failure.category === 'branch-deleted') {
      return ok({ outcome: 'branch-deleted', failureRecord: pushResult.failure });
    }
    return ok({ outcome: 'fatal', failureRecord: pushResult.failure });
  }

  const push = pushResult.value;
  switch (push.state) {
    case 'pushed':
      return ok({ outcome: 'merged', mergeCommitSha: expectedSha });
    case 'rejected-race':
      return ok({ outcome: 'race' });
    case 'rejected-hook':
      return ok({
        outcome: 'hook-rejected',
        hookOutput: push.hookOutput,
        failureRecord: failure(
          'push-rejection-hook',
          `Origin's push hook refused the merge. The hook's output is included; address the listed concerns and re-submit.`,
          push.hookOutput ?? '(no hook output captured)',
        ),
      });
    case 'fatal':
      return ok({
        outcome: 'fatal',
        failureRecord: failure(
          'unknown',
          `Push to origin/${prBranch} failed for an unknown reason. Manual investigation needed.`,
          `(see daemon log)`,
        ),
      });
  }
}

/**
 * After a successful merge, fetch the latest origin/main + verify
 * our pushed sha is reachable from it. This is an extra safety
 * check for paranoid setups (e.g. when origin's hook auto-rebases
 * or squash-merges); v1 callers can skip it.
 *
 * Returns ok(true) if our sha is in origin/main's history; ok(false)
 * if not (suggests origin rewrote our commit). Errors during the
 * fetch/walk surface as Result failures.
 */
export async function verifyMergeReachability(opts: {
  worktreePath: string;
  mergeSha: string;
  baseBranch: string;
  gitOps: GitOps;
}): Promise<Result<boolean>> {
  const { worktreePath, mergeSha, baseBranch, gitOps } = opts;
  const fetchResult = await gitOps.fetchOrigin({ branch: baseBranch, cwd: worktreePath });
  if (!fetchResult.ok) return err(fetchResult.failure);

  // Compare our sha to origin/<base>'s tip — if they're the same,
  // our merge IS the new tip. If they differ, walk to see if our
  // sha is reachable (would mean someone pushed on top of us).
  const tipResult = await gitOps.currentSha(worktreePath, `origin/${baseBranch}`);
  if (!tipResult.ok) return err(tipResult.failure);

  if (tipResult.value === mergeSha) return ok(true);

  // Reachability via merge-base equality. We don't expose
  // mergeBase in GitOps — for v1 just return false on inequality
  // and let the caller decide whether to dig further.
  return ok(false);
}
