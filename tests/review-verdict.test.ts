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
  consumePendingRedoFeedback,
  getHandoffNoteFromReview,
  REVIEW_REDO_CAP_DEFAULT,
  buildReviewPrompt,
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

  it('accept: notesForNextTask is stamped onto the contract for Phase 2 dispatch (Codex P2)', () => {
    // Codex P2 on PR #213: the prompt advertises notesForNextTask as
    // carry-forward, but the review chit closes immediately on
    // verdict-application + no consumer reads closed reviews. The
    // note must persist somewhere the next-task dispatch can read.
    // Fix: stamp onto contract.handoffNotesFromReview keyed by source
    // task. Phase 2 reads via getHandoffNoteFromReview.
    const note = 'next step: re-read the auth decision from step 2';
    const { taskId, contractId, reviewId } = setupVerdict({
      verdict: 'accept',
      notesForNextTask: note,
    });
    applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    const carried = getHandoffNoteFromReview(corpRoot, contractId, taskId);
    expect(carried).not.toBeNull();
    expect(carried?.note).toBe(note);
    expect(carried?.reviewerSlug).toBe('coder');
    expect(carried?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accept: omitted notesForNextTask does NOT touch contract', () => {
    const { contractId, reviewId } = setupVerdict({ verdict: 'accept' });
    applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    // Contract still has no handoffNotesFromReview field set.
    const contractHit = findChitById(corpRoot, contractId);
    const fields = contractHit!.chit.fields.contract as { handoffNotesFromReview?: unknown };
    expect(fields.handoffNotesFromReview).toBeUndefined();
  });

  it('accept: re-application on the same task replaces the prior note (one per source task)', () => {
    const firstNote = 'first review said: cache invalidation matters';
    const secondNote = 'second review (after redo) said: actually, batch by tenant';
    const { taskId, contractId, reviewId: firstReviewId } = setupVerdict({
      verdict: 'accept',
      notesForNextTask: firstNote,
    });
    applyReviewVerdict(corpRoot, { reviewChitId: firstReviewId, founderMemberId: 'mark' });

    // Now create a second review chit pointing at the same task +
    // contract (simulates a re-review after a redo cycle would have
    // resolved). Force the task back to under_review so the apply
    // pre-check accepts.
    const taskHit = findChitById(corpRoot, taskId);
    const taskScope = chitScopeFromPath(corpRoot, taskHit!.path);
    updateChit(corpRoot, taskScope, 'task', taskId, {
      updatedBy: 'test',
      fields: {
        task: {
          ...(taskHit!.chit.fields.task as TaskFields),
          workflowStatus: 'under_review',
        },
      } as never,
    });
    const second = createChit(corpRoot, {
      type: 'review',
      scope: 'agent:coder',
      createdBy: 'coder',
      fields: {
        review: {
          verdict: 'accept',
          reasoning: 'second pass',
          taskId,
          contractId,
          reviewerSlug: 'coder',
          notesForNextTask: secondNote,
        } as ReviewFields,
      } as never,
    });
    applyReviewVerdict(corpRoot, { reviewChitId: second.id, founderMemberId: 'mark' });

    // Only the second note survives — replace-by-fromTaskId.
    const carried = getHandoffNoteFromReview(corpRoot, contractId, taskId);
    expect(carried?.note).toBe(secondNote);

    // The contract array still has exactly one entry for this task.
    const contractHit = findChitById(corpRoot, contractId);
    const notes = (contractHit!.chit.fields.contract as {
      handoffNotesFromReview?: ReadonlyArray<{ fromTaskId: string }>;
    }).handoffNotesFromReview ?? [];
    const forTask = notes.filter((n) => n.fromTaskId === taskId);
    expect(forTask).toHaveLength(1);
  });

  it('getHandoffNoteFromReview: returns null when no note exists for the task', () => {
    const { taskId, contractId } = setupVerdict({ verdict: 'accept' });
    // No applyReviewVerdict call — note never stamped.
    expect(getHandoffNoteFromReview(corpRoot, contractId, taskId)).toBeNull();
  });

  it('getHandoffNoteFromReview: returns null for missing contract', () => {
    expect(getHandoffNoteFromReview(corpRoot, 'chit-c-deadbeef', 'chit-t-x')).toBeNull();
  });

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

  // ── Codex P2: pendingRedoFeedback survives review-chit closure ──

  it('redo: stamps redoFeedback onto task.pendingRedoFeedback so redispatch can read it (Codex P2)', () => {
    // Before the fix, the redoFeedback lived only on the review chit
    // which closed immediately on verdict-application; the future
    // redispatch path would have found null via findActiveReviewForTask
    // and booted the same Task without the specific feedback. Now the
    // feedback lives on the Task itself — survives chit closure +
    // status-filtering.
    const feedback = 'step 3 missed the cache-invalidation decision from step 1';
    const { taskId, reviewId } = setupVerdict({ verdict: 'redo', redoFeedback: feedback });
    applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    const taskHit = findChitById(corpRoot, taskId);
    const taskFields = taskHit!.chit.fields.task as TaskFields;
    expect(taskFields.pendingRedoFeedback).toBe(feedback);
  });

  it('consumePendingRedoFeedback: returns the string and clears the field', () => {
    const feedback = 'rework the assertion ordering';
    const { taskId, reviewId } = setupVerdict({
      verdict: 'redo',
      redoFeedback: feedback,
    });
    applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    // First consume reads the feedback.
    const first = consumePendingRedoFeedback(corpRoot, taskId, 'coder');
    expect(first).toBe(feedback);

    // Field is cleared.
    const taskHit = findChitById(corpRoot, taskId);
    const taskFields = taskHit!.chit.fields.task as TaskFields;
    expect(taskFields.pendingRedoFeedback).toBeNull();

    // Second consume returns null (already consumed).
    const second = consumePendingRedoFeedback(corpRoot, taskId, 'coder');
    expect(second).toBeNull();
  });

  it('consumePendingRedoFeedback: returns null when no feedback pending', () => {
    const { taskId } = setupVerdict({ verdict: 'accept' });
    expect(consumePendingRedoFeedback(corpRoot, taskId, 'coder')).toBeNull();
  });

  it('consumePendingRedoFeedback: returns null for missing task chit', () => {
    expect(consumePendingRedoFeedback(corpRoot, 'chit-t-deadbeef', 'coder')).toBeNull();
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

  it('flag inbox subject embeds a reasoning preview so `cc-cli inbox list` shows the WHY', () => {
    // Body fix from the prior commit shows reasoning on chit-read.
    // This further surfaces a short preview in the subject — the only
    // field rendered in `cc-cli inbox list` output. Founder sees the
    // WHY at the list level without opening the chit.
    const reasoning = 'step 4 contradicts step 2 decision';
    const { reviewId } = setupVerdict({ verdict: 'flag', reasoning });
    const result = applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    const inboxHit = findChitById(corpRoot, result.inboxItemId!);
    const fields = inboxHit!.chit.fields['inbox-item'] as { subject: string };
    expect(fields.subject).toContain(reasoning);
  });

  it('flag inbox subject truncates long reasoning with ellipsis', () => {
    const reasoning = 'a'.repeat(200);
    const { reviewId } = setupVerdict({ verdict: 'flag', reasoning });
    const result = applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    const inboxHit = findChitById(corpRoot, result.inboxItemId!);
    const fields = inboxHit!.chit.fields['inbox-item'] as { subject: string };
    expect(fields.subject).toMatch(/…$/);
    // Subject stays inside the 200-char hard cap (.slice(0, 200) wrapper).
    expect(fields.subject.length).toBeLessThanOrEqual(200);
  });

  it('flag inbox body surfaces the review reasoning (Codex P2)', () => {
    const reasoning = 'step 4 contradicts step 2 cache-invalidation decision';
    const { reviewId } = setupVerdict({ verdict: 'flag', reasoning });
    const result = applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    expect(result.applied).toBe(true);
    const inboxHit = findChitById(corpRoot, result.inboxItemId!);
    // The inbox-item's body carries the reasoning + the verdict
    // context so the founder doesn't have to chase the review chit.
    expect(inboxHit?.body).toContain(reasoning);
    expect(inboxHit?.body).toContain('flag');
    expect(inboxHit?.body).toContain(result.reviewChitId);
  });

  it('cap-downgrade inbox body surfaces both reasoning AND redoFeedback (Codex P2)', () => {
    const reasoning = 'review judged: needs different approach';
    const redoFeedback = 'step 2 should be rewritten from scratch with X';
    const { reviewId } = setupVerdict({
      verdict: 'redo',
      reasoning,
      redoFeedback,
      initialRedoCount: REVIEW_REDO_CAP_DEFAULT,
    });
    const result = applyReviewVerdict(corpRoot, { reviewChitId: reviewId, founderMemberId: 'mark' });

    expect(result.capDowngrade).toBe(true);
    const inboxHit = findChitById(corpRoot, result.inboxItemId!);
    expect(inboxHit?.body).toContain(reasoning);
    expect(inboxHit?.body).toContain(redoFeedback);
    // Body names the auto-downgrade explicitly so the founder sees
    // this wasn't a fresh flag — it was a redo the system gave up on.
    expect(inboxHit?.body).toMatch(/auto-downgraded|cap/i);
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

describe('buildReviewPrompt — section structure + key content', () => {
  function fakeTask(overrides: Partial<TaskFields> = {}): Chit<'task'> {
    return {
      id: 'chit-t-test',
      type: 'task',
      status: 'active',
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
      createdBy: 'coder',
      tags: [],
      fields: {
        task: {
          title: 'do the thing',
          priority: 'normal',
          workflowStatus: 'under_review',
          acceptanceCriteria: ['criterion A', 'criterion B'],
          output: 'completed the thing as specified; tested A; tested B',
          ...overrides,
        } as TaskFields,
      },
    } as Chit<'task'>;
  }

  function fakeContract(): Chit<'contract'> {
    return {
      id: 'chit-c-test',
      type: 'contract',
      status: 'active',
      createdAt: '2026-05-01T09:00:00.000Z',
      updatedAt: '2026-05-01T09:00:00.000Z',
      createdBy: 'mark',
      tags: [],
      fields: {
        contract: {
          title: 'demo contract title',
          goal: 'demo contract goal',
          taskIds: ['chit-t-test'],
          priority: 'normal',
        },
      },
    } as Chit<'contract'>;
  }

  it('includes the three verdicts + redo cap status + contract goal + task output', () => {
    const prompt = buildReviewPrompt({
      agentDisplayName: 'Coder',
      reviewerSlug: 'coder',
      task: fakeTask(),
      contract: fakeContract(),
      priorTaskOutputs: [],
      walkPosition: null,
      redoCap: 1,
      currentRedoCount: 0,
    });

    // Mode declaration.
    expect(prompt).toContain('REVIEW session');
    expect(prompt).toContain('Coder');

    // All three verdicts named.
    expect(prompt).toContain('**accept**');
    expect(prompt).toContain('**redo**');
    expect(prompt).toContain('**flag**');

    // Redo cap state — count + cap surfaced.
    expect(prompt).toContain('Redo count for this Task: 0 of 1');

    // Contract section.
    expect(prompt).toContain('demo contract goal');
    expect(prompt).toContain('demo contract title');

    // Task section.
    expect(prompt).toContain('do the thing');
    expect(prompt).toContain('completed the thing as specified');
    expect(prompt).toContain('criterion A');
    expect(prompt).toContain('criterion B');

    // CLI command examples — each verdict gets its own command.
    expect(prompt).toContain('--field verdict=accept');
    expect(prompt).toContain('--field verdict=redo');
    expect(prompt).toContain('--field verdict=flag');
    expect(prompt).toContain('--field redoFeedback="<REQUIRED');
  });

  it('changes wording when the redo cap is already hit (cap state messaging)', () => {
    const prompt = buildReviewPrompt({
      agentDisplayName: 'Coder',
      reviewerSlug: 'coder',
      task: fakeTask({ reviewRedoCount: 1 }),
      contract: fakeContract(),
      priorTaskOutputs: [],
      walkPosition: null,
      redoCap: 1,
      currentRedoCount: 1,
    });

    // Wording explicitly tells the reviewer redo is mechanically flag.
    expect(prompt).toContain('auto-promoted to **flag**');
    expect(prompt).toContain('accept vs flag');
  });

  it('renders prior task outputs when present', () => {
    const prompt = buildReviewPrompt({
      agentDisplayName: 'Coder',
      reviewerSlug: 'coder',
      task: fakeTask(),
      contract: fakeContract(),
      priorTaskOutputs: [
        {
          stepId: 'step-1',
          taskId: 'chit-t-prior1',
          taskTitle: 'first step',
          output: 'first step did X with decision: cache invalidation goes via Y',
        },
      ],
      walkPosition: null,
      redoCap: 1,
      currentRedoCount: 0,
    });

    expect(prompt).toContain('first step did X');
    expect(prompt).toContain('cache invalidation goes via Y');
    expect(prompt).toContain('step-1');
    expect(prompt).toContain('chit-t-prior1');
  });

  it('flags empty task.output as signal in its own right', () => {
    const prompt = buildReviewPrompt({
      agentDisplayName: 'Coder',
      reviewerSlug: 'coder',
      task: fakeTask({ output: undefined }),
      contract: fakeContract(),
      priorTaskOutputs: [],
      walkPosition: null,
      redoCap: 1,
      currentRedoCount: 0,
    });

    // The "empty output is itself signal" framing — coherence often
    // starts with skipping the externalization step.
    expect(prompt).toMatch(/empty.*signal|skipping the externalization/i);
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

  it('finds the per-task review even when 50+ active reviews exist (Codex P2 limit fix)', () => {
    // queryChits defaults to limit: 50. Before the fix, this helper
    // ran in-memory filtering on the limited result, so a corp with
    // 50+ active review chits could silently drop the per-task hit
    // for a task that DOES have a pending verdict. limit: 0 in the
    // query covers the corpus exhaustively.
    const targetTaskId = 'chit-t-target';
    // Create 60 noise reviews on unrelated tasks first — these
    // populate the limit window before the target.
    for (let i = 0; i < 60; i++) {
      createChit(corpRoot, {
        type: 'review',
        scope: 'agent:coder',
        createdBy: 'coder',
        fields: {
          review: {
            verdict: 'accept',
            reasoning: `noise ${i}`,
            taskId: `chit-t-noise${i}`,
            contractId: 'chit-c-noise',
            reviewerSlug: 'coder',
          } as ReviewFields,
        } as never,
      });
    }
    // Now create the target review.
    const target = createChit(corpRoot, {
      type: 'review',
      scope: 'agent:coder',
      createdBy: 'coder',
      fields: {
        review: {
          verdict: 'redo',
          reasoning: 'specific gap',
          taskId: targetTaskId,
          contractId: 'chit-c-test',
          reviewerSlug: 'coder',
          redoFeedback: 'concrete fix',
        } as ReviewFields,
      } as never,
    });

    const found = findActiveReviewForTask(corpRoot, targetTaskId);
    expect(found?.id).toBe(target.id);
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
