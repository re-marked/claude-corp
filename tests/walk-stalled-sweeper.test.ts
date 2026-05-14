import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  castFromBlueprint,
  updateChit,
  chitScopeFromPath,
  findChitById,
  type Chit,
  type Member,
  MEMBERS_JSON,
  type TaskWorkflowStatus,
} from '../packages/shared/src/index.js';
import {
  runWalkStalled,
  WALK_STALL_THRESHOLD_DEFAULT_MS,
} from '../packages/daemon/src/continuity/sweepers/walk-stalled.js';
import type { Daemon } from '../packages/daemon/src/daemon.js';

/**
 * Project 2.4 — walk-stalled sweeper detection coverage.
 *
 * Each scenario builds a tmpdir corp with one cast walk + members,
 * mutates the relevant task fields to simulate the corp state under
 * test, calls runWalkStalled with a deterministic `now`, and asserts
 * on findings (count, subject, severity, body content).
 */

describe('runWalkStalled — detection scenarios', () => {
  let corpRoot: string;
  let daemonStub: Daemon;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'walk-stalled-'));
    daemonStub = { corpRoot } as Daemon;
  });

  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  function writeMembers(members: Member[]): void {
    writeFileSync(join(corpRoot, MEMBERS_JSON), JSON.stringify(members), 'utf-8');
  }

  function member(overrides: Partial<Member> = {}): Member {
    return {
      id: 'coder',
      displayName: 'Coder',
      rank: 'worker',
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: '',
      agentDir: 'agents/coder/',
      port: null,
      spawnedBy: null,
      createdAt: '2026-04-25T08:00:00.000Z',
      kind: 'employee',
      role: 'backend-engineer',
      ...overrides,
    } as Member;
  }

  /** Cast a 2-step walk and return the contract + tasks for direct mutation. */
  function castTwoStepWalk(): {
    contract: Chit<'contract'>;
    tasks: ReadonlyArray<Chit<'task'>>;
  } {
    const blueprint = createChit(corpRoot, {
      type: 'blueprint',
      scope: 'corp',
      status: 'active',
      createdBy: 'test',
      body: '',
      fields: {
        blueprint: {
          name: 'demo-walk',
          origin: 'authored',
          vars: [],
          steps: [
            { id: 'step-a', title: 'Do A', assigneeRole: 'backend-engineer' },
            { id: 'step-b', title: 'Do B', assigneeRole: 'backend-engineer' },
          ],
        },
      },
    });
    const result = castFromBlueprint(corpRoot, blueprint as Chit<'blueprint'>, {}, {
      scope: 'corp',
      createdBy: 'test',
    });
    // castFromBlueprint creates contracts in 'draft' status; activate
    // them so the sweeper's queryChits({statuses:['active']}) sees them.
    // Mirrors what Warden / the contract-create surface does in prod.
    const contractRaw = result.contract as Chit<'contract'>;
    const contractHit = findChitById(corpRoot, contractRaw.id);
    if (!contractHit) throw new Error('cast contract not found');
    const contractScope = chitScopeFromPath(corpRoot, contractHit.path);
    updateChit(corpRoot, contractScope, 'contract', contractRaw.id, {
      updatedBy: 'test',
      status: 'active',
    });
    const activated = findChitById(corpRoot, contractRaw.id);
    return {
      contract: activated!.chit as Chit<'contract'>,
      tasks: result.tasks as ReadonlyArray<Chit<'task'>>,
    };
  }

  function setTaskWorkflowStatus(
    taskId: string,
    workflowStatus: TaskWorkflowStatus,
    extra: { assignee?: string | null } = {},
  ): void {
    // Note: updateChit always bumps updatedAt to "now"; tests inject
    // `now` into the sweeper instead of trying to backdate task
    // timestamps. See FAR_FUTURE_NOW below.
    const hit = findChitById(corpRoot, taskId);
    if (!hit || hit.chit.type !== 'task') throw new Error(`task ${taskId} not found`);
    const taskChit = hit.chit as Chit<'task'>;
    const scope = chitScopeFromPath(corpRoot, hit.path);
    const fields = { ...(taskChit.fields.task), workflowStatus };
    if ('assignee' in extra) fields.assignee = extra.assignee ?? null;
    updateChit(corpRoot, scope, 'task', taskChit.id, {
      updatedBy: 'test',
      fields: { task: fields } as never,
    });
  }

  /**
   * Inject "now" 1 hour past wall-clock so any updatedAt set during
   * this test (which lands at real-now) appears 1 hour old to the
   * sweeper — past the 30 min default threshold.
   */
  const FAR_FUTURE_NOW = (): number => Date.now() + 60 * 60 * 1000;

  it('flags a contract whose open step is unassigned and last-close is past the threshold', async () => {
    writeMembers([member({ id: 'coder' })]);
    const { contract, tasks } = castTwoStepWalk();

    // Step A completed; Step B queued with no assignee. The sweeper
    // sees Step A's updatedAt as 1 hour old via the injected now.
    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(tasks[1]!.id, 'queued', { assignee: null });

    const result = await runWalkStalled({ daemon: daemonStub }, { now: FAR_FUTURE_NOW() });
    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.subject).toBe(contract.id);
    expect(finding.severity).toBe('warn');
    expect(finding.title).toContain('demo-walk');
    expect(finding.body).toContain(tasks[1]!.id); // orphan task id named
    expect(finding.body).toContain('step-a'); // last completed step named
  });

  it('does NOT flag when an open step has a live Member assignee', async () => {
    writeMembers([member({ id: 'coder' })]);
    const { tasks } = castTwoStepWalk();

    // Step A completed; Step B in-progress assigned to a live member.
    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(tasks[1]!.id, 'in_progress', { assignee: 'coder' });

    const result = await runWalkStalled({ daemon: daemonStub }, { now: FAR_FUTURE_NOW() });
    expect(result.status).toBe('noop');
    expect(result.findings).toHaveLength(0);
  });

  it('DOES flag when an open step is assigned to a role (no slot resolved)', async () => {
    // Role-id in assignee means "queued in role pool" — counts as
    // unassigned for this sweeper. Bacteria-spawn hasn't materialized
    // a slot for the role yet; the stall surfaces so Sexton can
    // nudge the pool.
    writeMembers([member({ id: 'coder' })]);
    const { tasks } = castTwoStepWalk();

    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    // assignee is the role id, not any Member id.
    setTaskWorkflowStatus(tasks[1]!.id, 'queued', { assignee: 'backend-engineer' });

    const result = await runWalkStalled({ daemon: daemonStub }, { now: FAR_FUTURE_NOW() });
    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(1);
  });

  it('flags when an open step is assigned to an archived (non-live) Member', async () => {
    // Archived member is no longer "live." Sweeper SHOULD flag.
    writeMembers([member({ id: 'coder', status: 'archived' as Member['status'] })]);
    const { tasks } = castTwoStepWalk();

    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(tasks[1]!.id, 'in_progress', { assignee: 'coder' });

    const result = await runWalkStalled({ daemon: daemonStub }, { now: FAR_FUTURE_NOW() });
    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(1);
  });

  it('excludes contracts where any task is in `clearance` (Pressman owns it)', async () => {
    // Pressman-owned merges look "stalled" by every other measure;
    // without the clearance exclusion this sweeper would emit a
    // noise kink on every PR mid-merge.
    writeMembers([member({ id: 'coder' })]);
    const { tasks } = castTwoStepWalk();

    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(tasks[1]!.id, 'clearance', { assignee: null });

    const result = await runWalkStalled({ daemon: daemonStub }, { now: FAR_FUTURE_NOW() });
    expect(result.status).toBe('noop');
    expect(result.findings).toHaveLength(0);
  });

  it('does NOT flag when last-close is within the threshold (recent motion)', async () => {
    writeMembers([member({ id: 'coder' })]);
    const { tasks } = castTwoStepWalk();

    // Step A completed at wall-clock now; sweeper runs at wall-clock
    // now too — well inside the 30 min default threshold.
    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(tasks[1]!.id, 'queued', { assignee: null });

    const result = await runWalkStalled({ daemon: daemonStub });
    expect(result.status).toBe('noop');
    expect(result.findings).toHaveLength(0);
  });

  it('uses contract.createdAt as the floor when no task has completed yet', async () => {
    // Contract cast a long time ago, no task ever moved past
    // queued, no live assignees. That IS a stall (the walk never
    // started moving). Use the deterministic `now` opt to set the
    // age past the threshold.
    writeMembers([member({ id: 'coder' })]);
    const { tasks } = castTwoStepWalk();

    setTaskWorkflowStatus(tasks[0]!.id, 'queued', { assignee: null });
    setTaskWorkflowStatus(tasks[1]!.id, 'queued', { assignee: null });

    // contract.createdAt is "now" from the cast above. Run the
    // sweeper with now-injected an hour in the future.
    const futureNow = Date.now() + 60 * 60 * 1000;
    const result = await runWalkStalled(
      { daemon: daemonStub },
      { now: futureNow },
    );
    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.body).toMatch(/never advanced past cast|contract never advanced/);
  });

  it('respects a custom stallThresholdMs (lower threshold flags faster)', async () => {
    writeMembers([member({ id: 'coder' })]);
    const { tasks } = castTwoStepWalk();

    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(tasks[1]!.id, 'queued', { assignee: null });

    // Run "10 min" after the writes — well under the 30 min default,
    // well over a 5 min custom threshold.
    const tenMinFromNow = Date.now() + 10 * 60 * 1000;

    const defaultResult = await runWalkStalled(
      { daemon: daemonStub },
      { now: tenMinFromNow },
    );
    expect(defaultResult.status).toBe('noop');

    const tightResult = await runWalkStalled(
      { daemon: daemonStub },
      { now: tenMinFromNow, stallThresholdMs: 5 * 60 * 1000 },
    );
    expect(tightResult.status).toBe('completed');
    expect(tightResult.findings).toHaveLength(1);
  });

  it('emits one finding per stalled contract (multi-stall scenario)', async () => {
    writeMembers([member({ id: 'coder' })]);
    const walkA = castTwoStepWalk();
    const walkB = castTwoStepWalk();

    setTaskWorkflowStatus(walkA.tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(walkA.tasks[1]!.id, 'queued', { assignee: null });
    setTaskWorkflowStatus(walkB.tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(walkB.tasks[1]!.id, 'queued', { assignee: null });

    const result = await runWalkStalled({ daemon: daemonStub }, { now: FAR_FUTURE_NOW() });
    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(2);
    const subjects = new Set(result.findings.map((f) => f.subject));
    expect(subjects.has(walkA.contract.id)).toBe(true);
    expect(subjects.has(walkB.contract.id)).toBe(true);
  });

  it('ignores contracts without a blueprintId (ad-hoc multi-task contracts)', async () => {
    // Contract created directly (no cast) → no blueprintId → not
    // a walk → not this sweeper's business even if its tasks look
    // stalled by every other measure.
    writeMembers([member({ id: 'coder' })]);
    createChit(corpRoot, {
      type: 'contract',
      scope: 'corp',
      status: 'active',
      createdBy: 'test',
      fields: {
        contract: {
          title: 'ad-hoc contract',
          goal: 'manual coordination work; no blueprint',
          blueprintId: null,
          taskIds: [],
          priority: 'normal',
        },
      },
    });

    const result = await runWalkStalled({ daemon: daemonStub });
    expect(result.status).toBe('noop');
    expect(result.findings).toHaveLength(0);
  });

  it('ignores contracts whose blueprint is missing (drift case, defers to chit-hygiene)', async () => {
    writeMembers([member({ id: 'coder' })]);
    const { contract } = castTwoStepWalk();

    // Delete the blueprint chit by archiving the contract's
    // reference. Easier path: rewrite contractFields.blueprintId to
    // a chit id that doesn't exist.
    const hit = findChitById(corpRoot, contract.id);
    if (!hit) throw new Error('contract not found');
    const scope = chitScopeFromPath(corpRoot, hit.path);
    updateChit(corpRoot, scope, 'contract', contract.id, {
      updatedBy: 'test',
      fields: {
        contract: {
          ...(contract.fields.contract),
          blueprintId: 'chit-bp-vanished',
        },
      } as never,
    });

    const result = await runWalkStalled({ daemon: daemonStub });
    // getWalkProgress returns null → sweeper skips → noop.
    expect(result.status).toBe('noop');
    expect(result.findings).toHaveLength(0);
  });

  it('suggests rewind-then-hand for stuck-state orphans, plain hand for handable ones (Codex P2)', async () => {
    // `cc-cli hand` rejects in_progress/blocked/under_review via the
    // task state-machine. The body must name the rewind path
    // (`chit update --set-field task.workflowStatus=queued`) for those
    // states rather than a hand command the CLI would refuse. Plain
    // hand stays appropriate for queued/dispatched/draft.
    writeMembers([member({ id: 'coder', status: 'archived' as Member['status'] })]);
    const { tasks } = castTwoStepWalk();

    // Step A completed; Step B in_progress with an archived assignee
    // — the stuck-state scenario Codex flagged.
    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(tasks[1]!.id, 'in_progress', { assignee: 'coder' });

    const result = await runWalkStalled({ daemon: daemonStub }, { now: FAR_FUTURE_NOW() });
    expect(result.findings).toHaveLength(1);
    const body = result.findings[0]!.body;

    // Stuck-state task → rewind first, then hand.
    expect(body).toContain('rewind to queued first');
    expect(body).toContain('task.workflowStatus=queued');
    expect(body).toContain('cc-cli chit update');

    // The bare hand template MUST NOT appear under the "Re-Hand"
    // section for this stuck task — that command would fail. (The
    // hand command DOES appear inside the rewind-then-hand line as
    // the SECOND step of the chain, gated behind the rewind; that's
    // legitimate. The check here is that the body distinguishes the
    // two paths.)
    expect(body).not.toMatch(
      /Re-Hand the orphan task\(s\): `cc-cli hand --to [^`]+ --chit chit-t-[^`]+/,
    );
  });

  it('uses plain hand suggestion when stalled orphan is in a handable state (queued)', async () => {
    // Companion to the previous test — queued orphan with no live
    // assignee gets the plain `cc-cli hand` command, no rewind.
    writeMembers([member({ id: 'coder' })]);
    const { tasks } = castTwoStepWalk();

    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(tasks[1]!.id, 'queued', { assignee: null });

    const result = await runWalkStalled({ daemon: daemonStub }, { now: FAR_FUTURE_NOW() });
    expect(result.findings).toHaveLength(1);
    const body = result.findings[0]!.body;

    // Re-Hand section names the actual command.
    expect(body).toMatch(/Re-Hand the orphan task\(s\): `cc-cli hand --to/);
    // No rewind chatter for handable states.
    expect(body).not.toContain('rewind to queued');
  });

  it('suggests inspect-or-wait for blocked orphans, NOT rewind (Codex P2)', async () => {
    // chain.ts owns the unblock path for blocked tasks (unblock /
    // unblock-to-queue deltas after readiness + validateTransition).
    // Forcing workflowStatus=queued here would skip those guards and
    // dispatch work that should stay blocked.
    writeMembers([member({ id: 'coder', status: 'archived' as Member['status'] })]);
    const { tasks } = castTwoStepWalk();

    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(tasks[1]!.id, 'blocked', { assignee: 'coder' });

    const result = await runWalkStalled({ daemon: daemonStub }, { now: FAR_FUTURE_NOW() });
    expect(result.findings).toHaveLength(1);
    const body = result.findings[0]!.body;

    // Body must explicitly forbid rewinding a blocked task + name the
    // chain-walker as the owner of the unblock path.
    expect(body).toContain('DO NOT rewind');
    expect(body).toContain('chain walker');
    expect(body).toContain('inspect dependsOn');

    // The rewind chain (--set-field task.workflowStatus=queued) MUST
    // NOT appear for the blocked task. The body may still contain the
    // string for other purposes, so the assertion is specifically that
    // the blocked task's rewind line is absent.
    expect(body).not.toMatch(
      new RegExp(`task ${tasks[1]!.id} \\(workflowStatus=blocked\\): rewind`),
    );
  });

  it('routes dispatched orphans to rewind+hand, NOT plain role-queue hand (Codex P2)', async () => {
    // handChitToRoleQueue rejects everything except {draft, queued}.
    // A dispatched orphan whose assignee was archived would have the
    // suggested `cc-cli hand --to <role>` command fail. Rewind first,
    // then hand.
    writeMembers([member({ id: 'coder', status: 'archived' as Member['status'] })]);
    const { tasks } = castTwoStepWalk();

    setTaskWorkflowStatus(tasks[0]!.id, 'completed');
    setTaskWorkflowStatus(tasks[1]!.id, 'dispatched', { assignee: 'coder' });

    const result = await runWalkStalled({ daemon: daemonStub }, { now: FAR_FUTURE_NOW() });
    expect(result.findings).toHaveLength(1);
    const body = result.findings[0]!.body;

    // Rewind+hand chain is present for the dispatched task.
    expect(body).toContain(`workflowStatus=dispatched): rewind to queued first`);
    expect(body).toContain('task.workflowStatus=queued');

    // No bare "Re-Hand the orphan task(s)" line listing this task
    // directly — that's the section reserved for draft/queued.
    expect(body).not.toMatch(
      new RegExp(
        `Re-Hand the orphan task\\(s\\): \`cc-cli hand --to [^\`]+ --chit ${tasks[1]!.id}`,
      ),
    );
  });

  it('default threshold constant is 30 minutes', () => {
    // Pins the documented contract: Pulse cadence is 5min, so
    // 6 ticks of zero motion = meaningful stall threshold. If a
    // future PR changes the default, this test forces a deliberate
    // review of the change.
    expect(WALK_STALL_THRESHOLD_DEFAULT_MS).toBe(30 * 60 * 1000);
  });
});
