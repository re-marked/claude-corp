import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handChitToRoleQueue,
  HandNotAllowedError,
  createChit,
  findChitById,
  type TaskFields,
} from '../packages/shared/src/index.js';

/**
 * Coverage for handChitToRoleQueue — the bacteria-cold-start helper
 * (Project 1.10.1.1). Persists a task chit as queued for a role
 * pool when no Employee exists; bacteria's reactor sees it on next
 * tick and mitoses a slot.
 *
 * Integration style: real tmpdir corp, real chit writes. No mocks.
 */

describe('handChitToRoleQueue', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'hand-role-queue-'));
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      // Windows fs-handle races
    }
  });

  function makeTask(extra: Partial<TaskFields> = {}): string {
    const chit = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'founder',
      status: 'draft',
      fields: {
        task: {
          title: 'sample',
          priority: 'normal',
          workflowStatus: 'draft',
          ...extra,
        } as TaskFields,
      } as never,
    });
    return chit.id;
  }

  // ─── happy paths ─────────────────────────────────────────────────

  it('draft task → queued with assignee=role-id and audit stamps', () => {
    const taskId = makeTask();

    const result = handChitToRoleQueue({
      corpRoot,
      roleId: 'backend-engineer',
      chitId: taskId,
      handerId: 'mark',
      reason: 'first cold-start',
    });

    expect(result.finalWorkflowStatus).toBe('queued');

    const hit = findChitById(corpRoot, taskId);
    expect(hit).toBeTruthy();
    if (!hit || hit.chit.type !== 'task') throw new Error('narrowing');
    const fields = hit.chit.fields.task;
    expect(fields.assignee).toBe('backend-engineer');
    expect(fields.workflowStatus).toBe('queued');
    expect(fields.handedBy).toBe('mark');
    expect(fields.handedAt).toBeTruthy();
  });

  it('already-queued task is idempotent — re-stamps handedBy without state churn', () => {
    const taskId = makeTask({ workflowStatus: 'queued', assignee: 'backend-engineer' });

    const result = handChitToRoleQueue({
      corpRoot,
      roleId: 'backend-engineer',
      chitId: taskId,
      handerId: 'mark',
    });

    expect(result.finalWorkflowStatus).toBe('queued');
    const hit = findChitById(corpRoot, taskId);
    if (!hit || hit.chit.type !== 'task') throw new Error('narrowing');
    expect(hit.chit.fields.task.handedBy).toBe('mark');
  });

  // ─── rejected source states ──────────────────────────────────────

  it.each(['dispatched', 'in_progress', 'blocked', 'under_review', 'completed', 'rejected', 'failed', 'cancelled'])(
    'rejects task in workflowStatus=%s (cancel + recreate to reroute)',
    (ws) => {
      const taskId = makeTask({ workflowStatus: ws as TaskFields['workflowStatus'] });
      expect(() =>
        handChitToRoleQueue({
          corpRoot,
          roleId: 'backend-engineer',
          chitId: taskId,
          handerId: 'mark',
        }),
      ).toThrow(HandNotAllowedError);
    },
  );

  // ─── chit-type guards ────────────────────────────────────────────

  it('rejects non-task chit types', () => {
    const obs = createChit(corpRoot, {
      type: 'observation',
      scope: 'corp',
      createdBy: 'founder',
      fields: {
        observation: {
          category: 'NOTICE',
          subject: 'corp',
          importance: 1,
        },
      },
    });

    expect(() =>
      handChitToRoleQueue({
        corpRoot,
        roleId: 'backend-engineer',
        chitId: obs.id,
        handerId: 'mark',
      }),
    ).toThrow(HandNotAllowedError);
  });

  it('rejects unknown chit ids', () => {
    expect(() =>
      handChitToRoleQueue({
        corpRoot,
        roleId: 'backend-engineer',
        chitId: 'chit-t-deadbeef',
        handerId: 'mark',
      }),
    ).toThrow(HandNotAllowedError);
  });

  // ─── role-eligibility guard ──────────────────────────────────────

  it('rejects unknown roles (no silent stall)', () => {
    const taskId = makeTask();
    expect(() =>
      handChitToRoleQueue({
        corpRoot,
        roleId: 'zorblax-specialist',
        chitId: taskId,
        handerId: 'mark',
      }),
    ).toThrow(HandNotAllowedError);
  });

  it('rejects non-worker-tier roles — Partners aren\'t bacteria-eligible', () => {
    const taskId = makeTask();
    // 'ceo' is tier=decree (Partner). Queueing for it would silently
    // stall since bacteria only mitoses worker-tier pools.
    expect(() =>
      handChitToRoleQueue({
        corpRoot,
        roleId: 'ceo',
        chitId: taskId,
        handerId: 'mark',
      }),
    ).toThrow(HandNotAllowedError);
  });

  it('rejects role-lead tier roles', () => {
    const taskId = makeTask();
    // 'engineering-lead' is tier=role-lead. Same silent-stall risk.
    expect(() =>
      handChitToRoleQueue({
        corpRoot,
        roleId: 'engineering-lead',
        chitId: taskId,
        handerId: 'mark',
      }),
    ).toThrow(HandNotAllowedError);
  });
});
