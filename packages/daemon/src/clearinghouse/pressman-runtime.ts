/**
 * Pressman runtime (Project 1.12 PR 3).
 *
 * The active loop that processes the merge queue. Composes PR 2's
 * primitives (attemptRebase + runWithFlakeRetry + attemptMerge) with
 * PR 1's substrate (lock claim, cascade) into a single tick that
 * advances one submission per round.
 *
 * ### Daemon-scheduler over LLM-session
 *
 * The spec frames Pressman as an Employee with a session. v1 ships
 * it as a daemon scheduler instead — every "judgment moment" the
 * spec named (flake-vs-real, trivial-vs-substantive conflict,
 * sanity check) is already encoded in the PR 2 primitives. There's
 * no LLM-shaped decision left for v1.
 *
 * Pressman is still structurally an Employee role: members.json
 * carries a Pressman Member, isClearinghouseAwareCorp gates on it,
 * future bacteria scaling could spawn more. The session just doesn't
 * run claude-code today. That's a v2 transition when judgment moments
 * appear (DM-founder-when-stuck, contract-aware merge ordering, etc.).
 *
 * ### Tick semantics
 *
 * The scheduler runs every PRESSMAN_TICK_INTERVAL_MS (30s default).
 * Per tick:
 *   1. Skip if a prior tick is still running (in-flight guard).
 *   2. Find a hired Pressman in members.json. If none, return —
 *      the corp opted out by not hiring one.
 *   3. Read the clearinghouse-lock. If held, return — another tick
 *      (or a stale-recovery sweep) handles it.
 *   4. rankQueue. If empty, return.
 *   5. Claim lock for the top submission.
 *   6. Process: acquire worktree → fetch + rebase → test → merge.
 *      Each outcome routed appropriately (blocker for needs-author,
 *      mark-failed for fatal, mark-merged for clean).
 *   7. Release lock.
 *
 * ### Concurrency
 *
 * Single-tick-at-a-time via `inFlight` flag. Multi-Pressman parallel
 * processing is a v2 (worktree-pool can already support it; the lock
 * mechanism would need lane-parameterized keys per the research).
 *
 * ### Failure routing
 *
 * - `needs-author` (rebase conflict, test fail, hook reject) →
 *   blocker chit via 1.4.1-shape escalation, scoped to author's role.
 * - `race` (push race) → retryCount++, status flips back to queued
 *   for next tick.
 * - `sanity-failed` / `branch-deleted` / `fatal` → submission marked
 *   failed; cascades task to failed; surfaces via the existing
 *   audit + Sexton tier-3 channel.
 */

import { readConfig, MEMBERS_JSON, type Member, createChit, type EscalationFields } from '@claudecorp/shared';
import {
  rankQueue,
  readClearinghouseLock,
  claimClearinghouseLock,
  releaseClearinghouseLock,
  markSubmissionMerged,
  markSubmissionFailed,
  resumeClearinghouse,
  type ClearanceSubmissionFields,
} from '@claudecorp/shared';
import { join } from 'node:path';
import { log, logError } from '../logger.js';
import { realGitOps, type GitOps } from './git-ops.js';
import { WorktreePool, type WorktreePool as WorktreePoolType } from './worktree-pool.js';
import { attemptRebase, type RebaseAttemptResult } from './rebase-flow.js';
import { attemptMerge, type MergeAttemptResult } from './merge-flow.js';
import { runWithFlakeRetry, type RunWithFlakeRetryResult } from './test-attribution.js';
import type { ProcessManager } from '../process-manager.js';
import type { Chit } from '@claudecorp/shared';

// ─── Config ──────────────────────────────────────────────────────────

/** Default tick interval. 30s feels right — Pressman work is modestly bursty; a tighter cadence wastes wakeups when the queue is empty. */
export const PRESSMAN_TICK_INTERVAL_MS = 30_000;

/** Default base branch the rebase targets. */
export const DEFAULT_BASE_BRANCH = 'main';

/** Cap on Phase-2 mechanical retries before a submission is failed. */
export const PRESSMAN_RETRY_CAP = 3;

// ─── Scheduler ───────────────────────────────────────────────────────

export interface PressmanSchedulerOpts {
  corpRoot: string;
  /** Resolves agent aliveness for resumeClearinghouse. */
  processManager: ProcessManager;
  /** Override for tests / non-execa harnesses. */
  gitOps?: GitOps;
  /** Override tick interval (e.g., faster for tests). */
  tickIntervalMs?: number;
  /** Override base branch (e.g., 'develop' instead of 'main'). */
  baseBranch?: string;
  /** Override worktree pool (for tests). */
  pool?: WorktreePoolType;
}

export class PressmanScheduler {
  private readonly corpRoot: string;
  private readonly processManager: ProcessManager;
  private readonly gitOps: GitOps;
  private readonly tickIntervalMs: number;
  private readonly baseBranch: string;
  private readonly pool: WorktreePoolType;
  private interval: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;

  constructor(opts: PressmanSchedulerOpts) {
    this.corpRoot = opts.corpRoot;
    this.processManager = opts.processManager;
    this.gitOps = opts.gitOps ?? realGitOps;
    this.tickIntervalMs = opts.tickIntervalMs ?? PRESSMAN_TICK_INTERVAL_MS;
    this.baseBranch = opts.baseBranch ?? DEFAULT_BASE_BRANCH;
    this.pool = opts.pool ?? new WorktreePool({ corpRoot: this.corpRoot, gitOps: this.gitOps });
  }

  /**
   * Start the scheduler. Runs resumeClearinghouse first to recover
   * any state from a prior daemon session, then begins ticking.
   */
  async start(): Promise<void> {
    log('[clearinghouse:pressman] scheduler starting');
    // Boot-time recovery: clear stale locks, re-queue orphaned
    // submissions whose holders are no longer alive.
    try {
      const result = resumeClearinghouse(this.corpRoot, (slug) => this.isAgentAlive(slug));
      if (result.lockReleased || result.submissionsReset > 0) {
        log(
          `[clearinghouse:pressman] resume cleaned up: lockReleased=${result.lockReleased}, submissionsReset=${result.submissionsReset}`,
        );
      }
    } catch (err) {
      logError(`[clearinghouse:pressman] resumeClearinghouse failed: ${stringify(err)}`);
    }

    // Orphan worktree cleanup on boot.
    try {
      const cleanup = await this.pool.cleanupOrphanWorktrees();
      if (cleanup.ok && cleanup.value.removed > 0) {
        log(`[clearinghouse:pressman] cleaned ${cleanup.value.removed} orphan worktree(s) on boot`);
      }
    } catch (err) {
      logError(`[clearinghouse:pressman] worktree cleanup failed: ${stringify(err)}`);
    }

    this.interval = setInterval(() => {
      void this.tick().catch((err) => logError(`[clearinghouse:pressman] tick threw: ${stringify(err)}`));
    }, this.tickIntervalMs);
  }

  /** Stop the scheduler. Drains the worktree pool. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    try {
      await this.pool.drain();
    } catch (err) {
      logError(`[clearinghouse:pressman] pool drain failed: ${stringify(err)}`);
    }
    log('[clearinghouse:pressman] scheduler stopped');
  }

  /**
   * One tick. Skip if a prior tick is still in flight (Pressman work
   * can take minutes — overlapping ticks would race the lock).
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.processOneSubmission();
    } catch (err) {
      logError(`[clearinghouse:pressman] tick error: ${stringify(err)}`);
    } finally {
      this.inFlight = false;
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private isAgentAlive(slug: string): boolean {
    const proc = this.processManager.getAgent(slug);
    return proc?.status === 'ready' || proc?.status === 'starting';
  }

  private async processOneSubmission(): Promise<void> {
    // 1. Find a hired Pressman.
    let pressman: Member | undefined;
    try {
      const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
      pressman = members.find((m) => m.role === 'pressman');
    } catch {
      return; // members.json unreadable — pessimistic skip
    }
    if (!pressman) return; // No Pressman hired; corp opted out

    // 2. Is the lock free?
    const lock = readClearinghouseLock(this.corpRoot);
    if (lock.heldBy) {
      // Held — either active processing OR stale. resumeClearinghouse
      // (boot + periodic sweep) handles the stale case; we just skip.
      return;
    }

    // 3. Anything queued?
    const ranked = rankQueue(this.corpRoot);
    if (ranked.length === 0) return;
    const top = ranked[0]!;
    const submission = top.chit;
    const fields = submission.fields['clearance-submission'];

    // 4. Claim the lock.
    const claimed = claimClearinghouseLock({
      corpRoot: this.corpRoot,
      slug: pressman.id,
      submissionId: submission.id,
    });
    if (!claimed) return; // Lost the race; skip.

    log(
      `[clearinghouse:pressman] claimed ${submission.id} (branch=${fields.branch}, priority=${fields.priority}, score=${top.score.toFixed(0)})`,
    );

    // 5. Process. Always release the lock at the end.
    try {
      await this.runSubmission(submission, pressman.id);
    } finally {
      const released = releaseClearinghouseLock({ corpRoot: this.corpRoot, slug: pressman.id });
      if (!released) {
        logError(
          `[clearinghouse:pressman] could not release lock for ${pressman.id} — mismatch or already free`,
        );
      }
    }
  }

  private async runSubmission(
    submission: Chit<'clearance-submission'>,
    pressmanSlug: string,
  ): Promise<void> {
    const fields = submission.fields['clearance-submission'];
    const { branch, taskId, contractId, submitter } = fields;

    // Acquire worktree.
    const wtResult = await this.pool.acquire({ branch, holder: pressmanSlug });
    if (!wtResult.ok) {
      this.markFailedWithReason(
        submission.id,
        pressmanSlug,
        `worktree acquire failed: ${wtResult.failure.pedagogicalSummary}`,
      );
      return;
    }
    const handle = wtResult.value;

    try {
      // Fetch latest base.
      const fetchResult = await this.gitOps.fetchOrigin({
        branch: this.baseBranch,
        cwd: handle.path,
      });
      if (!fetchResult.ok) {
        this.markFailedWithReason(
          submission.id,
          pressmanSlug,
          `fetch ${this.baseBranch} failed: ${fetchResult.failure.pedagogicalSummary}`,
        );
        return;
      }

      // Rebase.
      const rebase = await attemptRebase({
        worktreePath: handle.path,
        baseBranch: `origin/${this.baseBranch}`,
        prBranch: branch,
        gitOps: this.gitOps,
      });
      if (!rebase.ok) {
        // Programmer-error path; rare. Mark failed for retry.
        this.markFailedWithReason(submission.id, pressmanSlug, `rebase: ${rebase.failure.pedagogicalSummary}`);
        return;
      }
      const r = rebase.value;
      switch (r.outcome) {
        case 'clean':
        case 'auto-resolved':
          break; // Proceed to tests.
        case 'needs-author':
          this.fileConflictBlocker(submission, pressmanSlug, r);
          this.markConflict(submission.id, pressmanSlug, 'rebase produced substantive conflicts');
          return;
        case 'sanity-failed':
          this.markFailedWithReason(
            submission.id,
            pressmanSlug,
            r.failureRecord?.pedagogicalSummary ?? 'rebase sanity check failed',
          );
          return;
        case 'fatal':
          this.markFailedWithReason(
            submission.id,
            pressmanSlug,
            r.failureRecord?.pedagogicalSummary ?? 'rebase fatal',
          );
          return;
      }

      // Tests with flake retry.
      const tests = await runWithFlakeRetry({
        runOpts: { cwd: handle.path },
        maxRetries: 1,
      });
      if (!tests.ok) {
        this.markFailedWithReason(submission.id, pressmanSlug, `tests: ${tests.failure.pedagogicalSummary}`);
        return;
      }
      const t = tests.value;
      switch (t.classifiedAs) {
        case 'passed-first':
        case 'flake':
          break; // Proceed to merge (flakes don't block the merge — re-run passed).
        case 'consistent-fail':
          this.fileTestFailureBlocker(submission, pressmanSlug, t);
          this.markConflict(submission.id, pressmanSlug, 'tests consistently failed across re-runs');
          return;
        case 'inconclusive':
          this.markFailedWithReason(submission.id, pressmanSlug, 'tests inconclusive (timeout or crash)');
          return;
      }

      // Merge.
      const merge = await attemptMerge({
        worktreePath: handle.path,
        prBranch: branch,
        gitOps: this.gitOps,
      });
      if (!merge.ok) {
        this.markFailedWithReason(submission.id, pressmanSlug, `merge: ${merge.failure.pedagogicalSummary}`);
        return;
      }
      const m = merge.value;
      switch (m.outcome) {
        case 'merged':
          markSubmissionMerged({
            corpRoot: this.corpRoot,
            submissionId: submission.id,
            ...(m.mergeCommitSha ? { mergeCommitSha: m.mergeCommitSha } : {}),
            updatedBy: pressmanSlug,
          });
          log(`[clearinghouse:pressman] merged ${submission.id} (sha=${m.mergeCommitSha ?? 'unknown'})`);
          break;
        case 'race':
          // Race — origin moved. Increment retryCount and re-queue.
          this.markRaceRetry(submission.id, pressmanSlug);
          return;
        case 'hook-rejected':
          this.fileHookRejectionBlocker(submission, pressmanSlug, m);
          this.markConflict(submission.id, pressmanSlug, "origin's push hook refused");
          return;
        case 'branch-deleted':
          this.markFailedWithReason(submission.id, pressmanSlug, 'PR branch deleted from origin');
          return;
        case 'fatal':
          this.markFailedWithReason(
            submission.id,
            pressmanSlug,
            m.failureRecord?.pedagogicalSummary ?? 'merge fatal',
          );
          return;
      }
    } finally {
      // Release worktree even on errors. Best-effort; pool tolerates
      // mismatched-handle releases.
      this.pool.release(handle).catch(() => undefined);
    }
  }

  // ─── State transitions ─────────────────────────────────────────────

  private markFailedWithReason(submissionId: string, slug: string, reason: string): void {
    try {
      markSubmissionFailed({
        corpRoot: this.corpRoot,
        submissionId,
        reason,
        updatedBy: slug,
      });
      log(`[clearinghouse:pressman] failed ${submissionId}: ${reason}`);
    } catch (err) {
      logError(`[clearinghouse:pressman] markSubmissionFailed threw: ${stringify(err)}`);
    }
  }

  private markConflict(submissionId: string, slug: string, reason: string): void {
    // For v1, "conflict" + "tests consistently failed" + "hook reject"
    // all share the markFailedWithReason path because we don't have
    // a separate "needs-author" terminal state — the blocker chit
    // routes the work; the submission just notes why it stopped.
    // Future: distinguish via submissionStatus='conflict' for cleaner
    // retrospective queries.
    this.markFailedWithReason(submissionId, slug, reason);
  }

  private markRaceRetry(submissionId: string, slug: string): void {
    // Increment retryCount, flip status back to queued. Next tick
    // will re-claim and re-process.
    try {
      const { findChitById, updateChit } = require('@claudecorp/shared') as typeof import('@claudecorp/shared');
      const hit = findChitById(this.corpRoot, submissionId);
      if (!hit || hit.chit.type !== 'clearance-submission') return;
      const subFields = (hit.chit as Chit<'clearance-submission'>).fields['clearance-submission'];
      if (subFields.retryCount >= PRESSMAN_RETRY_CAP) {
        this.markFailedWithReason(
          submissionId,
          slug,
          `push race exceeded retry cap (${PRESSMAN_RETRY_CAP})`,
        );
        return;
      }
      updateChit<'clearance-submission'>(this.corpRoot, 'corp', 'clearance-submission', submissionId, {
        updatedBy: slug,
        fields: {
          'clearance-submission': {
            ...subFields,
            submissionStatus: 'queued',
            retryCount: subFields.retryCount + 1,
            processingBy: null,
            processingStartedAt: null,
            lastFailureReason: 'push race — re-queued',
          },
        },
      });
      log(`[clearinghouse:pressman] re-queued ${submissionId} after push race (retryCount=${subFields.retryCount + 1})`);
    } catch (err) {
      logError(`[clearinghouse:pressman] markRaceRetry threw: ${stringify(err)}`);
    }
  }

  // ─── Blocker chit filing ───────────────────────────────────────────

  private fileConflictBlocker(
    submission: Chit<'clearance-submission'>,
    pressmanSlug: string,
    rebase: RebaseAttemptResult,
  ): void {
    this.fileBlocker(submission, pressmanSlug, {
      summary: `Pressman: rebase conflict on ${submission.fields['clearance-submission'].branch}`,
      detail:
        `Substantive conflicts in ${rebase.conflictedFiles?.length ?? 0} file(s) couldn't be auto-resolved. ` +
        `Files: ${(rebase.conflictedFiles ?? []).join(', ') || '(none listed)'}. ` +
        `Pull the branch locally, resolve, re-run cc-cli done — audit will re-fire enterClearance.`,
    });
  }

  private fileTestFailureBlocker(
    submission: Chit<'clearance-submission'>,
    pressmanSlug: string,
    tests: RunWithFlakeRetryResult,
  ): void {
    const finalRun = tests.finalRun;
    const failureNames = finalRun.failures.slice(0, 5).map((f) => f.name).join('; ');
    this.fileBlocker(submission, pressmanSlug, {
      summary: `Pressman: tests consistently failed on ${submission.fields['clearance-submission'].branch}`,
      detail:
        `${finalRun.failures.length} test(s) failed across ${tests.allRuns.length} runs. ` +
        `${failureNames ? `Failures: ${failureNames}.` : '(no per-test data parsed.)'} ` +
        `Investigate locally; the failure didn't reproduce-as-flake on re-run.`,
    });
  }

  private fileHookRejectionBlocker(
    submission: Chit<'clearance-submission'>,
    pressmanSlug: string,
    merge: MergeAttemptResult,
  ): void {
    this.fileBlocker(submission, pressmanSlug, {
      summary: `Pressman: origin push hook refused merge of ${submission.fields['clearance-submission'].branch}`,
      detail: merge.hookOutput ?? '(no hook output captured — check origin logs)',
    });
  }

  /**
   * File a generic Pressman blocker via 1.4.1's escalation chit type.
   * Routes to author's role (the submitter's resolved role); the
   * role-resolver picks original-if-alive or substitute-else.
   *
   * For v1 we use the escalation chit type with severity='blocker'
   * and a structured body. The full 1.4.1 cc-cli block surface
   * dispatches additional notifications (Tier-3 inbox); we don't
   * call that path from the daemon to keep this focused — the
   * blocker chit's existence is the surface, and Sexton's wake
   * digest naturally reads kink/escalation chits.
   */
  private fileBlocker(
    submission: Chit<'clearance-submission'>,
    pressmanSlug: string,
    opts: { summary: string; detail: string },
  ): void {
    const fields = submission.fields['clearance-submission'];
    const escalationFields: EscalationFields = {
      originatingChit: submission.id,
      reason: `${opts.summary}\n\n${opts.detail}`,
      from: pressmanSlug,
      to: fields.submitter,
      severity: 'blocker',
    };
    try {
      createChit(this.corpRoot, {
        type: 'escalation',
        scope: 'corp',
        createdBy: pressmanSlug,
        fields: { escalation: escalationFields },
        body:
          `# Pressman blocker on ${fields.branch}\n\n` +
          `**Submission:** ${submission.id}\n` +
          `**Task:** ${fields.taskId}\n` +
          `**Originating author:** ${fields.submitter}\n\n` +
          `## What happened\n\n${opts.summary}\n\n` +
          `## Context\n\n${opts.detail}\n`,
      });
    } catch (err) {
      logError(`[clearinghouse:pressman] blocker chit creation failed: ${stringify(err)}`);
    }
  }
}

function stringify(v: unknown): string {
  return v instanceof Error ? v.stack ?? v.message : String(v);
}
