import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  findChitById,
  promotePendingHandoff,
  createCasketIfMissing,
  advanceCurrentStep,
  type Member,
  type ContractFields,
  type TaskFields,
  type ClearanceSubmissionFields,
  MEMBERS_JSON,
  readClearinghouseLock,
  claimClearinghouseLock,
} from '../packages/shared/src/index.js';
import {
  enterClearance,
  isClearinghouseAwareCorp,
  PressmanScheduler,
  type GitOps,
  type RebaseOutcome,
  type PushOutcome,
  type DiffStats,
  type WorktreeEntry,
  ok,
  err,
  failure,
} from '../packages/daemon/src/clearinghouse/index.js';
import type { ProcessManager } from '../packages/daemon/src/process-manager.js';

/**
 * Coverage for Project 1.12 PR 3 — Pressman runtime + enterClearance
 * + audit-side deferTaskClose. Tests use mock GitOps to avoid real
 * git invocation, and real chit substrate for the cascade work.
 */

describe('Pressman runtime + enterClearance', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'pressman-'));
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      /* Windows */
    }
  });

  // ─── Test fixtures ──────────────────────────────────────────────

  function writeMembers(members: Member[]): void {
    writeFileSync(join(corpRoot, MEMBERS_JSON), JSON.stringify(members), 'utf-8');
  }

  function makePressman(): Member {
    return {
      id: 'pressman-aa',
      displayName: 'Pressman',
      rank: 'worker',
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: '',
      agentDir: 'agents/pressman-aa/',
      port: null,
      spawnedBy: null,
      createdAt: '2026-04-26T08:00:00.000Z',
      kind: 'employee',
      role: 'pressman',
    };
  }

  function makeContract(taskIds: string[]): string {
    const c = createChit<'contract'>(corpRoot, {
      type: 'contract',
      scope: 'corp',
      createdBy: 'mark',
      fields: {
        contract: {
          title: 'Test',
          goal: 'verify pressman',
          taskIds,
        },
      },
    });
    return c.id;
  }

  function makeTaskAtUnderReview(): string {
    const t = createChit<'task'>(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'mark',
      fields: {
        task: {
          title: 'Test task',
          priority: 'normal',
          workflowStatus: 'under_review',
        },
      },
    });
    return t.id;
  }

  function buildMockGitOps(scripts: Partial<GitOps> = {}): GitOps {
    const noop = async () => ok<void>(undefined);
    return {
      fetchOrigin: scripts.fetchOrigin ?? noop,
      worktreeAdd: scripts.worktreeAdd ?? noop,
      worktreeRemove: scripts.worktreeRemove ?? noop,
      worktreeList: scripts.worktreeList ?? (async () => ok<readonly WorktreeEntry[]>([])),
      rebase: scripts.rebase ?? (async () => ok({ state: 'clean' as const })),
      rebaseAbort: scripts.rebaseAbort ?? noop,
      rebaseContinue: scripts.rebaseContinue ?? (async () => ok({ state: 'clean' as const })),
      stageAll: scripts.stageAll ?? noop,
      push: scripts.push ?? (async () => ok({ state: 'pushed' as const })),
      currentSha: scripts.currentSha ?? (async () => ok('a'.repeat(40))),
      diffStats: scripts.diffStats ?? (async () => ok({ filesChanged: 1, insertions: 1, deletions: 0 })),
      listConflictedFiles: scripts.listConflictedFiles ?? (async () => ok([])),
      branchExists: scripts.branchExists ?? (async () => ok(true)),
      isClean: scripts.isClean ?? (async () => ok(true)),
      resetHard: scripts.resetHard ?? noop,
      cleanWorkdir: scripts.cleanWorkdir ?? noop,
    };
  }

  // ─── isClearinghouseAwareCorp ─────────────────────────────────

  describe('isClearinghouseAwareCorp', () => {
    it('false when no Pressman hired', () => {
      writeMembers([]);
      expect(isClearinghouseAwareCorp(corpRoot)).toBe(false);
    });

    it('false when members.json missing', () => {
      expect(isClearinghouseAwareCorp(corpRoot)).toBe(false);
    });

    it('true when at least one member has role=pressman', () => {
      writeMembers([makePressman()]);
      expect(isClearinghouseAwareCorp(corpRoot)).toBe(true);
    });

    it('false when only non-pressman members present', () => {
      writeMembers([
        { ...makePressman(), id: 'backend-aa', role: 'backend-engineer', displayName: 'Toast' },
      ]);
      expect(isClearinghouseAwareCorp(corpRoot)).toBe(false);
    });
  });

  // ─── enterClearance ──────────────────────────────────────────

  describe('enterClearance', () => {
    it('happy path: pushes, creates submission, advances task to clearance', async () => {
      writeMembers([makePressman()]);
      const taskId = makeTaskAtUnderReview();
      const contractId = makeContract([taskId]);

      const result = await enterClearance({
        corpRoot,
        taskId,
        contractId,
        branch: 'feat/x',
        submitter: 'backend-aa',
        worktreePath: corpRoot,
        gitOps: buildMockGitOps(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.submissionId).toMatch(/^chit-cs-/);
      expect(result.value.pushedSha).toMatch(/^[a-f0-9]{40}$/);

      // Task advanced to clearance.
      const taskAfter = findChitById(corpRoot, taskId);
      expect(taskAfter?.chit.fields.task.workflowStatus).toBe('clearance');

      // Submission has the right shape.
      const subAfter = findChitById(corpRoot, result.value.submissionId);
      expect(subAfter?.chit.type).toBe('clearance-submission');
      const subFields = subAfter?.chit.fields['clearance-submission'] as ClearanceSubmissionFields;
      expect(subFields.submissionStatus).toBe('queued');
      expect(subFields.reviewBypassed).toBe(true);
      expect(subFields.branch).toBe('feat/x');
      expect(subFields.taskId).toBe(taskId);
    });

    it('refuses when task is at wrong workflow status', async () => {
      // Task at completed — enterClearance should refuse.
      const t = createChit<'task'>(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          task: {
            title: 'Already done',
            priority: 'normal',
            workflowStatus: 'completed',
          },
        },
      });
      const contractId = makeContract([t.id]);

      const result = await enterClearance({
        corpRoot,
        taskId: t.id,
        contractId,
        branch: 'feat/x',
        submitter: 'backend-aa',
        worktreePath: corpRoot,
        gitOps: buildMockGitOps(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.pedagogicalSummary).toMatch(/expected 'under_review'/);
    });

    it('on push race: returns failure, no submission created, task stays at under_review', async () => {
      const taskId = makeTaskAtUnderReview();
      const contractId = makeContract([taskId]);

      const result = await enterClearance({
        corpRoot,
        taskId,
        contractId,
        branch: 'feat/x',
        submitter: 'backend-aa',
        worktreePath: corpRoot,
        gitOps: buildMockGitOps({
          push: async () => ok({ state: 'rejected-race' as const }),
        }),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.category).toBe('push-rejection-race');

      // Task workflow unchanged.
      const taskAfter = findChitById(corpRoot, taskId);
      expect(taskAfter?.chit.fields.task.workflowStatus).toBe('under_review');
    });

    it('on hook rejection: surfaces hook output in pedagogical summary', async () => {
      const taskId = makeTaskAtUnderReview();
      const contractId = makeContract([taskId]);

      const result = await enterClearance({
        corpRoot,
        taskId,
        contractId,
        branch: 'feat/x',
        submitter: 'backend-aa',
        worktreePath: corpRoot,
        gitOps: buildMockGitOps({
          push: async () => ok({ state: 'rejected-hook' as const, hookOutput: 'pre-receive: nope' }),
        }),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.category).toBe('push-rejection-hook');
      expect(result.failure.rawDetail).toContain('pre-receive: nope');
    });
  });

  // ─── handoff-promotion deferTaskClose ────────────────────────

  describe('promotePendingHandoff with deferTaskClose', () => {
    it('skips closing task when deferTaskClose=true; closedTaskId still surfaces', () => {
      // Set up agent + workspace + Casket + task.
      writeMembers([
        {
          id: 'backend-aa',
          displayName: 'Toast',
          rank: 'worker',
          status: 'active',
          type: 'agent',
          scope: 'corp',
          scopeId: '',
          agentDir: 'agents/backend-aa/',
          port: null,
          spawnedBy: null,
          createdAt: '2026-04-26T08:00:00.000Z',
          kind: 'employee',
          role: 'backend-engineer',
        },
      ]);
      const workspace = join(corpRoot, 'agents', 'backend-aa');
      mkdirSync(workspace, { recursive: true });

      // Task at under_review (the cc-cli done flow set it up this way).
      const taskId = makeTaskAtUnderReview();

      // Casket pointing at the task — must use deterministic id via
      // createCasketIfMissing so getCurrentStep can find it.
      createCasketIfMissing(corpRoot, 'backend-aa', 'mark');
      advanceCurrentStep(corpRoot, 'backend-aa', taskId, 'mark');

      // Pending handoff.
      writeFileSync(
        join(workspace, '.pending-handoff.json'),
        JSON.stringify({
          predecessorSession: 'sess-1',
          completed: ['ran tests'],
          nextAction: 'submit',
          openQuestion: null,
          sandboxState: null,
          notes: null,
          createdAt: '2026-04-26T10:00:00.000Z',
          createdBy: 'backend-aa',
        }),
        'utf-8',
      );

      const result = promotePendingHandoff(corpRoot, 'backend-aa', workspace, {
        deferTaskClose: true,
      });

      expect(result.promoted).toBe(true);
      expect(result.closedTaskId).toBe(taskId);
      // Task workflow status should NOT have advanced — defer means
      // enterClearance handles it next.
      const taskAfter = findChitById(corpRoot, taskId);
      expect(taskAfter?.chit.fields.task.workflowStatus).toBe('under_review');
      // Chain deltas should be empty (chain walks happen at merge time).
      expect(result.chainDeltas).toEqual([]);
    });

    it('without deferTaskClose, default behavior: task closes to completed', () => {
      writeMembers([
        {
          id: 'backend-aa',
          displayName: 'Toast',
          rank: 'worker',
          status: 'active',
          type: 'agent',
          scope: 'corp',
          scopeId: '',
          agentDir: 'agents/backend-aa/',
          port: null,
          spawnedBy: null,
          createdAt: '2026-04-26T08:00:00.000Z',
          kind: 'employee',
          role: 'backend-engineer',
        },
      ]);
      const workspace = join(corpRoot, 'agents', 'backend-aa');
      mkdirSync(workspace, { recursive: true });
      const taskId = makeTaskAtUnderReview();
      createCasketIfMissing(corpRoot, 'backend-aa', 'mark');
      advanceCurrentStep(corpRoot, 'backend-aa', taskId, 'mark');
      writeFileSync(
        join(workspace, '.pending-handoff.json'),
        JSON.stringify({
          predecessorSession: 'sess-1',
          completed: [],
          nextAction: 'next',
          openQuestion: null,
          sandboxState: null,
          notes: null,
          createdAt: '2026-04-26T10:00:00.000Z',
          createdBy: 'backend-aa',
        }),
        'utf-8',
      );

      const result = promotePendingHandoff(corpRoot, 'backend-aa', workspace);
      expect(result.promoted).toBe(true);
      // Default behavior — task closes to completed.
      const taskAfter = findChitById(corpRoot, taskId);
      expect(taskAfter?.chit.fields.task.workflowStatus).toBe('completed');
    });
  });

  // ─── PressmanScheduler ────────────────────────────────────────

  describe('PressmanScheduler', () => {
    function buildMockProcessManager(aliveSlugs: Set<string>): ProcessManager {
      return {
        getAgent: (slug: string) =>
          aliveSlugs.has(slug)
            ? { memberId: slug, displayName: slug, port: 0, status: 'ready', gatewayToken: '', process: null, mode: 'harness', model: '' }
            : undefined,
      } as unknown as ProcessManager;
    }

    function buildSubmission(opts: { branch: string; taskId: string; contractId: string }): string {
      const sub = createChit<'clearance-submission'>(corpRoot, {
        type: 'clearance-submission',
        scope: 'corp',
        createdBy: 'backend-aa',
        fields: {
          'clearance-submission': {
            branch: opts.branch,
            contractId: opts.contractId,
            taskId: opts.taskId,
            submitter: 'backend-aa',
            priority: 'normal',
            submittedAt: new Date().toISOString(),
            submissionStatus: 'queued',
            retryCount: 0,
            reviewRound: 0,
            reviewBypassed: true,
          },
        },
      });
      return sub.id;
    }

    it('tick is no-op when queue is empty', async () => {
      writeMembers([makePressman()]);
      const scheduler = new PressmanScheduler({
        corpRoot,
        processManager: buildMockProcessManager(new Set(['pressman-aa'])),
        gitOps: buildMockGitOps(),
      });
      await scheduler.tick();
      // Lock should still be free.
      expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();
    });

    it('tick is no-op when no Pressman is hired', async () => {
      writeMembers([]); // empty
      const taskId = makeTaskAtUnderReview();
      const contractId = makeContract([taskId]);
      buildSubmission({ branch: 'feat/x', taskId, contractId });
      const scheduler = new PressmanScheduler({
        corpRoot,
        processManager: buildMockProcessManager(new Set()),
        gitOps: buildMockGitOps(),
      });
      await scheduler.tick();
      expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();
    });

    it('happy path: claim → rebase clean → tests pass → merge → cascade', async () => {
      writeMembers([makePressman()]);
      // Task at clearance (set up by a prior enterClearance).
      const taskChit = createChit<'task'>(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          task: {
            title: 'Test',
            priority: 'normal',
            workflowStatus: 'clearance',
          },
        },
      });
      const contractId = makeContract([taskChit.id]);
      const submissionId = buildSubmission({ branch: 'feat/x', taskId: taskChit.id, contractId });

      // Pre-create the worktree dir so the test runner has a real
      // cwd to spawn into (mock GitOps's worktreeAdd is a no-op).
      mkdirSync(join(corpRoot, '.clearinghouse', 'wt-0'), { recursive: true });

      const scheduler = new PressmanScheduler({
        corpRoot,
        processManager: buildMockProcessManager(new Set(['pressman-aa'])),
        gitOps: buildMockGitOps(),
        // Pass-through test command — exit 0 deterministically without
        // running the corp's actual test suite.
        testProgram: 'node',
        testArgs: ['-e', 'process.exit(0)'],
      });

      // Run one tick. Won't actually merge (no real git) but the
      // chit-level cascade should happen because gitOps mocks claim
      // the merge succeeded.
      await scheduler.tick();

      // Submission should be merged.
      const subAfter = findChitById(corpRoot, submissionId);
      expect(subAfter?.chit.fields['clearance-submission'].submissionStatus).toBe('merged');
      // Task should be completed.
      const taskAfter = findChitById(corpRoot, taskChit.id);
      expect(taskAfter?.chit.fields.task.workflowStatus).toBe('completed');
      // Lock should be released.
      expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();
    });

    it('needs-author conflict files an escalation blocker + marks failed', async () => {
      writeMembers([makePressman()]);
      const taskChit = createChit<'task'>(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          task: {
            title: 'Test',
            priority: 'normal',
            workflowStatus: 'clearance',
          },
        },
      });
      const contractId = makeContract([taskChit.id]);
      const submissionId = buildSubmission({ branch: 'feat/x', taskId: taskChit.id, contractId });

      // Mock GitOps to return a conflict on rebase.
      const scheduler = new PressmanScheduler({
        corpRoot,
        processManager: buildMockProcessManager(new Set(['pressman-aa'])),
        gitOps: buildMockGitOps({
          rebase: async () => ok({ state: 'conflict' as const, conflictedFiles: ['src/foo.ts'] }),
          listConflictedFiles: async () => ok(['src/foo.ts']),
          diffStats: async () => ok({ filesChanged: 1, insertions: 1, deletions: 1 }),
        }),
      });

      // Set up the conflicted-file content in the worktree path so the
      // rebase orchestrator can classify. The pool's mock worktreeAdd
      // is a no-op, so the worktree path is the deterministic
      // <corpRoot>/.clearinghouse/wt-0/. Pre-create the file there.
      const wtDir = join(corpRoot, '.clearinghouse', 'wt-0', 'src');
      mkdirSync(wtDir, { recursive: true });
      writeFileSync(
        join(wtDir, 'foo.ts'),
        `<<<<<<< HEAD
const x = 1;
=======
const x = 2;
>>>>>>> feat/x`,
        'utf-8',
      );

      await scheduler.tick();

      // Submission marked failed.
      const subAfter = findChitById(corpRoot, submissionId);
      expect(subAfter?.chit.fields['clearance-submission'].submissionStatus).toBe('failed');
      // Escalation chit was filed.
      const { queryChits } = await import('../packages/shared/src/index.js');
      const escs = queryChits<'escalation'>(corpRoot, { types: ['escalation'] });
      expect(escs.chits.length).toBeGreaterThanOrEqual(1);
      const e = escs.chits.find((c) => c.chit.fields.escalation.originatingChit === submissionId);
      expect(e).toBeDefined();
      expect(e?.chit.fields.escalation.severity).toBe('blocker');
      // Lock released.
      expect(readClearinghouseLock(corpRoot).heldBy).toBeNull();
    });
  });
});
