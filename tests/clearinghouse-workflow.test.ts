import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  findChitById,
  readClearinghouseLock,
  claimClearinghouseLock,
  completeDeferredTaskClose,
  MEMBERS_JSON,
  type Chit,
} from '../packages/shared/src/index.js';
import {
  pickNext,
  acquireWorktree,
  finalizeMerged,
  fileBlocker,
  markFailedAndRelease,
  releaseAll,
  cleanupOrphanWorktrees,
  isClearinghouseAwareCorp,
  ok,
  err,
  failure,
  type GitOps,
  type Result,
} from '../packages/daemon/src/clearinghouse/index.js';

/**
 * Minimal coverage for Project 1.12.1 workflow primitives + the
 * Codex P1+P2 follow-ups (completeDeferredTaskClose, archived-Pressman
 * filter on isClearinghouseAwareCorp).
 *
 * Per Mark's "tests rarely catch real stuff" guidance, scope is
 * intentionally narrow:
 *   - pickNext lock+resume+claim logic (the hole-fix this PR landed).
 *   - acquireWorktree path handling (idempotent + force-clean reuse).
 *   - terminal-state primitives' lock-release resilience (lock must
 *     release even when chit ops throw — that's the "don't strand
 *     the lane" invariant).
 *   - cleanupOrphanWorktrees prefix-match logic.
 *   - completeDeferredTaskClose terminal-idempotence + actual close.
 *   - isClearinghouseAwareCorp full filter (role + type + non-archived).
 *
 * Out of scope: rebaseStep / testStep / mergeStep — they're thin
 * delegates over PR 2 primitives that already have ~70 tests in
 * clearinghouse-primitives.test.ts. CLI subcommands are mechanical
 * args parsing.
 */

// ─── Helpers ─────────────────────────────────────────────────────────

function buildMockGitOps(scripts: Partial<GitOps> = {}): GitOps {
  const noopAsync = async (): Promise<Result<void>> => ok<void>(undefined);
  return {
    fetchOrigin: scripts.fetchOrigin ?? noopAsync,
    worktreeAdd: scripts.worktreeAdd ?? noopAsync,
    worktreeRemove: scripts.worktreeRemove ?? noopAsync,
    worktreeList: scripts.worktreeList ?? (async () => ok([])),
    rebase: scripts.rebase ?? (async () => ok({ state: 'clean' as const })),
    rebaseAbort: scripts.rebaseAbort ?? noopAsync,
    rebaseContinue: scripts.rebaseContinue ?? (async () => ok({ state: 'clean' as const })),
    stageAll: scripts.stageAll ?? noopAsync,
    push: scripts.push ?? (async () => ok({ state: 'pushed' as const })),
    currentSha: scripts.currentSha ?? (async () => ok('a'.repeat(40))),
    diffStats: scripts.diffStats ?? (async () => ok({ filesChanged: 0, insertions: 0, deletions: 0 })),
    listConflictedFiles: scripts.listConflictedFiles ?? (async () => ok([])),
    branchExists: scripts.branchExists ?? (async () => ok(true)),
    isClean: scripts.isClean ?? (async () => ok(true)),
    resetHard: scripts.resetHard ?? noopAsync,
    cleanWorkdir: scripts.cleanWorkdir ?? noopAsync,
    checkoutRef: scripts.checkoutRef ?? noopAsync,
  };
}

interface MemberFixture {
  id: string;
  role?: string;
  type?: string;
  status?: string;
}

function writeMembers(corpRoot: string, members: MemberFixture[]): void {
  writeFileSync(join(corpRoot, MEMBERS_JSON), JSON.stringify(members, null, 2));
}

interface SubmissionFixtureOpts {
  taskId?: string;
  contractId?: string;
  branch?: string;
  submitter?: string;
  submissionStatus?: 'queued' | 'processing' | 'merged' | 'failed' | 'conflict';
  retryCount?: number;
}

function createSubmission(corpRoot: string, opts: SubmissionFixtureOpts = {}): Chit<'clearance-submission'> {
  return createChit<'clearance-submission'>(corpRoot, {
    type: 'clearance-submission',
    scope: 'corp',
    createdBy: 'test',
    fields: {
      'clearance-submission': {
        branch: opts.branch ?? 'feat/x',
        contractId: opts.contractId ?? 'contract-x',
        taskId: opts.taskId ?? 'task-x',
        submitter: opts.submitter ?? 'toast',
        priority: 'normal',
        submittedAt: new Date().toISOString(),
        submissionStatus: opts.submissionStatus ?? 'queued',
        retryCount: opts.retryCount ?? 0,
        reviewRound: 0,
        reviewBypassed: true,
        processingBy: null,
        mergeCommitSha: null,
        lastFailureReason: null,
      },
    },
  });
}

function createTask(corpRoot: string, _id: string, workflowStatus: 'in_progress' | 'under_review' | 'clearance' | 'completed' = 'under_review'): Chit<'task'> {
  // chit.status mirrors workflow's terminal/non-terminal split — the
  // helper checks chit.status when deciding idempotence, so the
  // fixture stamps both consistently.
  const chitStatus = workflowStatus === 'completed' ? 'completed' : 'active';
  return createChit<'task'>(corpRoot, {
    type: 'task',
    scope: 'corp',
    createdBy: 'test',
    status: chitStatus,
    fields: {
      task: {
        title: 'fixture task',
        priority: 'normal',
        complexity: 'small',
        workflowStatus,
        assignee: 'toast',
      } as never,
    },
  });
}

// ─── pickNext ────────────────────────────────────────────────────────

describe('pickNext', () => {
  let corpRoot: string;
  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'pickNext-'));
  });
  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it('errors when the slug does not resolve to a Pressman in members.json', () => {
    writeMembers(corpRoot, [{ id: 'editor-1', role: 'editor' }]);
    const result = pickNext({ corpRoot, pressmanSlug: 'pressman-1' });
    expect(result.ok).toBe(false);
  });

  it('returns ok(null) when the lock is held by another Pressman', () => {
    writeMembers(corpRoot, [
      { id: 'pressman-1', role: 'pressman' },
      { id: 'pressman-2', role: 'pressman' },
    ]);
    createSubmission(corpRoot);
    claimClearinghouseLock({ corpRoot, slug: 'pressman-2', submissionId: 'some-other' });
    const result = pickNext({ corpRoot, pressmanSlug: 'pressman-1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('returns ok(null) when the queue is empty', () => {
    writeMembers(corpRoot, [{ id: 'pressman-1', role: 'pressman' }]);
    const result = pickNext({ corpRoot, pressmanSlug: 'pressman-1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('claims the lock + flips submissionStatus to processing on success', () => {
    writeMembers(corpRoot, [{ id: 'pressman-1', role: 'pressman' }]);
    const sub = createSubmission(corpRoot, { branch: 'feat/y' });

    const result = pickNext({ corpRoot, pressmanSlug: 'pressman-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.submissionId).toBe(sub.id);
    expect(result.value!.resumed).toBe(false);
    expect(result.value!.branch).toBe('feat/y');

    // Lock holds it now.
    const lock = readClearinghouseLock(corpRoot);
    expect(lock.heldBy).toBe('pressman-1');
    expect(lock.submissionId).toBe(sub.id);

    // submissionStatus flipped to 'processing' + processingBy stamped.
    // (This was the orphan-recovery hole the wrong-shape never filled.)
    const after = findChitById(corpRoot, sub.id);
    expect(after).toBeTruthy();
    if (after) {
      const f = (after.chit as Chit<'clearance-submission'>).fields['clearance-submission'];
      expect(f.submissionStatus).toBe('processing');
      expect(f.processingBy).toBe('pressman-1');
    }
  });

  it('returns resumed=true when the lock already points at a submission held by this Pressman', () => {
    writeMembers(corpRoot, [{ id: 'pressman-1', role: 'pressman' }]);
    const sub = createSubmission(corpRoot, { submissionStatus: 'processing' });
    claimClearinghouseLock({ corpRoot, slug: 'pressman-1', submissionId: sub.id });

    const result = pickNext({ corpRoot, pressmanSlug: 'pressman-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.resumed).toBe(true);
    expect(result.value!.submissionId).toBe(sub.id);
  });
});

// ─── acquireWorktree ─────────────────────────────────────────────────

describe('acquireWorktree', () => {
  let corpRoot: string;
  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'acquireWt-'));
  });
  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it('calls worktreeAdd with the deterministic path on a fresh acquire', async () => {
    let addedPath: string | undefined;
    const gitOps = buildMockGitOps({
      worktreeAdd: async (_branch, path) => {
        addedPath = path;
        return ok(undefined);
      },
    });
    const result = await acquireWorktree({
      corpRoot,
      submissionId: 'chit-csub-abcdef123456',
      branch: 'feat/x',
      gitOps,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toContain('wt-');
      expect(addedPath).toBe(result.value.path);
    }
  });

  it('force-removes an existing worktree dir before re-adding (resumption case)', async () => {
    // Pre-create the deterministic path so existsSync hits.
    const subId = 'chit-csub-resume000000';
    const expectedPrefix = subId.slice(0, 12);
    const expectedPath = join(corpRoot, '.clearinghouse', `wt-${expectedPrefix}`);
    mkdirSync(expectedPath, { recursive: true });

    let removeCalled = false;
    let addCalled = false;
    const gitOps = buildMockGitOps({
      worktreeRemove: async () => { removeCalled = true; return ok(undefined); },
      worktreeAdd: async () => { addCalled = true; return ok(undefined); },
    });
    const result = await acquireWorktree({
      corpRoot,
      submissionId: subId,
      branch: 'feat/x',
      gitOps,
    });
    expect(result.ok).toBe(true);
    expect(removeCalled).toBe(true);
    expect(addCalled).toBe(true);
  });
});

// ─── terminal-state primitives — lock-release resilience ─────────────

describe('terminal-state lock release', () => {
  let corpRoot: string;
  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'terminal-'));
  });
  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it('finalizeMerged releases the lock even when the cascade has nothing to advance', async () => {
    // Submission missing → markSubmissionMerged throws inside finalizeMerged.
    // Lock should still be released.
    claimClearinghouseLock({ corpRoot, slug: 'pressman-1', submissionId: 'phantom-sub' });
    const result = await finalizeMerged({
      corpRoot,
      submissionId: 'phantom-sub',
      slug: 'pressman-1',
      gitOps: buildMockGitOps(),
    });
    // Cascade error surfaces via Result.err, but the lock IS free.
    expect(result.ok).toBe(false);
    expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();
  });

  it('fileBlocker releases the lock even when the submission lookup fails', async () => {
    claimClearinghouseLock({ corpRoot, slug: 'pressman-1', submissionId: 'phantom-sub' });
    const result = await fileBlocker({
      corpRoot,
      submissionId: 'phantom-sub',
      kind: 'rebase-conflict',
      summary: 'unused',
      detail: 'unused',
      slug: 'pressman-1',
      gitOps: buildMockGitOps(),
    });
    expect(result.ok).toBe(false);
    expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();
  });

  it('markFailedAndRelease re-queues under cap + releases lock', async () => {
    const sub = createSubmission(corpRoot, { submissionStatus: 'processing', retryCount: 1 });
    claimClearinghouseLock({ corpRoot, slug: 'pressman-1', submissionId: sub.id });

    const result = await markFailedAndRelease({
      corpRoot,
      submissionId: sub.id,
      reason: 'push race',
      slug: 'pressman-1',
      requeue: true,
      gitOps: buildMockGitOps(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requeued).toBe(true);
      expect(result.value.retryCount).toBe(2);
    }
    expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();

    const after = findChitById(corpRoot, sub.id);
    if (after) {
      const f = (after.chit as Chit<'clearance-submission'>).fields['clearance-submission'];
      expect(f.submissionStatus).toBe('queued');
    }
  });

  it('releaseAll is a bare lock + worktree cleanup with no chit changes', async () => {
    claimClearinghouseLock({ corpRoot, slug: 'pressman-1', submissionId: 'sub-x' });
    let removeCalled = false;
    const gitOps = buildMockGitOps({
      worktreeRemove: async () => { removeCalled = true; return ok(undefined); },
    });
    const result = await releaseAll({
      corpRoot,
      slug: 'pressman-1',
      worktreePath: '/tmp/fake',
      gitOps,
    });
    expect(result.ok).toBe(true);
    expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();
    expect(removeCalled).toBe(true);
  });
});

// ─── cleanupOrphanWorktrees ──────────────────────────────────────────

describe('cleanupOrphanWorktrees', () => {
  let corpRoot: string;
  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'orphan-wt-'));
  });
  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it('returns 0 removed when the parent dir does not exist', async () => {
    const result = await cleanupOrphanWorktrees({ corpRoot, gitOps: buildMockGitOps() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.removed).toBe(0);
  });

  it('removes wt-* dirs whose prefix does not match any active submission', async () => {
    // Create one active submission; its prefix should be PRESERVED.
    const sub = createSubmission(corpRoot);
    const livePrefix = sub.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);

    // Two on-disk wt-* dirs: one matching the live submission, one orphan.
    const parent = join(corpRoot, '.clearinghouse');
    mkdirSync(join(parent, `wt-${livePrefix}`), { recursive: true });
    mkdirSync(join(parent, 'wt-deadbeef0000'), { recursive: true });

    const removed: string[] = [];
    const gitOps = buildMockGitOps({
      worktreeRemove: async (path) => { removed.push(path); return ok(undefined); },
    });
    const result = await cleanupOrphanWorktrees({ corpRoot, gitOps });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.removed).toBe(1);
      expect(result.value.failed).toBe(0);
    }
    // The orphan was removed, the live one was not.
    expect(removed).toEqual([join(parent, 'wt-deadbeef0000')]);
  });
});

// ─── completeDeferredTaskClose (Codex P1) ────────────────────────────

describe('completeDeferredTaskClose', () => {
  let corpRoot: string;
  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'deferred-close-'));
  });
  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it('is a no-op on already-terminal tasks (idempotent recovery)', () => {
    const task = createTask(corpRoot, 'task-1', 'completed');
    const result = completeDeferredTaskClose(corpRoot, task.id, { closedBy: 'agent-1' });
    expect(result.closed).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('closes an under_review task — chit.status flips to completed', () => {
    const task = createTask(corpRoot, 'task-1', 'under_review');
    const result = completeDeferredTaskClose(corpRoot, task.id, {
      closedBy: 'agent-1',
      reason: 'no contract',
    });
    expect(result.closed).toBe(true);

    const after = findChitById(corpRoot, task.id);
    expect(after?.chit.status).toBe('completed');
  });

  it('returns an error entry when the task does not exist', () => {
    const result = completeDeferredTaskClose(corpRoot, 'phantom-task', { closedBy: 'agent-1' });
    expect(result.closed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ─── isClearinghouseAwareCorp (Codex P2 mirror) ──────────────────────

describe('isClearinghouseAwareCorp', () => {
  let corpRoot: string;
  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'aware-'));
  });
  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it('returns true when an active Pressman agent exists', () => {
    writeMembers(corpRoot, [
      { id: 'p-1', role: 'pressman', type: 'agent' },
    ]);
    expect(isClearinghouseAwareCorp(corpRoot)).toBe(true);
  });

  it('returns false when the only Pressman is archived', () => {
    writeMembers(corpRoot, [
      { id: 'p-1', role: 'pressman', type: 'agent', status: 'archived' },
    ]);
    expect(isClearinghouseAwareCorp(corpRoot)).toBe(false);
  });

  it('returns false when the Pressman record is not type=agent', () => {
    writeMembers(corpRoot, [
      { id: 'p-1', role: 'pressman', type: 'human' },
    ]);
    expect(isClearinghouseAwareCorp(corpRoot)).toBe(false);
  });

  it('returns false when no Pressman is hired', () => {
    writeMembers(corpRoot, [
      { id: 'editor-1', role: 'editor', type: 'agent' },
    ]);
    expect(isClearinghouseAwareCorp(corpRoot)).toBe(false);
  });

  it('returns false when members.json is missing', () => {
    expect(isClearinghouseAwareCorp(corpRoot)).toBe(false);
  });
});

// suppress unused-import warnings on helpers we keep for symmetry
void existsSync;
void err;
void failure;
