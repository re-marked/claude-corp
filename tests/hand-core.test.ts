import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handChitToSlot,
  HandNotAllowedError,
  TaskTransitionError,
  createChit,
  createCasketIfMissing,
  getCurrentStep,
  queryChits,
  findChitById,
  type TaskFields,
} from '../packages/shared/src/index.js';

/**
 * End-of-PR coverage for handChitToSlot — the shared mechanics all
 * three 1.4 hand callers use (cmdHand, crons, TUI /hand). Exercises
 * state machine transitions, idempotency, type eligibility, inbox
 * emission, and announceTier override.
 *
 * Integration style: real tmpdir corp + real chit writes + real
 * Casket + real inbox-item. No mocks — regressions in any of the
 * shared primitives the helper composes surface here.
 */

describe('handChitToSlot', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'hand-core-test-'));
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
    createCasketIfMissing(corpRoot, 'toast', 'founder');
  });
  afterEach(() => rmSync(corpRoot, { recursive: true, force: true }));

  function makeDraftTask(extra: Partial<TaskFields> = {}): string {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'sample', priority: 'normal', workflowStatus: 'draft', ...extra } as TaskFields } as never,
      createdBy: 'founder',
      status: 'draft',
    });
    return task.id;
  }

  // ─── Happy path transitions ──────────────────────────────────────

  it('draft task: two-phase transition → dispatched; Casket written; inbox fires', () => {
    const taskId = makeDraftTask();
    const result = handChitToSlot({
      corpRoot,
      targetSlug: 'toast',
      chitId: taskId,
      handerId: 'founder',
      reason: 'first hand',
    });

    expect(result.finalWorkflowStatus).toBe('dispatched');
    expect(result.announced).toBe(true);
    expect(result.errors).toEqual([]);

    // Casket points at the handed task.
    expect(getCurrentStep(corpRoot, 'toast')).toBe(taskId);

    // Task chit carries the assignee + handedBy + handedAt stamp.
    const hit = findChitById(corpRoot, taskId)!;
    const fields = hit.chit.fields.task as TaskFields;
    expect(fields.workflowStatus).toBe('dispatched');
    expect(fields.assignee).toBe('toast');
    expect(fields.handedBy).toBe('founder');
    expect(typeof fields.handedAt).toBe('string');

    // Codex P1 on PR #204: hand promotes top-level chit status
    // draft → active so bacteria's queue scanner (filters
    // statuses: ['active']) can see handed work. Without this, a
    // handed-but-still-draft chit was invisible to auto-scaling
    // and queues stalled.
    expect(hit.chit.status).toBe('active');

    // Tier 2 inbox-item landed on the target.
    const { chits: inbox } = queryChits(corpRoot, {
      types: ['inbox-item'],
      scopes: [`agent:toast` as const],
    });
    expect(inbox.length).toBeGreaterThanOrEqual(1);
  });

  it('queued task (assignee already set, not yet dispatched): one-phase transition to dispatched', () => {
    const taskId = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal', workflowStatus: 'queued', assignee: 'toast' } } as never,
      createdBy: 'founder',
      status: 'draft',
    }).id;
    const result = handChitToSlot({
      corpRoot,
      targetSlug: 'toast',
      chitId: taskId,
      handerId: 'founder',
    });
    expect(result.finalWorkflowStatus).toBe('dispatched');
  });

  it('dispatched task: idempotent re-hand re-stamps audit but workflowStatus stays', () => {
    const taskId = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal', workflowStatus: 'dispatched', assignee: 'toast', handedBy: 'prior-hander', handedAt: '2026-04-01T00:00:00.000Z' } } as never,
      createdBy: 'founder',
      status: 'draft',
    }).id;
    const result = handChitToSlot({
      corpRoot,
      targetSlug: 'toast',
      chitId: taskId,
      handerId: 'founder',
    });
    expect(result.finalWorkflowStatus).toBe('dispatched');

    const hit = findChitById(corpRoot, taskId)!;
    const fields = hit.chit.fields.task as TaskFields;
    // handedBy + handedAt REFRESHED on re-hand.
    expect(fields.handedBy).toBe('founder');
    expect(fields.handedAt).not.toBe('2026-04-01T00:00:00.000Z');
  });

  // ─── Rejections ──────────────────────────────────────────────────

  it('throws HandNotAllowedError on non-existent chit', () => {
    expect(() =>
      handChitToSlot({
        corpRoot,
        targetSlug: 'toast',
        chitId: 'chit-t-phantom',
        handerId: 'founder',
      }),
    ).toThrow(HandNotAllowedError);
  });

  it('throws HandNotAllowedError on non-hand-eligible chit type (observation)', () => {
    const obs = createChit(corpRoot, {
      type: 'observation',
      scope: 'corp',
      fields: { observation: { category: 'NOTICE', subject: 'x', importance: 3 } },
      createdBy: 'founder',
    });
    expect(() =>
      handChitToSlot({
        corpRoot,
        targetSlug: 'toast',
        chitId: obs.id,
        handerId: 'founder',
      }),
    ).toThrow(HandNotAllowedError);
  });

  it('throws TaskTransitionError when task is in_progress (mid-work; can\'t re-hand)', () => {
    const taskId = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal', workflowStatus: 'in_progress', assignee: 'toast' } } as never,
      createdBy: 'founder',
      status: 'active',
    }).id;
    expect(() =>
      handChitToSlot({
        corpRoot,
        targetSlug: 'toast',
        chitId: taskId,
        handerId: 'founder',
      }),
    ).toThrow(TaskTransitionError);
  });

  it('P1: rejected transition does NOT leave Casket pointing at the un-handed chit', () => {
    // Regression for PR #168 review P1: Casket write was happening
    // before the state machine validation. A rejected transition
    // from in_progress / blocked / terminal would throw but leave
    // the target's Casket dirty, so next session boot would pick
    // up an undispatched task.
    const taskId = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal', workflowStatus: 'in_progress', assignee: 'toast' } } as never,
      createdBy: 'founder',
      status: 'active',
    }).id;

    // Pre-state: Casket is empty (createCasketIfMissing set currentStep=null in beforeEach).
    expect(getCurrentStep(corpRoot, 'toast')).toBeNull();

    expect(() =>
      handChitToSlot({
        corpRoot,
        targetSlug: 'toast',
        chitId: taskId,
        handerId: 'founder',
      }),
    ).toThrow(TaskTransitionError);

    // Critical invariant: Casket unchanged after the rejected hand.
    expect(getCurrentStep(corpRoot, 'toast')).toBeNull();
  });

  it('throws TaskTransitionError when task is in terminal state (completed)', () => {
    const taskId = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal', workflowStatus: 'completed' } } as never,
      createdBy: 'founder',
      status: 'completed',
    }).id;
    expect(() =>
      handChitToSlot({
        corpRoot,
        targetSlug: 'toast',
        chitId: taskId,
        handerId: 'founder',
      }),
    ).toThrow(TaskTransitionError);
  });

  // ─── Casket-write-before-transition ordering ─────────────────────

  it('Casket is written even when the task has no workflowStatus yet (pre-1.3 chit, legacy path)', () => {
    // Task chit without workflowStatus — treated as default 'draft'
    // by handChitToSlot, so the two-phase transition applies and the
    // chit ends at 'dispatched' with workflowStatus filled in.
    const taskId = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } } as never,
      createdBy: 'founder',
    }).id;
    const result = handChitToSlot({
      corpRoot,
      targetSlug: 'toast',
      chitId: taskId,
      handerId: 'founder',
    });
    expect(result.finalWorkflowStatus).toBe('dispatched');
    expect(getCurrentStep(corpRoot, 'toast')).toBe(taskId);
  });

  // ─── Announce control ────────────────────────────────────────────

  it('announce: false skips inbox emission; Casket + task still written', () => {
    const taskId = makeDraftTask();
    const result = handChitToSlot({
      corpRoot,
      targetSlug: 'toast',
      chitId: taskId,
      handerId: 'founder',
      announce: false,
    });
    expect(result.announced).toBe(false);
    expect(getCurrentStep(corpRoot, 'toast')).toBe(taskId);

    const { chits: inbox } = queryChits(corpRoot, {
      types: ['inbox-item'],
      scopes: [`agent:toast` as const],
    });
    expect(inbox).toHaveLength(0);
  });

  it('announceTier override lands at the requested tier', () => {
    const taskId = makeDraftTask();
    handChitToSlot({
      corpRoot,
      targetSlug: 'toast',
      chitId: taskId,
      handerId: 'founder',
      announce: true,
      announceTier: 3,
    });
    const { chits: inbox } = queryChits(corpRoot, {
      types: ['inbox-item'],
      scopes: [`agent:toast` as const],
    });
    expect(inbox).toHaveLength(1);
    const fields = inbox[0]!.chit.fields as { 'inbox-item'?: { tier?: number } };
    expect(fields['inbox-item']?.tier).toBe(3);
  });
});
