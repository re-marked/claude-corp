import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  closeChit,
  updateChit,
  isReady,
  analyzeReadiness,
  nextReadyTask,
  advanceChain,
} from '../packages/shared/src/index.js';

/**
 * Integration tests for the 1.3 chain walker primitives. Every test
 * creates real chits in a tmpdir corp via createChit so the walker
 * exercises the actual filesystem read path it uses in production.
 *
 * Coverage:
 *   - isReady / analyzeReadiness: no-deps, all-satisfied, blocked-by-
 *     running, blocked-by-failed, dep-missing.
 *   - nextReadyTask: ordered walk through contract.taskIds, skip
 *     terminal / unready, return null when exhausted, `after` cursor.
 *   - advanceChain: success cascade (unblock deltas), failure cascade
 *     (block deltas), partial satisfaction (no delta when other deps
 *     still running).
 */

describe('chain walker', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chain-test-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  // ─── isReady / analyzeReadiness ───────────────────────────────────

  describe('isReady + analyzeReadiness', () => {
    it('chit with no deps is ready (no-deps reason)', () => {
      const t = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 'solo', priority: 'normal' } },
        createdBy: 'ceo',
      });
      expect(isReady(corpRoot, t)).toBe(true);
      expect(analyzeReadiness(corpRoot, t).reason).toBe('no-deps');
    });

    it('chit blocked by a running dep returns blocked-by-running + the dep id', () => {
      const dep = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 'dep', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo',
        status: 'active',
      });
      const child = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 'child', priority: 'normal' } },
        createdBy: 'ceo',
        dependsOn: [dep.id],
      });

      const result = analyzeReadiness(corpRoot, child);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('blocked-by-running');
      expect(result.blockingDeps).toEqual([dep.id]);
    });

    it('chit becomes ready once every dep reaches terminal-success', () => {
      const dep = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 'dep', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo',
        status: 'active',
      });
      const child = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 'child', priority: 'normal' } },
        createdBy: 'ceo',
        dependsOn: [dep.id],
      });
      // Flip dep to terminal-success (workflowStatus=completed + chit.status=completed).
      updateChit(corpRoot, 'corp', 'task', dep.id, {
        status: 'completed',
        fields: { task: { workflowStatus: 'completed' } } as never,
        updatedBy: 'ceo',
      });
      expect(isReady(corpRoot, child)).toBe(true);
      expect(analyzeReadiness(corpRoot, child).reason).toBe('all-satisfied');
    });

    it('terminal-failure dep surfaces as blocked-by-failed', () => {
      const dep = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 'dep', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo',
        status: 'active',
      });
      const child = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 'child', priority: 'normal' } },
        createdBy: 'ceo',
        dependsOn: [dep.id],
      });
      updateChit(corpRoot, 'corp', 'task', dep.id, {
        status: 'failed',
        fields: { task: { workflowStatus: 'failed' } } as never,
        updatedBy: 'ceo',
      });
      const result = analyzeReadiness(corpRoot, child);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('blocked-by-failed');
      expect(result.failedDeps).toEqual([dep.id]);
    });

    it('missing dep id surfaces as dep-missing (no silent pass)', () => {
      const child = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 'child', priority: 'normal' } },
        createdBy: 'ceo',
        // Legacy word-pair id that passes id-format validation but
        // doesn't resolve to an actual chit — simulates a stale ref.
        dependsOn: ['phantom-dep'],
      });
      const result = analyzeReadiness(corpRoot, child);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('dep-missing');
      expect(result.missingDeps).toEqual(['phantom-dep']);
    });

    it('mixed satisfaction: one completed + one running → blocked-by-running', () => {
      const done = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'done', priority: 'normal', workflowStatus: 'completed' } },
        createdBy: 'ceo', status: 'completed',
      });
      const running = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'running', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo', status: 'active',
      });
      const child = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'child', priority: 'normal' } },
        createdBy: 'ceo',
        dependsOn: [done.id, running.id],
      });
      const result = analyzeReadiness(corpRoot, child);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('blocked-by-running');
      expect(result.blockingDeps).toEqual([running.id]);
    });
  });

  // ─── nextReadyTask ────────────────────────────────────────────────

  describe('nextReadyTask', () => {
    function setupContract(taskSpecs: Array<{ title: string; workflowStatus?: string; chitStatus?: string; deps?: string[] }>) {
      const tasks = taskSpecs.map((s) => {
        // Only include workflowStatus when explicitly set — js-yaml
        // rejects undefined values in the dump path, so absent fields
        // must be truly absent from the object, not `{ key: undefined }`.
        const taskFields: Record<string, unknown> = { title: s.title, priority: 'normal' };
        if (s.workflowStatus !== undefined) taskFields.workflowStatus = s.workflowStatus;
        return createChit(corpRoot, {
          type: 'task',
          scope: 'corp',
          fields: { task: taskFields } as never,
          createdBy: 'ceo',
          status: (s.chitStatus ?? 'draft') as never,
          dependsOn: s.deps ?? [],
        });
      });
      const contract = createChit(corpRoot, {
        type: 'contract',
        scope: 'corp',
        fields: { contract: { title: 'test-contract', goal: 'test', taskIds: tasks.map((t) => t.id), leadId: 'ceo' } },
        createdBy: 'ceo',
      });
      return { contract, tasks };
    }

    it('returns the first non-terminal + ready task in taskIds order', () => {
      const { contract, tasks } = setupContract([
        { title: 'done-one', workflowStatus: 'completed', chitStatus: 'completed' },
        { title: 'running', workflowStatus: 'in_progress', chitStatus: 'active' },
        { title: 'waiting', workflowStatus: 'draft' },
      ]);
      const next = nextReadyTask(corpRoot, contract.id);
      expect(next?.id).toBe(tasks[1]!.id);
    });

    it('returns null when every task is terminal', () => {
      const { contract } = setupContract([
        { title: 'a', workflowStatus: 'completed', chitStatus: 'completed' },
        { title: 'b', workflowStatus: 'failed', chitStatus: 'failed' },
      ]);
      expect(nextReadyTask(corpRoot, contract.id)).toBeNull();
    });

    it('skips past the `after` cursor', () => {
      const { contract, tasks } = setupContract([
        { title: 'a' },
        { title: 'b' },
        { title: 'c' },
      ]);
      const next = nextReadyTask(corpRoot, contract.id, tasks[0]!.id);
      expect(next?.id).toBe(tasks[1]!.id);
    });

    it('returns null when remaining tasks are unready', () => {
      const blocker = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'blocker', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo', status: 'active',
      });
      const { contract } = setupContract([
        { title: 'done', workflowStatus: 'completed', chitStatus: 'completed' },
        { title: 'waiting', deps: [blocker.id] },
      ]);
      expect(nextReadyTask(corpRoot, contract.id)).toBeNull();
    });
  });

  // ─── advanceChain ─────────────────────────────────────────────────

  describe('advanceChain', () => {
    it('on success close, emits unblock delta for dependents that were blocked', () => {
      const dep = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'dep', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo', status: 'active',
      });
      const child = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'child', priority: 'normal', workflowStatus: 'blocked' } },
        createdBy: 'ceo', status: 'active',
        dependsOn: [dep.id],
      });
      // Close dep as completed.
      updateChit(corpRoot, 'corp', 'task', dep.id, {
        status: 'completed',
        fields: { task: { workflowStatus: 'completed' } } as never,
        updatedBy: 'ceo',
      });

      const result = advanceChain(corpRoot, dep.id);
      expect(result.closedClassification).toBe('success');
      expect(result.dependentDeltas).toHaveLength(1);
      expect(result.dependentDeltas[0]).toMatchObject({
        chitId: child.id,
        trigger: 'unblock',
        reason: 'all-satisfied',
      });
    });

    it('role-queued blocked dependent gets unblock-to-queue (Codex P1 round 5 PR #204)', () => {
      // Pre-fix: unblocking a role-queued dependent always fired
      // `unblock` → in_progress, leaving the task with assignee=role-id
      // and workflowStatus=in_progress. Bacteria's queue scanner
      // (filters queued|dispatched + assignee===role) ignored it,
      // and no slot existed yet to redispatch into — permanent orphan.
      // Now: chain walker checks if assignee resolves via isKnownRole
      // and emits the unblock-to-queue trigger that targets `queued`,
      // putting the task back where bacteria can pick it up.
      const dep = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'dep', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo', status: 'active',
      });
      const child = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: {
          task: {
            title: 'role-queued child',
            priority: 'normal',
            workflowStatus: 'blocked',
            assignee: 'backend-engineer', // role-id, not a slot slug
          },
        },
        createdBy: 'ceo', status: 'active',
        dependsOn: [dep.id],
      });
      updateChit(corpRoot, 'corp', 'task', dep.id, {
        status: 'completed',
        fields: { task: { workflowStatus: 'completed' } } as never,
        updatedBy: 'ceo',
      });

      const result = advanceChain(corpRoot, dep.id);
      expect(result.closedClassification).toBe('success');
      expect(result.dependentDeltas).toHaveLength(1);
      expect(result.dependentDeltas[0]).toMatchObject({
        chitId: child.id,
        trigger: 'unblock-to-queue',
        reason: 'all-satisfied',
      });
    });

    it('on failure close, cascades block delta to non-blocked dependents', () => {
      const dep = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'dep', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo', status: 'active',
      });
      const child = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'child', priority: 'normal', workflowStatus: 'queued' } },
        createdBy: 'ceo', status: 'draft',
        dependsOn: [dep.id],
      });
      updateChit(corpRoot, 'corp', 'task', dep.id, {
        status: 'failed',
        fields: { task: { workflowStatus: 'failed' } } as never,
        updatedBy: 'ceo',
      });

      const result = advanceChain(corpRoot, dep.id);
      expect(result.closedClassification).toBe('failure');
      expect(result.dependentDeltas).toHaveLength(1);
      expect(result.dependentDeltas[0]).toMatchObject({
        chitId: child.id,
        trigger: 'block',
        reason: 'blocked-by-failed',
      });
    });

    it('does not unblock a dependent that still has OTHER pending deps', () => {
      const depA = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'depA', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo', status: 'active',
      });
      const depB = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'depB', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo', status: 'active',
      });
      createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'child', priority: 'normal', workflowStatus: 'blocked' } },
        createdBy: 'ceo', status: 'active',
        dependsOn: [depA.id, depB.id],
      });
      // Close only depA.
      updateChit(corpRoot, 'corp', 'task', depA.id, {
        status: 'completed',
        fields: { task: { workflowStatus: 'completed' } } as never,
        updatedBy: 'ceo',
      });

      const result = advanceChain(corpRoot, depA.id);
      // No unblock emitted — depB is still running.
      expect(result.dependentDeltas).toHaveLength(0);
    });

    it('on close of a non-terminal chit, returns no deltas (idempotent double-fire safety)', () => {
      const t = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 't', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo', status: 'active',
      });
      const result = advanceChain(corpRoot, t.id);
      expect(result.closedClassification).toBe('running');
      expect(result.dependentDeltas).toEqual([]);
    });

    it('chain of 3: closing root cascades in one step only (next step lights up on its own close)', () => {
      const root = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'root', priority: 'normal', workflowStatus: 'in_progress' } },
        createdBy: 'ceo', status: 'active',
      });
      const mid = createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'mid', priority: 'normal', workflowStatus: 'blocked' } },
        createdBy: 'ceo', status: 'active',
        dependsOn: [root.id],
      });
      createChit(corpRoot, {
        type: 'task', scope: 'corp',
        fields: { task: { title: 'tail', priority: 'normal', workflowStatus: 'blocked' } },
        createdBy: 'ceo', status: 'active',
        dependsOn: [mid.id],
      });

      updateChit(corpRoot, 'corp', 'task', root.id, {
        status: 'completed',
        fields: { task: { workflowStatus: 'completed' } } as never,
        updatedBy: 'ceo',
      });

      // Close root → only mid should receive an unblock; tail stays
      // blocked until mid itself closes. Walker does NOT transitively
      // cascade — each close is its own event.
      const rootResult = advanceChain(corpRoot, root.id);
      expect(rootResult.dependentDeltas).toHaveLength(1);
      expect(rootResult.dependentDeltas[0]!.chitId).toBe(mid.id);
    });
  });
});
