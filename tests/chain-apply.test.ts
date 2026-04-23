import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  createCasketIfMissing,
  getCurrentStep,
  queryChits,
  advanceChain,
  applyDependentDelta,
  applyChainAdvance,
  findChitById,
  type DependentDelta,
  type Chit,
  type TaskFields,
} from '../packages/shared/src/index.js';

/**
 * End-of-PR regression tests for the 1.4 delta application layer.
 *
 *   applyDependentDelta — per-delta state machine transition
 *   applyChainAdvance   — full cascade (transition + Casket + inbox
 *                          for unblock, transition-only for block)
 *
 * All integration-style: real chits in tmpdir, real Casket writes,
 * real inbox chits created. No mocking.
 */

describe('applyDependentDelta — per-delta transition', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chain-apply-test-'));
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
  });
  afterEach(() => rmSync(corpRoot, { recursive: true, force: true }));

  it('unblock delta on a blocked task flips workflowStatus to in_progress', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal', workflowStatus: 'blocked' } },
      createdBy: 'founder',
      status: 'active',
    });
    const delta: DependentDelta = { chitId: task.id, trigger: 'unblock', reason: 'all-satisfied' };
    const result = applyDependentDelta({ corpRoot, delta, actor: 'system' });

    expect(result.applied).toBe(true);
    expect(result.fromState).toBe('blocked');
    expect(result.toState).toBe('in_progress');

    // Verify the write landed.
    const reread = findChitById(corpRoot, task.id)!;
    expect((reread.chit.fields.task as TaskFields).workflowStatus).toBe('in_progress');
  });

  it('block delta on a queued task flips workflowStatus to blocked', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal', workflowStatus: 'queued' } },
      createdBy: 'founder',
      status: 'draft',
    });
    const delta: DependentDelta = { chitId: task.id, trigger: 'block', reason: 'blocked-by-failed' };
    const result = applyDependentDelta({ corpRoot, delta, actor: 'system' });

    expect(result.applied).toBe(true);
    expect(result.toState).toBe('blocked');
  });

  it('skips chit-missing with actionable detail', () => {
    const delta: DependentDelta = { chitId: 'chit-t-phantom', trigger: 'unblock', reason: 'all-satisfied' };
    const result = applyDependentDelta({ corpRoot, delta, actor: 'system' });
    expect(result.applied).toBe(false);
    expect(result.skippedReason).toBe('chit-missing');
    expect(result.detail).toMatch(/not found/);
  });

  it('skips transition-rejected when applied idempotently', () => {
    // Task already in in_progress; unblock trigger isn't legal from there.
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal', workflowStatus: 'in_progress' } },
      createdBy: 'founder',
      status: 'active',
    });
    const delta: DependentDelta = { chitId: task.id, trigger: 'unblock', reason: 'all-satisfied' };
    const result = applyDependentDelta({ corpRoot, delta, actor: 'system' });
    expect(result.applied).toBe(false);
    expect(result.skippedReason).toBe('transition-rejected');
    expect(result.fromState).toBe('in_progress');
  });

  it('skips not-task when the delta target is a different chit type', () => {
    const obs = createChit(corpRoot, {
      type: 'observation',
      scope: 'corp',
      fields: { observation: { category: 'NOTICE', subject: 'x', importance: 3 } },
      createdBy: 'founder',
    });
    const delta: DependentDelta = { chitId: obs.id, trigger: 'unblock', reason: 'all-satisfied' };
    const result = applyDependentDelta({ corpRoot, delta, actor: 'system' });
    expect(result.applied).toBe(false);
    expect(result.skippedReason).toBe('not-task');
  });

  it('skips no-workflow-status for pre-1.3 task chits', () => {
    // Task chit WITHOUT fields.task.workflowStatus — simulates a
    // migration straggler.
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'founder',
    });
    const delta: DependentDelta = { chitId: task.id, trigger: 'unblock', reason: 'all-satisfied' };
    const result = applyDependentDelta({ corpRoot, delta, actor: 'system' });
    expect(result.applied).toBe(false);
    expect(result.skippedReason).toBe('no-workflow-status');
  });
});

describe('applyChainAdvance — transition + re-dispatch', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chain-advance-test-'));
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
  });
  afterEach(() => rmSync(corpRoot, { recursive: true, force: true }));

  /** Helper — full unblock scenario: closed dep + blocked child + child assignee. */
  function setupUnblockScenario(childAssignee: string | null) {
    createCasketIfMissing(corpRoot, 'agent-alpha', 'founder');
    const dep = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'dep', priority: 'normal', workflowStatus: 'completed' } },
      createdBy: 'founder',
      status: 'completed',
    });
    const fields: Record<string, unknown> = {
      title: 'child',
      priority: 'normal',
      workflowStatus: 'blocked',
    };
    if (childAssignee !== null) fields.assignee = childAssignee;
    const child = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: fields } as never,
      createdBy: 'founder',
      status: 'active',
      dependsOn: [dep.id],
    });
    return { dep, child };
  }

  it('unblock delta: transition applies AND Casket is written AND inbox fires', () => {
    const { dep, child } = setupUnblockScenario('agent-alpha');
    const advance = advanceChain(corpRoot, dep.id);
    const results = applyChainAdvance(corpRoot, advance, 'system');

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.transition.applied).toBe(true);
    expect(r.transition.toState).toBe('in_progress');
    expect(r.redispatch).toBeDefined();
    expect(r.redispatch!.targetSlug).toBe('agent-alpha');
    expect(r.redispatch!.casketWritten).toBe(true);
    expect(r.redispatch!.notified).toBe(true);

    // Confirm Casket.currentStep now points at the unblocked child.
    expect(getCurrentStep(corpRoot, 'agent-alpha')).toBe(child.id);

    // Confirm an inbox-item chit was created for the assignee.
    const { chits: inboxItems } = queryChits(corpRoot, {
      types: ['inbox-item'],
      scopes: [`agent:agent-alpha` as const],
    });
    expect(inboxItems.length).toBeGreaterThanOrEqual(1);
    const found = inboxItems.find((w) => {
      const fields = w.chit.fields as { 'inbox-item'?: { subject?: string } };
      return fields['inbox-item']?.subject?.includes('UNBLOCKED');
    });
    expect(found).toBeDefined();
  });

  it('unblock delta with no assignee on the task: transition applies but no Casket / no inbox', () => {
    const { dep } = setupUnblockScenario(null);
    const advance = advanceChain(corpRoot, dep.id);
    const results = applyChainAdvance(corpRoot, advance, 'system');

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.transition.applied).toBe(true);
    expect(r.redispatch!.targetSlug).toBeNull();
    expect(r.redispatch!.casketWritten).toBe(false);
    expect(r.redispatch!.notified).toBe(false);
  });

  it('block delta (failure cascade): transition-only, no redispatch object', () => {
    const dep = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'dep', priority: 'normal', workflowStatus: 'failed' } },
      createdBy: 'founder',
      status: 'failed',
    });
    const child = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'child', priority: 'normal', workflowStatus: 'queued', assignee: 'agent-alpha' } } as never,
      createdBy: 'founder',
      status: 'draft',
      dependsOn: [dep.id],
    });
    const advance = advanceChain(corpRoot, dep.id);
    const results = applyChainAdvance(corpRoot, advance, 'system');

    const r = results.find((x) => x.delta.chitId === child.id);
    expect(r).toBeDefined();
    expect(r!.transition.applied).toBe(true);
    expect(r!.transition.toState).toBe('blocked');
    // Block deltas don't get redispatch — agent finds out via wtf header.
    expect(r!.redispatch).toBeUndefined();
  });

  it('announce: false suppresses inbox but still writes Casket', () => {
    const { child } = setupUnblockScenario('agent-alpha');
    const advance = advanceChain(corpRoot, child.dependsOn[0]!);
    const results = applyChainAdvance(corpRoot, advance, 'system', { announce: false });

    const r = results[0]!;
    expect(r.redispatch!.casketWritten).toBe(true);
    expect(r.redispatch!.notified).toBe(false);

    // No UNBLOCKED inbox item should exist.
    const { chits: inboxItems } = queryChits(corpRoot, {
      types: ['inbox-item'],
      scopes: [`agent:agent-alpha` as const],
    });
    const announceItem = inboxItems.find((w) => {
      const f = w.chit.fields as { 'inbox-item'?: { subject?: string } };
      return f['inbox-item']?.subject?.includes('UNBLOCKED');
    });
    expect(announceItem).toBeUndefined();
  });

  it('idempotent re-fire on same close event produces no duplicate writes', () => {
    const { dep, child } = setupUnblockScenario('agent-alpha');
    const advance = advanceChain(corpRoot, dep.id);
    applyChainAdvance(corpRoot, advance, 'system'); // first application
    const secondResults = applyChainAdvance(corpRoot, advance, 'system'); // re-fire

    // Second application's transition is rejected (unblock not legal
    // from in_progress), so no duplicate Casket write / inbox.
    const r = secondResults[0]!;
    expect(r.transition.applied).toBe(false);
    expect(r.transition.skippedReason).toBe('transition-rejected');
    expect(r.redispatch).toBeUndefined();

    // Inbox count stable (no extra item on second fire).
    const { chits: inboxItems } = queryChits(corpRoot, {
      types: ['inbox-item'],
      scopes: [`agent:agent-alpha` as const],
    });
    const unblockItems = inboxItems.filter((w) => {
      const f = w.chit.fields as { 'inbox-item'?: { subject?: string } };
      return f['inbox-item']?.subject?.includes('UNBLOCKED');
    });
    expect(unblockItems).toHaveLength(1);
  });

  it('empty advance (no dependents) → empty results', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal', workflowStatus: 'completed' } },
      createdBy: 'founder',
      status: 'completed',
    });
    const advance = advanceChain(corpRoot, task.id);
    expect(advance.dependentDeltas).toHaveLength(0);
    const results = applyChainAdvance(corpRoot, advance, 'system');
    expect(results).toHaveLength(0);
  });
});
