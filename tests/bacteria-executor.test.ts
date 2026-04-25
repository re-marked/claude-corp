import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  createCasketIfMissing,
  queryChits,
  readBacteriaEvents,
  type Member,
  type GlobalConfig,
  type TaskFields,
} from '../packages/shared/src/index.js';
import {
  executeBacteriaActions,
  type ExecutorContext,
} from '../packages/daemon/src/bacteria/executor.js';
import type {
  ApoptoseAction,
  MitoseAction,
} from '../packages/daemon/src/bacteria/types.js';
import type { ProcessManager } from '../packages/daemon/src/process-manager.js';

/**
 * Integration tests for the bacteria executor. Decision module is
 * already pinned by bacteria-decision.test.ts; here we verify that
 * mitose actions actually create Members + claim chits, and apoptose
 * actions remove Members + write obituaries.
 *
 * ProcessManager is stubbed — we don't want to spawn real Claude
 * sessions in a test. The stub records calls so assertions can check
 * the spawn lifecycle was triggered.
 */

const GLOBAL_CONFIG: GlobalConfig = {
  apiKeys: { anthropic: 'test-key' },
  daemon: { portRange: [7800, 7900], logLevel: 'info' },
  defaults: { model: 'claude-haiku-4-5', provider: 'anthropic' },
};

interface StubProcessManager {
  spawnAgent: (memberId: string) => Promise<unknown>;
  stopAgent: (memberId: string) => Promise<void>;
  spawnCalls: string[];
  stopCalls: string[];
}

function makeStubProcessManager(): StubProcessManager {
  const spawnCalls: string[] = [];
  const stopCalls: string[] = [];
  return {
    spawnCalls,
    stopCalls,
    async spawnAgent(memberId: string) {
      spawnCalls.push(memberId);
      return { memberId, status: 'ready' };
    },
    async stopAgent(memberId: string) {
      stopCalls.push(memberId);
    },
  };
}

describe('executeBacteriaActions', () => {
  let corpRoot: string;
  let stubPM: StubProcessManager;
  let ctx: ExecutorContext;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'bacteria-executor-'));
    // Minimal corp setup — empty members.json + corp.json (so
    // readCorpHarness can run; setupAgentWorkspace also reads
    // members for spawnedBy resolution.)
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
    writeFileSync(
      join(corpRoot, 'corp.json'),
      JSON.stringify({ name: 'test-corp', harness: 'claude-code' }),
      'utf-8',
    );
    writeFileSync(join(corpRoot, 'channels.json'), '[]', 'utf-8');
    stubPM = makeStubProcessManager();
    ctx = {
      corpRoot,
      globalConfig: GLOBAL_CONFIG,
      processManager: stubPM as unknown as ProcessManager,
    };
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      // Windows fs-handle races
    }
  });

  // ─── mitose ───────────────────────────────────────────────────────

  it('mitose creates a Member with parentSlot + generation populated', async () => {
    // Pre-write a queued task assigned to the role.
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'founder',
      status: 'active',
      fields: {
        task: {
          title: 'do the thing',
          priority: 'normal',
          assignee: 'backend-engineer',
          workflowStatus: 'queued',
          complexity: 'medium',
        },
      },
    });

    const action: MitoseAction = {
      kind: 'mitose',
      role: 'backend-engineer',
      parentSlug: 'backend-engineer-aa',
      generation: 3,
      assignedChit: task.id,
    };

    const result = await executeBacteriaActions(ctx, [action]);
    expect(result).toEqual({ applied: 1, failed: 0 });

    // Member should be in members.json with bacteria-spawned shape.
    const members = JSON.parse(readFileSync(join(corpRoot, 'members.json'), 'utf-8')) as Member[];
    expect(members).toHaveLength(1);
    const m = members[0]!;
    expect(m.role).toBe('backend-engineer');
    expect(m.kind).toBe('employee');
    expect(m.parentSlot).toBe('backend-engineer-aa');
    expect(m.generation).toBe(3);
    // Slug should follow the role-XX pattern.
    expect(m.id).toMatch(/^backend-engineer-[a-z]{2}$/);
    // displayName starts AS the slug — the "needs naming" signal for
    // PR 3's first-dispatch rename prompt.
    expect(m.displayName).toBe(m.id);

    // processManager.spawnAgent should have been called with the new id.
    expect(stubPM.spawnCalls).toEqual([m.id]);
  });

  // Regression guard: Codex P1 review caught that a bacteria-spawned
  // slot without a founder DM channel was stuck busy-but-never-woken
  // because dispatchTaskToDm bails when no direct channel contains
  // the assignee. This test pins the channel registration so future
  // refactors can't silently drop it.
  it('mitose creates a founder DM channel + adds slot to pool channels', async () => {
    // Pre-populate founder + general channel so the registration paths
    // both have something to bind to.
    const founder: Member = {
      id: 'mark',
      displayName: 'Mark',
      rank: 'owner',
      status: 'active',
      type: 'user',
      scope: 'corp',
      scopeId: '',
      agentDir: null,
      port: null,
      spawnedBy: null,
      createdAt: '2026-04-01T00:00:00.000Z',
    };
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify([founder]), 'utf-8');
    const generalChannelId = 'channel-general';
    writeFileSync(
      join(corpRoot, 'channels.json'),
      JSON.stringify([
        {
          id: generalChannelId,
          name: 'general',
          kind: 'broadcast',
          scope: 'corp',
          scopeId: 'test-corp',
          teamId: null,
          memberIds: ['mark'],
          createdBy: 'mark',
          path: 'channels/general/',
          createdAt: '2026-04-01T00:00:00.000Z',
        },
      ]),
      'utf-8',
    );

    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'founder',
      status: 'active',
      fields: {
        task: {
          title: 'do the thing',
          priority: 'normal',
          assignee: 'backend-engineer',
          workflowStatus: 'queued',
          complexity: 'medium',
        },
      },
    });

    await executeBacteriaActions(ctx, [
      {
        kind: 'mitose',
        role: 'backend-engineer',
        parentSlug: null,
        generation: 0,
        assignedChit: task.id,
      },
    ]);

    const members = JSON.parse(readFileSync(join(corpRoot, 'members.json'), 'utf-8')) as Member[];
    const slug = members.find((m) => m.role === 'backend-engineer')?.id;
    expect(slug).toBeTruthy();

    const channels = JSON.parse(readFileSync(join(corpRoot, 'channels.json'), 'utf-8')) as Array<{
      kind: string;
      memberIds: string[];
      id: string;
    }>;
    // Founder DM should now exist with both founder and the new slot.
    const founderDm = channels.find(
      (c) => c.kind === 'direct' && c.memberIds.includes('mark') && c.memberIds.includes(slug!),
    );
    expect(founderDm).toBeDefined();

    // The slot should be added to the pre-existing general channel.
    const general = channels.find((c) => c.id === generalChannelId);
    expect(general?.memberIds).toContain(slug);
  });

  it('mitose claims the assigned chit (assignee + workflowStatus rewrite)', async () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'founder',
      status: 'active',
      fields: {
        task: {
          title: 'do the thing',
          priority: 'normal',
          assignee: 'backend-engineer',
          workflowStatus: 'queued',
          complexity: 'medium',
        },
      },
    });

    const action: MitoseAction = {
      kind: 'mitose',
      role: 'backend-engineer',
      parentSlug: null,
      generation: 0,
      assignedChit: task.id,
    };

    await executeBacteriaActions(ctx, [action]);

    // The task chit should now be assigned to the new slug + workflow → dispatched.
    const after = queryChits(corpRoot, { types: ['task'], limit: 0 });
    const updated = after.chits.find((c) => c.chit.id === task.id);
    expect(updated).toBeDefined();
    if (!updated || updated.chit.type !== 'task') throw new Error('narrowing');
    const fields = updated.chit.fields.task;
    expect(fields.assignee).toMatch(/^backend-engineer-[a-z]{2}$/);
    expect(fields.workflowStatus).toBe('dispatched');
  });

  // ─── apoptose ─────────────────────────────────────────────────────

  it('apoptose removes the Member and writes an obituary observation', async () => {
    // Pre-create a Member + idle casket.
    const slug = 'backend-engineer-aa';
    const member: Member = {
      id: slug,
      displayName: slug,
      rank: 'worker',
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: '',
      agentDir: `agents/${slug}/`,
      port: null,
      spawnedBy: null,
      createdAt: '2026-04-25T08:00:00.000Z',
      kind: 'employee',
      role: 'backend-engineer',
      generation: 2,
      parentSlot: 'backend-engineer-bb',
    };
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify([member]), 'utf-8');
    mkdirSync(join(corpRoot, 'agents', slug), { recursive: true });
    createCasketIfMissing(corpRoot, slug, slug);

    const action: ApoptoseAction = {
      kind: 'apoptose',
      slug,
      idleSince: '2026-04-25T09:30:00.000Z',
      reason: 'queue drained, hysteresis elapsed',
    };

    const result = await executeBacteriaActions(ctx, [action]);
    expect(result).toEqual({ applied: 1, failed: 0 });

    // Member removed.
    const members = JSON.parse(readFileSync(join(corpRoot, 'members.json'), 'utf-8')) as Member[];
    expect(members.find((m) => m.id === slug)).toBeUndefined();

    // Obituary observation written.
    const obs = queryChits(corpRoot, { types: ['observation'], limit: 0 });
    const obituary = obs.chits.find(
      (c) =>
        c.chit.type === 'observation' &&
        (c.chit.fields.observation.subject === slug),
    );
    expect(obituary).toBeDefined();
    if (!obituary || obituary.chit.type !== 'observation') throw new Error('narrowing');
    expect(obituary.chit.fields.observation.category).toBe('NOTICE');
    expect(obituary.body).toContain('idle since:  2026-04-25T09:30:00.000Z');
    expect(obituary.body).toContain('parent: backend-engineer-bb');
    expect(obituary.body).toContain('generation:  2');

    // stopAgent called.
    expect(stubPM.stopCalls).toEqual([slug]);
  });

  // Regression guard: Codex P2 review caught that the archive
  // directory was named `.archived-<slug>-<YYYY-MM-DD>`, so a recycled
  // slug re-apoptosing on the same date would collide on rename, and
  // the catch block would silently rmSync the live workspace. The
  // archive name now includes the full ISO timestamp (ms-precision)
  // for guaranteed per-apoptosis uniqueness.
  it('apoptose archive directory name carries a per-apoptosis timestamp', async () => {
    const slug = 'backend-engineer-aa';
    const member: Member = {
      id: slug,
      displayName: slug,
      rank: 'worker',
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: '',
      agentDir: `agents/${slug}/`,
      port: null,
      spawnedBy: null,
      createdAt: '2026-04-25T08:00:00.000Z',
      kind: 'employee',
      role: 'backend-engineer',
    };
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify([member]), 'utf-8');
    mkdirSync(join(corpRoot, 'agents', slug), { recursive: true });

    await executeBacteriaActions(ctx, [
      {
        kind: 'apoptose',
        slug,
        idleSince: '2026-04-25T09:30:00.000Z',
        reason: 'queue drained, hysteresis elapsed',
      },
    ]);

    const agentsDir = readdirSync(join(corpRoot, 'agents'));
    const archived = agentsDir.find((d) => d.startsWith(`.archived-${slug}-`));
    expect(archived).toBeDefined();
    // Format pin: must NOT be just the date (`.archived-<slug>-YYYY-MM-DD`,
    // 10 chars after the slug). The full ISO with replaced separators
    // is `2026-04-25T09-30-00-000Z` shape — matches the regex below.
    expect(archived!).toMatch(
      /^\.archived-backend-engineer-aa-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
    );
  });

  it('apoptose against a missing slug is idempotent (no throw, no failure)', async () => {
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');

    const action: ApoptoseAction = {
      kind: 'apoptose',
      slug: 'never-existed',
      idleSince: '2026-04-25T09:30:00.000Z',
      reason: 'test',
    };

    const result = await executeBacteriaActions(ctx, [action]);
    expect(result).toEqual({ applied: 1, failed: 0 });
  });

  // ─── failure isolation ────────────────────────────────────────────

  // ─── bacteria-events log emission (Project 1.10.4) ───────────────

  it('mitose appends a MitoseEvent to bacteria-events.jsonl', async () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'founder',
      status: 'active',
      fields: {
        task: {
          title: 'work',
          priority: 'normal',
          assignee: 'backend-engineer',
          workflowStatus: 'queued',
          complexity: 'medium',
        },
      },
    });

    await executeBacteriaActions(ctx, [
      {
        kind: 'mitose',
        role: 'backend-engineer',
        parentSlug: 'backend-engineer-bd',
        generation: 3,
        assignedChit: task.id,
      },
    ]);

    const events = readBacteriaEvents(corpRoot, { kind: 'mitose' });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    if (e.kind !== 'mitose') throw new Error('narrowing');
    expect(e.role).toBe('backend-engineer');
    expect(e.parentSlug).toBe('backend-engineer-bd');
    expect(e.generation).toBe(3);
    expect(e.assignedChit).toBe(task.id);
    expect(e.slug).toMatch(/^backend-engineer-[a-z]{2}$/);
  });

  it('apoptose appends an ApoptoseEvent with chosenName + lifetime + tasksCompleted', async () => {
    const slug = 'backend-engineer-aa';
    // Pre-create Member with chosenName + a couple of completed task chits.
    const member: Member = {
      id: slug,
      displayName: 'Toast', // self-named
      rank: 'worker',
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: '',
      agentDir: `agents/${slug}/`,
      port: null,
      spawnedBy: null,
      // Born one hour before the test "now" — lifetime should be ~3.6M ms.
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      kind: 'employee',
      role: 'backend-engineer',
      generation: 2,
      parentSlot: 'backend-engineer-bd',
    };
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify([member]), 'utf-8');
    mkdirSync(join(corpRoot, 'agents', slug), { recursive: true });

    // Two completed tasks attributed to this slot.
    for (let i = 0; i < 2; i++) {
      createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'founder',
        status: 'active',
        fields: {
          task: {
            title: `task ${i}`,
            priority: 'normal',
            assignee: slug,
            workflowStatus: 'completed',
          } as TaskFields,
        } as never,
      });
    }

    await executeBacteriaActions(ctx, [
      {
        kind: 'apoptose',
        slug,
        idleSince: new Date(Date.now() - 4 * 60_000).toISOString(),
        reason: 'queue drained, hysteresis elapsed',
      },
    ]);

    const events = readBacteriaEvents(corpRoot, { kind: 'apoptose' });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    if (e.kind !== 'apoptose') throw new Error('narrowing');
    expect(e.role).toBe('backend-engineer');
    expect(e.slug).toBe(slug);
    expect(e.generation).toBe(2);
    expect(e.parentSlug).toBe('backend-engineer-bd');
    expect(e.chosenName).toBe('Toast');
    expect(e.tasksCompleted).toBe(2);
    expect(e.lifetimeMs).toBeGreaterThan(3_500_000);
    expect(e.lifetimeMs).toBeLessThan(3_700_000);
  });

  it('apoptose chosenName is null when slot apoptosed before naming', async () => {
    const slug = 'backend-engineer-aa';
    // displayName === id → "not yet chosen" signal
    const member: Member = {
      id: slug,
      displayName: slug,
      rank: 'worker',
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: '',
      agentDir: `agents/${slug}/`,
      port: null,
      spawnedBy: null,
      createdAt: '2026-04-25T08:00:00.000Z',
      kind: 'employee',
      role: 'backend-engineer',
    };
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify([member]), 'utf-8');
    mkdirSync(join(corpRoot, 'agents', slug), { recursive: true });

    await executeBacteriaActions(ctx, [
      {
        kind: 'apoptose',
        slug,
        idleSince: '2026-04-25T09:30:00.000Z',
        reason: 'test',
      },
    ]);

    const events = readBacteriaEvents(corpRoot, { kind: 'apoptose' });
    expect(events).toHaveLength(1);
    if (events[0]!.kind !== 'apoptose') throw new Error('narrowing');
    expect(events[0]!.chosenName).toBeNull();
  });

  it('a failed action does not abort the rest of the batch', async () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'founder',
      status: 'active',
      fields: {
        task: {
          title: 'good',
          priority: 'normal',
          assignee: 'backend-engineer',
          workflowStatus: 'queued',
          complexity: 'medium',
        },
      },
    });

    // First action: mitose with a non-existent role (will throw on
    // setupAgentWorkspace's role lookup or land an orphan workspace —
    // the test cares that the second action still applies cleanly).
    // Use a real role for the second so it's a sane comparison.
    const goodAction: MitoseAction = {
      kind: 'mitose',
      role: 'backend-engineer',
      parentSlug: null,
      generation: 0,
      assignedChit: task.id,
    };
    const apoptoseMissing: ApoptoseAction = {
      kind: 'apoptose',
      slug: 'does-not-exist',
      idleSince: '2026-04-25T09:00:00.000Z',
      reason: 'test',
    };

    // missing-slug apoptose is idempotent (already covered above), so
    // here we run [missing-apoptose, good-mitose] and expect both
    // applied=2 (no failures).
    const result = await executeBacteriaActions(ctx, [apoptoseMissing, goodAction]);
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
  });
});
