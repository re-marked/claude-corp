import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  updateChit,
  chitScopeFromPath,
  findChitById,
  queryChits,
  applyReviewVerdict,
  findActiveReviewForTask,
  REVIEW_REDO_CAP_DEFAULT,
  ChitValidationError,
  type Chit,
  type Member,
  MEMBERS_JSON,
  type TaskFields,
  type ReviewFields,
} from '../packages/shared/src/index.js';

/**
 * Project 2.5 — validator gating + applyReviewVerdict routing.
 *
 * Two suites:
 *   - validateReview: verdict-gating rules (accept rejects
 *     redoFeedback; redo requires non-empty redoFeedback; flag
 *     rejects both companions).
 *   - applyReviewVerdict: routing per verdict + cap enforcement +
 *     refusal modes (wrong state, already-applied, missing chits).
 */

describe('validateReview — verdict-gating rules', () => {
  let corpRoot: string;
  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'review-validator-'));
  });
  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  const baseFields = {
    taskId: 'chit-t-test',
    contractId: 'chit-c-test',
    reviewerSlug: 'coder',
    reasoning: 'looks good, prior steps cohere',
  };

  function tryCreate(extraFields: Record<string, unknown>): { ok: boolean; error?: string } {
    try {
      createChit(corpRoot, {
        type: 'review',
        scope: 'corp',
        createdBy: 'coder',
        fields: { review: { ...baseFields, ...extraFields } } as never,
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof ChitValidationError) return { ok: false, error: err.message };
      throw err;
    }
  }

  it('accepts a valid accept verdict (no companion fields)', () => {
    const r = tryCreate({ verdict: 'accept' });
    expect(r.ok).toBe(true);
  });

  it('accepts an accept verdict with notesForNextTask', () => {
    const r = tryCreate({ verdict: 'accept', notesForNextTask: 'next step should re-read X' });
    expect(r.ok).toBe(true);
  });

  it('rejects an accept verdict with redoFeedback (companion-field mismatch)', () => {
    const r = tryCreate({ verdict: 'accept', redoFeedback: 'try again' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redoFeedback.*null on verdict=accept/);
  });

  it('rejects a redo verdict without redoFeedback', () => {
    const r = tryCreate({ verdict: 'redo' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redoFeedback required/);
  });

  it('rejects a redo verdict with empty/whitespace redoFeedback', () => {
    expect(tryCreate({ verdict: 'redo', redoFeedback: '' }).ok).toBe(false);
    expect(tryCreate({ verdict: 'redo', redoFeedback: '   ' }).ok).toBe(false);
  });

  it('accepts a redo verdict with substantive redoFeedback', () => {
    const r = tryCreate({
      verdict: 'redo',
      redoFeedback: 'step 3 ignored the decision step 1 made about cache invalidation',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a redo verdict with notesForNextTask (only valid on accept)', () => {
    const r = tryCreate({
      verdict: 'redo',
      redoFeedback: 'specific concrete feedback here',
      notesForNextTask: 'something for next task',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/notesForNextTask.*null on verdict=redo/);
  });

  it('accepts a flag verdict with reasoning (no companions)', () => {
    const r = tryCreate({ verdict: 'flag', reasoning: 'genuinely unclear; founder needed' });
    expect(r.ok).toBe(true);
  });

  it('rejects a flag verdict with notesForNextTask', () => {
    const r = tryCreate({
      verdict: 'flag',
      reasoning: 'something needs founder attention',
      notesForNextTask: 'something',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/notesForNextTask.*null on verdict=flag/);
  });

  it('rejects a flag verdict with redoFeedback', () => {
    const r = tryCreate({
      verdict: 'flag',
      reasoning: 'something needs founder attention',
      redoFeedback: 'something',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redoFeedback.*null on verdict=flag/);
  });

  it('rejects redo + flag verdicts with empty reasoning', () => {
    expect(tryCreate({ verdict: 'redo', redoFeedback: 'a real fix', reasoning: '' }).ok).toBe(false);
    expect(tryCreate({ verdict: 'flag', reasoning: '' }).ok).toBe(false);
  });

  it('rejects an unknown verdict value', () => {
    const r = tryCreate({ verdict: 'maybe' });
    expect(r.ok).toBe(false);
  });
});

describe('applyReviewVerdict — routing + cap + refusal modes', () => {
  let corpRoot: string;
  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'review-verdict-'));
    // Founder member — receives Tier-3 inbox-items on flag verdicts.
    const members: Member[] = [
      {
        id: 'mark',
        displayName: 'Mark',
        rank: 'owner',
        status: 'active',
        type: 'agent',
        scope: 'corp',
        scopeId: '',
        agentDir: 'agents/mark/',
        port: null,
        spawnedBy: null,
        createdAt: '2026-04-25T08:00:00.000Z',
      } as Member,
    ];
    writeFileSync(join(corpRoot, MEMBERS_JSON), JSON.stringify(members), 'utf-8');
  });
  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  /**
   * Fixture: Contract + one Task already in under_review state +
   * one review chit with the requested verdict. Returns the ids
   * so tests can mutate or assert.
   */
  function setupVerdict(opts: {
    verdict: 'accept' | 'redo' | 'flag';
    reasoning?: string;
    redoFeedback?: string;
    notesForNextTask?: string;
    initialRedoCount?: number;
  }): {
    taskId: string;
    contractId: string;
    reviewId: string;
  } {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      status: 'active',
      createdBy: 'coder',
      fields: {
        task: {
          title: 'do the thing',
          priority: 'normal',
          workflowStatus: 'under_review',
          reviewRedoCount: opts.initialRedoCount ?? 0,
        },
      } as never,
    });
    const contract = createChit(corpRoot, {
      type: 'contract',
      scope: 'corp',
      status: 'active',
      createdBy: 'coder',
      fields: {
        contract: {
          title: 'demo contract',
          goal: 'demo goal',
          taskIds: [task.id],
          priority: 'normal',
        },
      },
    });

    const reviewFields: Record<string, unknown> = {
      verdict: opts.verdict,
      reasoning: opts.reasoning ?? 'because reasons',
      taskId: task.id,
      contractId: contract.id,
      reviewerSlug: 'coder',
    };
    if (opts.redoFeedback !== undefined) reviewFields.redoFeedback = opts.redoFeedback;
    if (opts.notesForNextTask !== undefined) reviewFields.notesForNextTask = opts.notesForNextTask;

    const review = createChit(corpRoot, {
      type: 'review',
      scope: 'agent:coder',
      createdBy: 'coder',
      fields: { review: reviewFields } as never,
    });

    return { taskId: task.id, contractId: contract.id, reviewId: review.id };
  }

  // ── accept ──────────────────────────────────────────────────────

  it('accept: closes the review chit; leaves task in under_review; no inbox', () => {
    const { taskId, reviewId } = setupVerdict({ verdict: 'accept' });
    const result = applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    expect(result.applied).toBe(true);
    expect(result.outcomeVerdict).toBe('accept');
    expect(result.capDowngrade).toBe(false);
    expect(result.appliedTaskTransition).toBeNull();
    expect(result.inboxItemId).toBeNull();

    // Review chit is closed.
    const reviewHit = findChitById(corpRoot, reviewId);
    expect(reviewHit?.chit.status).toBe('closed');

    // Task is unchanged.
    const taskHit = findChitById(corpRoot, taskId);
    const taskFields = taskHit!.chit.fields.task as TaskFields;
    expect(taskFields.workflowStatus).toBe('under_review');
    expect(taskFields.reviewRedoCount ?? 0).toBe(0);
  });

  // ── redo (first time) ───────────────────────────────────────────

  it('redo: transitions task under_review → in_progress; bumps reviewRedoCount; no inbox', () => {
    const { taskId, reviewId } = setupVerdict({
      verdict: 'redo',
      redoFeedback: 'step 4 ignored step 2',
    });
    const result = applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    expect(result.applied).toBe(true);
    expect(result.outcomeVerdict).toBe('redo');
    expect(result.capDowngrade).toBe(false);
    expect(result.appliedTaskTransition).toEqual({ from: 'under_review', to: 'in_progress' });
    expect(result.inboxItemId).toBeNull();

    // Task transitioned.
    const taskHit = findChitById(corpRoot, taskId);
    const taskFields = taskHit!.chit.fields.task as TaskFields;
    expect(taskFields.workflowStatus).toBe('in_progress');
    expect(taskFields.reviewRedoCount).toBe(1);

    // Review chit closed.
    const reviewHit = findChitById(corpRoot, reviewId);
    expect(reviewHit?.chit.status).toBe('closed');
  });

  // ── redo cap (second redo auto-promotes to flag) ────────────────

  it('redo: second attempt with reviewRedoCount=1 auto-downgrades to flag (cap enforcement)', () => {
    const { taskId, reviewId } = setupVerdict({
      verdict: 'redo',
      redoFeedback: 'another specific gap',
      initialRedoCount: REVIEW_REDO_CAP_DEFAULT, // already at cap
    });
    const result = applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    expect(result.applied).toBe(true);
    expect(result.inputVerdict).toBe('redo');
    expect(result.outcomeVerdict).toBe('flag');
    expect(result.capDowngrade).toBe(true);

    // Task stays in under_review (flag doesn't transition).
    const taskHit = findChitById(corpRoot, taskId);
    const taskFields = taskHit!.chit.fields.task as TaskFields;
    expect(taskFields.workflowStatus).toBe('under_review');
    // reviewRedoCount NOT bumped on cap-downgrade (the redo didn't happen).
    expect(taskFields.reviewRedoCount).toBe(REVIEW_REDO_CAP_DEFAULT);

    // Inbox-item emitted to founder.
    expect(result.inboxItemId).not.toBeNull();
    const inboxHit = findChitById(corpRoot, result.inboxItemId!);
    expect(inboxHit?.chit.type).toBe('inbox-item');
    // scope is derived from file path, not stored on the chit. The
    // founder-recipient signal lives in the path itself.
    expect(chitScopeFromPath(corpRoot, inboxHit!.path)).toBe('agent:mark');

    // Review chit closed.
    const reviewHit = findChitById(corpRoot, reviewId);
    expect(reviewHit?.chit.status).toBe('closed');
  });

  // ── flag ────────────────────────────────────────────────────────

  it('flag: emits Tier-3 inbox-item to founder; leaves task in under_review', () => {
    const { taskId, reviewId } = setupVerdict({
      verdict: 'flag',
      reasoning: 'genuinely ambiguous; founder needed',
    });
    const result = applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    expect(result.applied).toBe(true);
    expect(result.outcomeVerdict).toBe('flag');
    expect(result.capDowngrade).toBe(false);
    expect(result.appliedTaskTransition).toBeNull();
    expect(result.inboxItemId).not.toBeNull();

    // Task unchanged.
    const taskHit = findChitById(corpRoot, taskId);
    const taskFields = taskHit!.chit.fields.task as TaskFields;
    expect(taskFields.workflowStatus).toBe('under_review');

    // Inbox-item exists at tier 3.
    const inboxHit = findChitById(corpRoot, result.inboxItemId!);
    const inboxFields = inboxHit!.chit.fields['inbox-item'] as { tier: number };
    expect(inboxFields.tier).toBe(3);
  });

  // ── Refusal modes ───────────────────────────────────────────────

  it('refuses when the review chit is already closed (verdict already applied)', () => {
    const { reviewId } = setupVerdict({ verdict: 'accept' });
    // Apply once.
    applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });
    // Apply again — should refuse.
    const second = applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });
    expect(second.applied).toBe(false);
    expect(second.errors.join(' ')).toMatch(/already applied|status is closed/);
  });

  it('refuses when the linked task is not in under_review', () => {
    const { taskId, reviewId } = setupVerdict({ verdict: 'accept' });
    // Force the task into a different state.
    const taskHit = findChitById(corpRoot, taskId);
    const scope = chitScopeFromPath(corpRoot, taskHit!.path);
    updateChit(corpRoot, scope, 'task', taskId, {
      updatedBy: 'test',
      fields: {
        task: {
          ...(taskHit!.chit.fields.task as TaskFields),
          workflowStatus: 'completed',
        },
      } as never,
    });

    const result = applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });
    expect(result.applied).toBe(false);
    expect(result.errors.join(' ')).toMatch(/workflowStatus is completed/);
  });

  it('refuses when the review chit id does not resolve', () => {
    const result = applyReviewVerdict(corpRoot, {
      reviewChitId: 'chit-rev-vanished',
      founderMemberId: 'mark',
    });
    expect(result.applied).toBe(false);
    expect(result.errors.join(' ')).toMatch(/review chit not found/);
  });
});

describe('findActiveReviewForTask', () => {
  let corpRoot: string;
  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'find-review-'));
  });
  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it('returns the active review chit for a task; null when none', () => {
    const taskId = 'chit-t-test';
    expect(findActiveReviewForTask(corpRoot, taskId)).toBeNull();

    const review = createChit(corpRoot, {
      type: 'review',
      scope: 'agent:coder',
      createdBy: 'coder',
      fields: {
        review: {
          verdict: 'redo',
          reasoning: 'specific gap',
          taskId,
          contractId: 'chit-c-test',
          reviewerSlug: 'coder',
          redoFeedback: 'concrete fix instruction',
        } as ReviewFields,
      } as never,
    });

    const found = findActiveReviewForTask(corpRoot, taskId);
    expect(found?.id).toBe(review.id);
  });

  it('returns null when the only review chit for the task is closed', () => {
    const taskId = 'chit-t-test2';
    const review = createChit(corpRoot, {
      type: 'review',
      scope: 'agent:coder',
      createdBy: 'coder',
      fields: {
        review: {
          verdict: 'accept',
          reasoning: 'looks good',
          taskId,
          contractId: 'chit-c-test',
          reviewerSlug: 'coder',
        } as ReviewFields,
      } as never,
    });
    // Close it.
    const hit = findChitById(corpRoot, review.id);
    const scope = chitScopeFromPath(corpRoot, hit!.path);
    updateChit(corpRoot, scope, 'review', review.id, {
      updatedBy: 'test',
      status: 'closed',
    });

    expect(findActiveReviewForTask(corpRoot, taskId)).toBeNull();
  });
});
