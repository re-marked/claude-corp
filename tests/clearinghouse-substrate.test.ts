import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scoreSubmission,
  rankQueue,
  readClearinghouseLock,
  claimClearinghouseLock,
  releaseClearinghouseLock,
  forceReleaseClearinghouseLock,
  detectStaleLock,
  findOrphanedProcessingSubmissions,
  resetOrphanedSubmission,
  resumeClearinghouse,
  markSubmissionMerged,
  markSubmissionFailed,
  createChit,
  findChitById,
  EDITOR_REVIEW_ROUND_CAP_DEFAULT,
  CLEARINGHOUSE_LOCK_JSON,
  type ClearinghouseLockState,
} from '../packages/shared/src/index.js';
import { writeFileSync } from 'node:fs';

/**
 * Coverage for the Project 1.12 Clearinghouse substrate:
 *   - Pure scoring (Gas Town formula).
 *   - Queue ordering composer.
 *   - Lock lifecycle (claim / release / force / read).
 *   - Stale-lock detection + orphan-submission detection (pure
 *     given the aliveness predicate).
 *   - Cascade helpers (markSubmissionMerged, markSubmissionFailed)
 *     walk through real chits on disk.
 *   - resumeClearinghouse composes the above.
 */

describe('clearinghouse substrate', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'clearinghouse-'));
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      /* Windows */
    }
  });

  // ─── scoreSubmission (pure) ──────────────────────────────────────

  describe('scoreSubmission', () => {
    const now = new Date('2026-04-26T12:00:00.000Z');

    it('base score 1000 for a fresh normal-priority submission with no retries', () => {
      const score = scoreSubmission(
        {
          submittedAt: '2026-04-26T12:00:00.000Z',
          priority: 'normal',
          retryCount: 0,
        },
        now,
      );
      // Base 1000 + 0 queue age + (4-3)*100 = 1100
      expect(score).toBe(1100);
    });

    it('critical priority adds 300 over base', () => {
      const score = scoreSubmission(
        { submittedAt: '2026-04-26T12:00:00.000Z', priority: 'critical', retryCount: 0 },
        now,
      );
      expect(score).toBe(1300); // 1000 + 0 + 300
    });

    it('low priority adds 0 over base', () => {
      const score = scoreSubmission(
        { submittedAt: '2026-04-26T12:00:00.000Z', priority: 'low', retryCount: 0 },
        now,
      );
      expect(score).toBe(1000);
    });

    it('queue age adds 10 per hour', () => {
      const score = scoreSubmission(
        { submittedAt: '2026-04-26T10:00:00.000Z', priority: 'normal', retryCount: 0 },
        now,
      );
      // 2hr * 10 + 100 priority + 1000 base = 1120
      expect(score).toBe(1120);
    });

    it('retry penalty caps at -300 (6 retries == 12 retries for scoring)', () => {
      const sixRetries = scoreSubmission(
        { submittedAt: '2026-04-26T12:00:00.000Z', priority: 'normal', retryCount: 6 },
        now,
      );
      const twelveRetries = scoreSubmission(
        { submittedAt: '2026-04-26T12:00:00.000Z', priority: 'normal', retryCount: 12 },
        now,
      );
      expect(sixRetries).toBe(twelveRetries);
      expect(sixRetries).toBe(800); // 1000 + 100 - 300
    });

    it('pr_age (taskCreatedAt) adds 1 per hour', () => {
      const score = scoreSubmission(
        {
          submittedAt: '2026-04-26T12:00:00.000Z',
          priority: 'normal',
          retryCount: 0,
          taskCreatedAt: '2026-04-26T02:00:00.000Z', // 10h old task
        },
        now,
      );
      // base 1000 + 0 queue + 100 prio + 10 task-age = 1110
      expect(score).toBe(1110);
    });

    it('malformed submittedAt → ignored, falls back to base + priority', () => {
      const score = scoreSubmission(
        { submittedAt: 'not-a-timestamp', priority: 'high', retryCount: 0 },
        now,
      );
      expect(score).toBe(1200); // 1000 + 0 (malformed age) + 200
    });

    it('exposes the documented default cap', () => {
      expect(EDITOR_REVIEW_ROUND_CAP_DEFAULT).toBe(3);
    });
  });

  // ─── Lock lifecycle ──────────────────────────────────────────────

  describe('lock lifecycle', () => {
    it('readClearinghouseLock returns free state when file missing', () => {
      const lock = readClearinghouseLock(corpRoot);
      expect(lock).toEqual({ heldBy: null, claimedAt: null, submissionId: null });
    });

    it('claim succeeds when lock is free', () => {
      const ok = claimClearinghouseLock({
        corpRoot,
        slug: 'pressman-aa',
        submissionId: 'chit-cs-abc',
      });
      expect(ok).toBe(true);

      const lock = readClearinghouseLock(corpRoot);
      expect(lock.heldBy).toBe('pressman-aa');
      expect(lock.submissionId).toBe('chit-cs-abc');
      expect(lock.claimedAt).toBeTruthy();
    });

    it('second claim by same slug for same submission is idempotent (no-op true)', () => {
      claimClearinghouseLock({ corpRoot, slug: 'pressman-aa', submissionId: 'chit-cs-abc' });
      const ok = claimClearinghouseLock({
        corpRoot,
        slug: 'pressman-aa',
        submissionId: 'chit-cs-abc',
      });
      expect(ok).toBe(true);
    });

    it('claim by different slug while held returns false', () => {
      claimClearinghouseLock({ corpRoot, slug: 'pressman-aa', submissionId: 'chit-cs-abc' });
      const ok = claimClearinghouseLock({
        corpRoot,
        slug: 'pressman-bb',
        submissionId: 'chit-cs-xyz',
      });
      expect(ok).toBe(false);
    });

    it('release returns true when called by current holder', () => {
      claimClearinghouseLock({ corpRoot, slug: 'pressman-aa', submissionId: 'chit-cs-abc' });
      const ok = releaseClearinghouseLock({ corpRoot, slug: 'pressman-aa' });
      expect(ok).toBe(true);
      expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();
    });

    it('release by mismatched slug returns false (does not free the lock)', () => {
      claimClearinghouseLock({ corpRoot, slug: 'pressman-aa', submissionId: 'chit-cs-abc' });
      const ok = releaseClearinghouseLock({ corpRoot, slug: 'pressman-bb' });
      expect(ok).toBe(false);
      expect(readClearinghouseLock(corpRoot).heldBy).toBe('pressman-aa');
    });

    it('forceReleaseClearinghouseLock unconditionally frees', () => {
      claimClearinghouseLock({ corpRoot, slug: 'pressman-aa', submissionId: 'chit-cs-abc' });
      forceReleaseClearinghouseLock(corpRoot);
      expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();
    });

    // Codex P1 regression (PR #191): re-claim by same slug for a
    // DIFFERENT submission would silently overwrite the prior claim,
    // stranding the prior submission in submissionStatus='processing'
    // with a live processingBy. Caller must release first.
    it('rejects same-slug re-claim for a different submission', () => {
      claimClearinghouseLock({ corpRoot, slug: 'pressman-aa', submissionId: 'chit-cs-first' });
      const ok = claimClearinghouseLock({
        corpRoot,
        slug: 'pressman-aa',
        submissionId: 'chit-cs-second',
      });
      expect(ok).toBe(false);
      // Lock state unchanged — still pointing at the original submission.
      const lock = readClearinghouseLock(corpRoot);
      expect(lock.heldBy).toBe('pressman-aa');
      expect(lock.submissionId).toBe('chit-cs-first');
    });

    it('readClearinghouseLock returns free state on corrupted JSON', () => {
      const path = join(corpRoot, CLEARINGHOUSE_LOCK_JSON);
      writeFileSync(path, '{ this is { not json }', 'utf-8');
      const lock = readClearinghouseLock(corpRoot);
      expect(lock).toEqual({ heldBy: null, claimedAt: null, submissionId: null });
    });
  });

  // ─── Stale-lock + orphan detection (pure) ────────────────────────

  describe('detectStaleLock', () => {
    it('free lock is never stale', () => {
      const info = detectStaleLock(
        { heldBy: null, claimedAt: null, submissionId: null },
        () => true,
      );
      expect(info.isStale).toBe(false);
    });

    it('held by alive slug → not stale', () => {
      const state: ClearinghouseLockState = {
        heldBy: 'pressman-aa',
        claimedAt: '2026-04-26T10:00:00.000Z',
        submissionId: 'chit-cs-abc',
      };
      expect(detectStaleLock(state, () => true).isStale).toBe(false);
    });

    it('held by dead slug → stale', () => {
      const state: ClearinghouseLockState = {
        heldBy: 'pressman-aa',
        claimedAt: '2026-04-26T10:00:00.000Z',
        submissionId: 'chit-cs-abc',
      };
      expect(detectStaleLock(state, () => false).isStale).toBe(true);
    });
  });

  // ─── Cascade helpers (markSubmissionMerged / Failed) ─────────────

  describe('cascade helpers', () => {
    function makeContract(taskIds: string[]): string {
      const c = createChit<'contract'>(corpRoot, {
        type: 'contract',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          contract: {
            title: 'Test contract',
            goal: 'verify cascade',
            taskIds,
          },
        },
      });
      return c.id;
    }

    function makeTask(): string {
      const t = createChit<'task'>(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          task: {
            title: 'Test task',
            priority: 'normal',
            workflowStatus: 'clearance',
          },
        },
      });
      return t.id;
    }

    function makeSubmission(taskId: string, contractId: string): string {
      const s = createChit<'clearance-submission'>(corpRoot, {
        type: 'clearance-submission',
        scope: 'corp',
        createdBy: 'pressman-aa',
        fields: {
          'clearance-submission': {
            branch: 'feat/test',
            contractId,
            taskId,
            submitter: 'backend-engineer-toast',
            priority: 'normal',
            submittedAt: new Date().toISOString(),
            submissionStatus: 'processing',
            retryCount: 0,
            reviewRound: 1,
            processingBy: 'pressman-aa',
            processingStartedAt: new Date().toISOString(),
          },
        },
      });
      return s.id;
    }

    it('markSubmissionMerged advances task workflow + contract chit when sole task completes', () => {
      const taskId = makeTask();
      const contractId = makeContract([taskId]);
      const submissionId = makeSubmission(taskId, contractId);

      markSubmissionMerged({
        corpRoot,
        submissionId,
        mergeCommitSha: 'abc123def456',
        updatedBy: 'pressman-aa',
      });

      // Submission flipped to merged + completed.
      // Task workflow advanced to completed.
      // Contract chit.status flipped to completed (last task done).
      // Verify by reading back:
const subAfter = findChitById(corpRoot, submissionId);
      expect(subAfter.chit.fields['clearance-submission'].submissionStatus).toBe('merged');
      expect(subAfter.chit.fields['clearance-submission'].mergeCommitSha).toBe('abc123def456');
      expect(subAfter.chit.status).toBe('completed');

      const taskAfter = findChitById(corpRoot, taskId);
      expect(taskAfter.chit.fields.task.workflowStatus).toBe('completed');

      const contractAfter = findChitById(corpRoot, contractId);
      expect(contractAfter.chit.status).toBe('completed');
    });

    it('contract stays at prior status when sibling tasks are still in progress', () => {
      const taskA = makeTask();
      // Make a sibling task that's NOT in clearance — still in progress.
      const taskBChit = createChit<'task'>(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          task: {
            title: 'Sibling',
            priority: 'normal',
            workflowStatus: 'in_progress',
          },
        },
      });
      const contractId = makeContract([taskA, taskBChit.id]);
      const submissionId = makeSubmission(taskA, contractId);

      markSubmissionMerged({
        corpRoot,
        submissionId,
        updatedBy: 'pressman-aa',
      });

const contractAfter = findChitById(corpRoot, contractId);
      // Contract stays at draft (its initial state) — sibling unfinished.
      expect(contractAfter.chit.status).toBe('draft');
    });

    // Codex P2 regression (PR #191): markSubmissionMerged would
    // overwrite mergeCommitSha with null whenever a retry call
    // omitted opts.mergeCommitSha — losing the audit link to the
    // actual merged commit. Now preserves the existing stored value.
    it('markSubmissionMerged preserves mergeCommitSha across retry without sha arg', () => {
      const taskId = makeTask();
      const contractId = makeContract([taskId]);
      const submissionId = makeSubmission(taskId, contractId);

      // First call with sha — records it.
      markSubmissionMerged({
        corpRoot,
        submissionId,
        mergeCommitSha: 'abc123def456',
        updatedBy: 'pressman-aa',
      });

      const after1 = findChitById(corpRoot, submissionId);
      expect(after1!.chit.fields['clearance-submission'].mergeCommitSha).toBe('abc123def456');

      // Retry without sha (e.g. partial-cascade re-attempt). Must
      // preserve the recorded sha, not null it out.
      markSubmissionMerged({
        corpRoot,
        submissionId,
        updatedBy: 'pressman-aa',
      });

      const after2 = findChitById(corpRoot, submissionId);
      expect(after2!.chit.fields['clearance-submission'].mergeCommitSha).toBe('abc123def456');
    });

    it('markSubmissionFailed cascades task to failed but never the contract', () => {
      const taskId = makeTask();
      const contractId = makeContract([taskId]);
      const submissionId = makeSubmission(taskId, contractId);

      markSubmissionFailed({
        corpRoot,
        submissionId,
        reason: 'rebase exhausted retries',
        updatedBy: 'pressman-aa',
      });

const subAfter = findChitById(corpRoot, submissionId);
      expect(subAfter.chit.fields['clearance-submission'].submissionStatus).toBe('failed');
      expect(subAfter.chit.fields['clearance-submission'].lastFailureReason).toContain('rebase');

      const taskAfter = findChitById(corpRoot, taskId);
      expect(taskAfter.chit.fields.task.workflowStatus).toBe('failed');

      // Contract NOT auto-failed from one task.
      const contractAfter = findChitById(corpRoot, contractId);
      expect(contractAfter.chit.status).not.toBe('failed');
    });
  });

  // ─── Queue ordering ──────────────────────────────────────────────

  describe('rankQueue', () => {
    function makeQueuedSubmission(opts: {
      submittedAt: string;
      priority: 'critical' | 'high' | 'normal' | 'low';
      retryCount?: number;
    }): string {
      const s = createChit<'clearance-submission'>(corpRoot, {
        type: 'clearance-submission',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          'clearance-submission': {
            branch: 'feat/q',
            contractId: 'chit-c-stub',
            taskId: 'chit-t-stub',
            submitter: 'mark',
            priority: opts.priority,
            submittedAt: opts.submittedAt,
            submissionStatus: 'queued',
            retryCount: opts.retryCount ?? 0,
            reviewRound: 1,
          },
        },
      });
      return s.id;
    }

    it('returns empty when no submissions exist', () => {
      expect(rankQueue(corpRoot)).toEqual([]);
    });

    it('orders critical above normal above low at equal age', () => {
      const now = new Date('2026-04-26T12:00:00.000Z');
      const lowId = makeQueuedSubmission({
        submittedAt: '2026-04-26T12:00:00.000Z',
        priority: 'low',
      });
      const criticalId = makeQueuedSubmission({
        submittedAt: '2026-04-26T12:00:00.000Z',
        priority: 'critical',
      });
      const normalId = makeQueuedSubmission({
        submittedAt: '2026-04-26T12:00:00.000Z',
        priority: 'normal',
      });

      const ordered = rankQueue(corpRoot, now);
      expect(ordered.map((e) => e.chit.id)).toEqual([criticalId, normalId, lowId]);
    });

    it('excludes processing/conflict/merged from the queue', () => {
      const queued = makeQueuedSubmission({
        submittedAt: '2026-04-26T12:00:00.000Z',
        priority: 'normal',
      });
      // Make a processing one — shouldn't appear in ranked queue.
      createChit<'clearance-submission'>(corpRoot, {
        type: 'clearance-submission',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          'clearance-submission': {
            branch: 'feat/p',
            contractId: 'c',
            taskId: 't',
            submitter: 'mark',
            priority: 'critical',
            submittedAt: '2026-04-26T11:00:00.000Z',
            submissionStatus: 'processing',
            retryCount: 0,
            reviewRound: 1,
            processingBy: 'pressman-aa',
          },
        },
      });
      const ordered = rankQueue(corpRoot);
      expect(ordered).toHaveLength(1);
      expect(ordered[0]!.chit.id).toBe(queued);
    });
  });

  // ─── Resume composition ──────────────────────────────────────────

  describe('resumeClearinghouse', () => {
    it('no orphans + free lock → noop summary', () => {
      const result = resumeClearinghouse(corpRoot, () => true);
      expect(result.lockReleased).toBe(false);
      expect(result.submissionsReset).toBe(0);
    });

    it('releases stale lock + resets orphaned submission in one pass', () => {
      // Set up a held lock + a processing submission, both pointing
      // at a slug we'll declare dead.
      claimClearinghouseLock({
        corpRoot,
        slug: 'pressman-zombie',
        submissionId: 'chit-cs-abc',
      });
      const sub = createChit<'clearance-submission'>(corpRoot, {
        type: 'clearance-submission',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          'clearance-submission': {
            branch: 'feat/orphan',
            contractId: 'c',
            taskId: 't',
            submitter: 'mark',
            priority: 'normal',
            submittedAt: new Date().toISOString(),
            submissionStatus: 'processing',
            retryCount: 0,
            reviewRound: 1,
            processingBy: 'pressman-zombie',
            processingStartedAt: new Date().toISOString(),
          },
        },
      });

      const result = resumeClearinghouse(corpRoot, () => false);
      expect(result.lockReleased).toBe(true);
      expect(result.submissionsReset).toBe(1);

      // Verify state on disk.
      expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();
const after = findChitById(corpRoot, sub.id);
      expect(after.chit.fields['clearance-submission'].submissionStatus).toBe('queued');
      expect(after.chit.fields['clearance-submission'].processingBy).toBeNull();
      expect(after.chit.fields['clearance-submission'].lastFailureReason).toContain('zombie');
      // retryCount NOT incremented (restart isn't the submission's fault).
      expect(after.chit.fields['clearance-submission'].retryCount).toBe(0);
    });

    it('does not touch lock + submission when holder is alive', () => {
      claimClearinghouseLock({
        corpRoot,
        slug: 'pressman-aa',
        submissionId: 'chit-cs-abc',
      });
      const sub = createChit<'clearance-submission'>(corpRoot, {
        type: 'clearance-submission',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          'clearance-submission': {
            branch: 'feat/active',
            contractId: 'c',
            taskId: 't',
            submitter: 'mark',
            priority: 'normal',
            submittedAt: new Date().toISOString(),
            submissionStatus: 'processing',
            retryCount: 0,
            reviewRound: 1,
            processingBy: 'pressman-aa',
            processingStartedAt: new Date().toISOString(),
          },
        },
      });

      const result = resumeClearinghouse(corpRoot, (slug) => slug === 'pressman-aa');
      expect(result.lockReleased).toBe(false);
      expect(result.submissionsReset).toBe(0);

      expect(readClearinghouseLock(corpRoot).heldBy).toBe('pressman-aa');
const after = findChitById(corpRoot, sub.id);
      expect(after.chit.fields['clearance-submission'].submissionStatus).toBe('processing');
    });
  });
});
