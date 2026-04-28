import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  findChitById,
  MEMBERS_JSON,
  editorRules,
  type Chit,
} from '../packages/shared/src/index.js';
import {
  isEditorAwareCorp,
  setEditorReviewRequested,
  pickNextReview,
  fileReviewComment,
  rejectReview,
  releaseReview,
  findOrphanedReviewerClaims,
  resumeEditorReviews,
} from '../packages/daemon/src/clearinghouse/index.js';

/**
 * Minimal coverage for Project 1.12.2 editor-workflow primitives.
 * Per Mark's "tests rarely catch real stuff" guidance, scope is the
 * judgment-encoded primitives — claim races, defensive guards, cap
 * mechanics, stale-claim recovery. The thin CLI wrappers and the
 * approveReview / bypassReview primitives (which fire enterClearance
 * + push to origin) are out of scope; covering them needs git mocks
 * already exercised in 1.12.1's clearinghouse-workflow tests.
 */

interface MemberFixture {
  id: string;
  displayName: string;
  type: string;
  rank: string;
  role?: string;
  status?: string;
}

function writeMembers(corpRoot: string, members: MemberFixture[]): void {
  writeFileSync(join(corpRoot, MEMBERS_JSON), JSON.stringify(members, null, 2));
}

interface TaskFixtureOpts {
  workflowStatus?: 'in_progress' | 'under_review' | 'clearance' | 'completed';
  assignee?: string;
  acceptanceCriteria?: string[];
  editorReviewRequested?: boolean;
  editorReviewRound?: number;
  editorReviewCapHit?: boolean;
  branchUnderReview?: string;
  reviewerClaim?: { slug: string; claimedAt: string } | null;
  priority?: 'critical' | 'high' | 'normal' | 'low';
}

function createTask(corpRoot: string, opts: TaskFixtureOpts = {}): Chit<'task'> {
  // chit-level status='active' so queryChits' statuses=['active']
  // filter (used by pickNextReview, findOrphanedReviewerClaims, and
  // the runtime sweep) actually matches the fixture. createChit
  // defaults to 'draft' for non-terminal workflowStatus values; in
  // production audit's promotion path lifts to 'active', but tests
  // skip that path and write directly.
  return createChit<'task'>(corpRoot, {
    type: 'task',
    scope: 'corp',
    createdBy: 'test',
    status: 'active',
    fields: {
      task: {
        title: 'fixture task',
        priority: opts.priority ?? 'normal',
        complexity: 'small',
        workflowStatus: opts.workflowStatus ?? 'under_review',
        assignee: opts.assignee ?? 'toast',
        acceptanceCriteria: opts.acceptanceCriteria ?? null,
        editorReviewRequested: opts.editorReviewRequested ?? false,
        editorReviewRound: opts.editorReviewRound ?? 0,
        editorReviewCapHit: opts.editorReviewCapHit ?? false,
        branchUnderReview: opts.branchUnderReview ?? null,
        reviewerClaim: opts.reviewerClaim ?? null,
      } as never,
    },
  });
}

function createContract(corpRoot: string, taskIds: string[]): Chit<'contract'> {
  return createChit<'contract'>(corpRoot, {
    type: 'contract',
    scope: 'corp',
    createdBy: 'test',
    fields: {
      contract: {
        title: 'fixture contract',
        goal: 'satisfy the test',
        taskIds,
      } as never,
    },
  });
}

// ─── isEditorAwareCorp ───────────────────────────────────────────────

describe('isEditorAwareCorp', () => {
  let corpRoot: string;
  beforeEach(() => { corpRoot = mkdtempSync(join(tmpdir(), 'editor-aware-')); });
  afterEach(() => { try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ } });

  it('returns true when an active Editor agent exists', () => {
    writeMembers(corpRoot, [
      { id: 'e-1', displayName: 'Editor', type: 'agent', rank: 'worker', role: 'editor' },
    ]);
    expect(isEditorAwareCorp(corpRoot)).toBe(true);
  });

  it('returns false when the only Editor is archived', () => {
    writeMembers(corpRoot, [
      { id: 'e-1', displayName: 'Editor', type: 'agent', rank: 'worker', role: 'editor', status: 'archived' },
    ]);
    expect(isEditorAwareCorp(corpRoot)).toBe(false);
  });

  it('returns false when the Editor record is not type=agent', () => {
    writeMembers(corpRoot, [
      { id: 'e-1', displayName: 'Editor', type: 'human', rank: 'worker', role: 'editor' },
    ]);
    expect(isEditorAwareCorp(corpRoot)).toBe(false);
  });

  it('returns false when no Editor is hired', () => {
    writeMembers(corpRoot, [
      { id: 'p-1', displayName: 'Pressman', type: 'agent', rank: 'worker', role: 'pressman' },
    ]);
    expect(isEditorAwareCorp(corpRoot)).toBe(false);
  });

  it('returns false when members.json is missing', () => {
    expect(isEditorAwareCorp(corpRoot)).toBe(false);
  });
});

// ─── setEditorReviewRequested ────────────────────────────────────────

describe('setEditorReviewRequested', () => {
  let corpRoot: string;
  beforeEach(() => { corpRoot = mkdtempSync(join(tmpdir(), 'set-review-')); });
  afterEach(() => { try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ } });

  it('refuses tasks not at workflowStatus=under_review (defensive guard)', () => {
    const task = createTask(corpRoot, { workflowStatus: 'in_progress' });
    const result = setEditorReviewRequested({
      corpRoot,
      taskId: task.id,
      branchUnderReview: 'feat/x',
      requestedBy: 'system',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.pedagogicalSummary).toContain("expected 'under_review'");
    }
  });

  it('sets editorReviewRequested + branchUnderReview on under_review tasks', () => {
    const task = createTask(corpRoot, { workflowStatus: 'under_review' });
    const result = setEditorReviewRequested({
      corpRoot,
      taskId: task.id,
      branchUnderReview: 'feat/y',
      requestedBy: 'system',
    });
    expect(result.ok).toBe(true);

    const after = findChitById(corpRoot, task.id);
    expect(after).toBeTruthy();
    if (after) {
      const f = (after.chit as Chit<'task'>).fields.task;
      expect(f.editorReviewRequested).toBe(true);
      expect(f.branchUnderReview).toBe('feat/y');
    }
  });
});

// ─── pickNextReview ──────────────────────────────────────────────────

describe('pickNextReview', () => {
  let corpRoot: string;
  beforeEach(() => { corpRoot = mkdtempSync(join(tmpdir(), 'pick-review-')); });
  afterEach(() => { try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ } });

  it('errors when slug does not resolve to a hired Editor', () => {
    writeMembers(corpRoot, [
      { id: 'p-1', displayName: 'Pressman', type: 'agent', rank: 'worker', role: 'pressman' },
    ]);
    const result = pickNextReview({ corpRoot, editorSlug: 'editor-1' });
    expect(result.ok).toBe(false);
  });

  it('returns ok(null) when no review-eligible tasks exist', () => {
    writeMembers(corpRoot, [
      { id: 'editor-1', displayName: 'Editor', type: 'agent', rank: 'worker', role: 'editor' },
    ]);
    createTask(corpRoot, { editorReviewRequested: false });
    const result = pickNextReview({ corpRoot, editorSlug: 'editor-1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('claims an eligible task atomically and stamps reviewerClaim', () => {
    writeMembers(corpRoot, [
      { id: 'editor-1', displayName: 'Editor', type: 'agent', rank: 'worker', role: 'editor' },
    ]);
    const task = createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/y',
    });
    const result = pickNextReview({ corpRoot, editorSlug: 'editor-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.taskId).toBe(task.id);
    expect(result.value!.resumed).toBe(false);
    expect(result.value!.branch).toBe('feat/y');

    const after = findChitById(corpRoot, task.id);
    if (after) {
      const f = (after.chit as Chit<'task'>).fields.task;
      expect(f.reviewerClaim?.slug).toBe('editor-1');
    }
  });

  it('skips tasks claimed by another Editor', () => {
    writeMembers(corpRoot, [
      { id: 'editor-1', displayName: 'Editor 1', type: 'agent', rank: 'worker', role: 'editor' },
      { id: 'editor-2', displayName: 'Editor 2', type: 'agent', rank: 'worker', role: 'editor' },
    ]);
    createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/y',
      reviewerClaim: { slug: 'editor-2', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    const result = pickNextReview({ corpRoot, editorSlug: 'editor-1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('returns resumed=true when this Editor already holds the claim', () => {
    writeMembers(corpRoot, [
      { id: 'editor-1', displayName: 'Editor', type: 'agent', rank: 'worker', role: 'editor' },
    ]);
    createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/y',
      reviewerClaim: { slug: 'editor-1', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    const result = pickNextReview({ corpRoot, editorSlug: 'editor-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.resumed).toBe(true);
  });

  it('skips capHit tasks even when requested', () => {
    writeMembers(corpRoot, [
      { id: 'editor-1', displayName: 'Editor', type: 'agent', rank: 'worker', role: 'editor' },
    ]);
    createTask(corpRoot, {
      editorReviewRequested: true,
      editorReviewCapHit: true,
      branchUnderReview: 'feat/y',
    });
    const result = pickNextReview({ corpRoot, editorSlug: 'editor-1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('orders eligible tasks by priority (critical first)', () => {
    writeMembers(corpRoot, [
      { id: 'editor-1', displayName: 'Editor', type: 'agent', rank: 'worker', role: 'editor' },
    ]);
    createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/normal',
      priority: 'normal',
    });
    const high = createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/critical',
      priority: 'critical',
    });
    const result = pickNextReview({ corpRoot, editorSlug: 'editor-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.taskId).toBe(high.id);
  });
});

// ─── fileReviewComment ───────────────────────────────────────────────

describe('fileReviewComment', () => {
  let corpRoot: string;
  beforeEach(() => { corpRoot = mkdtempSync(join(tmpdir(), 'file-comment-')); });
  afterEach(() => { try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ } });

  it('errors when the slug does not hold the claim', () => {
    const task = createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/x',
      reviewerClaim: { slug: 'editor-2', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    const result = fileReviewComment({
      corpRoot,
      taskId: task.id,
      reviewerSlug: 'editor-1',
      filePath: 'src/foo.ts',
      lineStart: 10,
      lineEnd: 12,
      severity: 'blocker',
      category: 'bug',
      issue: 'unhandled null',
      why: 'crashes when arg is null',
      reviewRound: 1,
    });
    expect(result.ok).toBe(false);
  });

  it('creates a review-comment chit when the claim matches', () => {
    const task = createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/x',
      reviewerClaim: { slug: 'editor-1', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    const result = fileReviewComment({
      corpRoot,
      taskId: task.id,
      reviewerSlug: 'editor-1',
      filePath: 'src/foo.ts',
      lineStart: 10,
      lineEnd: 10,
      severity: 'suggestion',
      category: 'drift',
      issue: 'criterion 2 not satisfied',
      why: 'task says X but diff does Y',
      reviewRound: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.commentId).toMatch(/./);
  });
});

// ─── rejectReview ────────────────────────────────────────────────────

describe('rejectReview', () => {
  let corpRoot: string;
  beforeEach(() => { corpRoot = mkdtempSync(join(tmpdir(), 'reject-')); });
  afterEach(() => { try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ } });

  it('increments editorReviewRound + clears claim + files escalation + reverts workflowStatus to in_progress', () => {
    const task = createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/x',
      reviewerClaim: { slug: 'editor-1', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    const result = rejectReview({
      corpRoot,
      taskId: task.id,
      reviewerSlug: 'editor-1',
      reason: '2 blockers across passes',
      detail: 'see review-comments',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.newRound).toBe(1);
    expect(result.value.capHit).toBe(false);
    expect(result.value.escalationId).toBeTruthy();

    const after = findChitById(corpRoot, task.id);
    if (after) {
      const f = (after.chit as Chit<'task'>).fields.task;
      expect(f.editorReviewRound).toBe(1);
      expect(f.editorReviewCapHit).toBe(false);
      expect(f.editorReviewRequested).toBe(false);
      expect(f.reviewerClaim).toBeNull();
      expect(f.branchUnderReview).toBeNull();
      // Codex P1 round 3: workflowStatus must move under_review →
      // in_progress so the author can re-run cc-cli done after
      // addressing the rejection comments.
      expect(f.workflowStatus).toBe('in_progress');
    }
  });

  it('flips capHit when the round reaches the default cap (3)', () => {
    const task = createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/x',
      editorReviewRound: 2, // already 2 prior rejections; this is round 3
      reviewerClaim: { slug: 'editor-1', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    const result = rejectReview({
      corpRoot,
      taskId: task.id,
      reviewerSlug: 'editor-1',
      reason: 'still issues',
      detail: 'see comments',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.newRound).toBe(3);
    expect(result.value.capHit).toBe(true);
  });
});

// ─── releaseReview ───────────────────────────────────────────────────

describe('releaseReview', () => {
  let corpRoot: string;
  beforeEach(() => { corpRoot = mkdtempSync(join(tmpdir(), 'release-rv-')); });
  afterEach(() => { try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ } });

  it('clears only the claim — leaves request flag + branchUnderReview', () => {
    const task = createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/x',
      reviewerClaim: { slug: 'editor-1', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    const result = releaseReview({ corpRoot, taskId: task.id, reviewerSlug: 'editor-1' });
    expect(result.ok).toBe(true);
    const after = findChitById(corpRoot, task.id);
    if (after) {
      const f = (after.chit as Chit<'task'>).fields.task;
      expect(f.reviewerClaim).toBeNull();
      expect(f.editorReviewRequested).toBe(true);
      expect(f.branchUnderReview).toBe('feat/x');
    }
  });

  it('soft no-ops when slug does not hold the claim', () => {
    const task = createTask(corpRoot, {
      editorReviewRequested: true,
      branchUnderReview: 'feat/x',
      reviewerClaim: { slug: 'editor-2', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    const result = releaseReview({ corpRoot, taskId: task.id, reviewerSlug: 'editor-1' });
    expect(result.ok).toBe(true);
    const after = findChitById(corpRoot, task.id);
    if (after) {
      const f = (after.chit as Chit<'task'>).fields.task;
      expect(f.reviewerClaim?.slug).toBe('editor-2');
    }
  });
});

// ─── Stale-claim recovery ────────────────────────────────────────────

describe('stale-claim recovery', () => {
  let corpRoot: string;
  beforeEach(() => { corpRoot = mkdtempSync(join(tmpdir(), 'stale-claim-')); });
  afterEach(() => { try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ } });

  it('findOrphanedReviewerClaims surfaces dead-Editor claims', () => {
    createTask(corpRoot, {
      reviewerClaim: { slug: 'editor-dead', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    createTask(corpRoot, {
      reviewerClaim: { slug: 'editor-live', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    const isAlive = (slug: string) => slug === 'editor-live';
    const orphans = findOrphanedReviewerClaims(corpRoot, isAlive);
    expect(orphans.length).toBe(1);
    expect(orphans[0]!.orphanedFrom).toBe('editor-dead');
  });

  it('resumeEditorReviews clears stale claims', () => {
    const task = createTask(corpRoot, {
      reviewerClaim: { slug: 'editor-dead', claimedAt: '2026-04-28T12:00:00.000Z' },
    });
    const isAlive = (_slug: string) => false;
    const result = resumeEditorReviews(corpRoot, isAlive);
    expect(result.claimsReset).toBe(1);
    const after = findChitById(corpRoot, task.id);
    if (after) {
      expect((after.chit as Chit<'task'>).fields.task.reviewerClaim).toBeNull();
    }
  });
});

// ─── editorRules smoke ───────────────────────────────────────────────

describe('editorRules', () => {
  it('returns non-empty content with the patrol/code-review reference', () => {
    const content = editorRules({ rank: 'worker', harness: 'openclaw' });
    expect(content.length).toBeGreaterThan(500);
    expect(content).toContain('patrol/code-review');
    expect(content).toContain('bug pass');
    expect(content).toContain('drift pass');
  });
});

// suppress unused-import warnings for symmetry
void createContract;
