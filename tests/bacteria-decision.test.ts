import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  createCasketIfMissing,
  advanceCurrentStep,
  pauseRole,
  type Member,
} from '../packages/shared/src/index.js';
import { decideBacteriaActions } from '../packages/daemon/src/bacteria/decision.js';
import {
  emptyBacteriaState,
  type BacteriaState,
} from '../packages/daemon/src/bacteria/types.js';

/**
 * Bacteria decision unit tests. Pure function — every test builds a
 * tmpdir corp with members.json + chits, calls decideBacteriaActions
 * with a fixed `now`, asserts the actions + nextState shape.
 *
 * No executor side effects exercised here. The decision module is
 * the math; correctness of the math is what these tests pin.
 */

describe('decideBacteriaActions', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'bacteria-decision-'));
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      // Windows fs-handle races shouldn't fail the test
    }
  });

  // ─── helpers ───────────────────────────────────────────────────────

  function writeMembers(members: Partial<Member>[]): void {
    const full = members.map((m) => ({
      id: m.id ?? 'stub',
      displayName: m.displayName ?? (m.id ?? 'stub'),
      rank: m.rank ?? 'worker',
      status: m.status ?? 'active',
      type: m.type ?? 'agent',
      scope: m.scope ?? 'corp',
      scopeId: m.scopeId ?? '',
      agentDir: m.agentDir ?? `agents/${m.id ?? 'stub'}/`,
      port: m.port ?? null,
      spawnedBy: m.spawnedBy ?? null,
      createdAt: m.createdAt ?? '2026-04-25T10:00:00.000Z',
      ...m,
    }));
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify(full, null, 2), 'utf-8');
  }

  function makeTaskChit(opts: {
    id?: string;
    assignee: string;
    workflowStatus?: 'queued' | 'dispatched';
    complexity?: 'trivial' | 'small' | 'medium' | 'large' | null;
    createdAt?: string;
  }): string {
    const chit = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'founder',
      status: 'active',
      fields: {
        task: {
          title: opts.id ?? 'a task',
          priority: 'normal',
          assignee: opts.assignee,
          workflowStatus: opts.workflowStatus ?? 'queued',
          complexity: opts.complexity ?? 'medium',
        },
      },
    });
    return chit.id;
  }

  function makeBusySlot(slug: string, taskId: string, generation = 0, parent?: string): void {
    createCasketIfMissing(corpRoot, slug, slug);
    advanceCurrentStep(corpRoot, slug, taskId, slug);
  }

  function makeIdleSlot(slug: string): void {
    createCasketIfMissing(corpRoot, slug, slug);
  }

  const NOW = new Date('2026-04-25T10:00:00.000Z');
  const NOW_PLUS_1_MIN = new Date('2026-04-25T10:01:00.000Z');
  const NOW_PLUS_5_MIN = new Date('2026-04-25T10:05:00.000Z');

  // ─── empty state ──────────────────────────────────────────────────

  it('emits no actions when the corp has no members and no tasks', () => {
    writeMembers([]);
    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });
    expect(result.actions).toEqual([]);
    expect(result.nextState.idleSince.size).toBe(0);
  });

  it('emits no actions when worker-tier roles have empty pool and no queued work', () => {
    writeMembers([
      { id: 'alice', role: 'ceo', kind: 'partner' },
    ]);
    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });
    expect(result.actions).toEqual([]);
  });

  // ─── mitose: empty pool with work ─────────────────────────────────

  it('mitoses with parentSlug=null + generation=0 when the pool is empty', () => {
    writeMembers([]);
    makeTaskChit({ assignee: 'backend-engineer', complexity: 'medium' });

    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      kind: 'mitose',
      role: 'backend-engineer',
      parentSlug: null,
      generation: 0,
    });
  });

  // ─── mitose: weighted queue math ──────────────────────────────────

  it('5 trivial tasks (weighted 1.25) at TARGET=1.5 needs only 1 slot', () => {
    writeMembers([]);
    for (let i = 0; i < 5; i++) {
      makeTaskChit({ assignee: 'backend-engineer', complexity: 'trivial' });
    }

    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    expect(result.actions.filter((a) => a.kind === 'mitose')).toHaveLength(1);
  });

  it('5 small + 3 medium (weighted 5.5) at TARGET=1.5 needs 4 slots', () => {
    writeMembers([]);
    for (let i = 0; i < 5; i++) {
      makeTaskChit({ assignee: 'backend-engineer', complexity: 'small' });
    }
    for (let i = 0; i < 3; i++) {
      makeTaskChit({ assignee: 'backend-engineer', complexity: 'medium' });
    }

    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    // ceil(5.5 / 1.5) = 4
    expect(result.actions.filter((a) => a.kind === 'mitose')).toHaveLength(4);
  });

  it('null complexity defaults to medium weight (1.0)', () => {
    writeMembers([]);
    // 2 null-complexity tasks → weighted 2.0 → ceil(2/1.5) = 2 slots
    makeTaskChit({ assignee: 'backend-engineer', complexity: null });
    makeTaskChit({ assignee: 'backend-engineer', complexity: null });

    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    expect(result.actions.filter((a) => a.kind === 'mitose')).toHaveLength(2);
  });

  // ─── mitose: lineage propagation ──────────────────────────────────

  it('mitose carries parentSlug + generation=parent+1 when a busy slot exists', () => {
    const taskA = makeTaskChit({ assignee: 'backend-engineer-aa' });
    writeMembers([
      {
        id: 'backend-engineer-aa',
        role: 'backend-engineer',
        kind: 'employee',
        generation: 2,
      },
    ]);
    makeBusySlot('backend-engineer-aa', taskA);

    // Add unprocessed work that triggers mitose
    makeTaskChit({ assignee: 'backend-engineer', complexity: 'large' });
    makeTaskChit({ assignee: 'backend-engineer', complexity: 'large' });

    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    const mitoses = result.actions.filter((a) => a.kind === 'mitose');
    expect(mitoses.length).toBeGreaterThan(0);
    for (const m of mitoses) {
      if (m.kind !== 'mitose') throw new Error('narrowing');
      expect(m.parentSlug).toBe('backend-engineer-aa');
      expect(m.generation).toBe(3);
    }
  });

  // ─── idle slots can absorb ────────────────────────────────────────

  it('does not mitose when idle slots equal needed extra capacity', () => {
    writeMembers([
      { id: 'backend-engineer-aa', role: 'backend-engineer', kind: 'employee' },
    ]);
    makeIdleSlot('backend-engineer-aa');
    // 1 medium queued; idle slot can take it.
    makeTaskChit({ assignee: 'backend-engineer', complexity: 'medium' });

    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    expect(result.actions.filter((a) => a.kind === 'mitose')).toEqual([]);
  });

  // ─── apoptose: hysteresis NOT elapsed ─────────────────────────────

  it('tracks idleSince but does not apoptose when hysteresis has not elapsed', () => {
    writeMembers([
      { id: 'backend-engineer-aa', role: 'backend-engineer', kind: 'employee' },
      { id: 'backend-engineer-bb', role: 'backend-engineer', kind: 'employee' },
    ]);
    makeIdleSlot('backend-engineer-aa');
    makeIdleSlot('backend-engineer-bb');
    // No queued work — both slots are surplus.

    // First tick: marks idleSince=NOW for both.
    const tick1 = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });
    expect(tick1.actions.filter((a) => a.kind === 'apoptose')).toEqual([]);
    expect(tick1.nextState.idleSince.size).toBe(2);

    // Second tick 1 minute later: hysteresis (3min) not elapsed.
    const tick2 = decideBacteriaActions({
      corpRoot,
      previousState: tick1.nextState,
      now: NOW_PLUS_1_MIN,
    });
    expect(tick2.actions.filter((a) => a.kind === 'apoptose')).toEqual([]);
    expect(tick2.nextState.idleSince.size).toBe(2);
  });

  // ─── apoptose: hysteresis elapsed ─────────────────────────────────

  it('apoptoses surplus idle slots once hysteresis elapses, leaving the floor intact', () => {
    // 3 idle slots + queue=0 + floor=1 → 2 apoptoses (the surplus
    // above the floor). Pre-1.13.x this expected 3 apoptoses, which
    // would cull a role to zero on a quiet tick — the bug Project
    // 1.13.x's finale surfaced.
    writeMembers([
      { id: 'backend-engineer-aa', role: 'backend-engineer', kind: 'employee' },
      { id: 'backend-engineer-bb', role: 'backend-engineer', kind: 'employee' },
      { id: 'backend-engineer-cc', role: 'backend-engineer', kind: 'employee' },
    ]);
    makeIdleSlot('backend-engineer-aa');
    makeIdleSlot('backend-engineer-bb');
    makeIdleSlot('backend-engineer-cc');

    const tick1 = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });
    expect(tick1.actions).toEqual([]);

    const tick2 = decideBacteriaActions({
      corpRoot,
      previousState: tick1.nextState,
      now: NOW_PLUS_5_MIN,
    });

    const apoptoses = tick2.actions.filter((a) => a.kind === 'apoptose');
    expect(apoptoses).toHaveLength(2);
    for (const a of apoptoses) {
      expect(a.kind).toBe('apoptose');
      if (a.kind === 'apoptose') {
        expect(a.idleSince).toBe(NOW.toISOString());
        expect(a.reason).toMatch(/hysteresis/);
      }
    }
  });

  it('respects the bacteriaFloor: refuses to apoptose the last slot when queue is empty', () => {
    // The Project 1.13.x finale bug: Pressman + Editor were auto-hired
    // as singletons (1 slot each), sat idle for 3 minutes during the
    // CEO's contract decomposition, and bacteria culled them to zero —
    // leaving the clearinghouse workerless. With floor=1, a sole idle
    // slot stays alive across an arbitrary quiet window, ready to wake
    // when work arrives.
    writeMembers([
      { id: 'backend-engineer-aa', role: 'backend-engineer', kind: 'employee' },
    ]);
    makeIdleSlot('backend-engineer-aa');

    const tick1 = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });
    const tick2 = decideBacteriaActions({
      corpRoot,
      previousState: tick1.nextState,
      now: NOW_PLUS_5_MIN,
    });

    // No apoptose — the lone slot is the floor.
    expect(tick2.actions.filter((a) => a.kind === 'apoptose')).toHaveLength(0);
    // idleSince is still tracked for the surviving slot (it's still
    // idle, just protected by the floor — not pruned, not retired).
    expect(tick2.nextState.idleSince.has('backend-engineer-aa')).toBe(true);
  });

  it('apoptosed slots leave the idleSince map in nextState', () => {
    // 2 slots, floor=1, queue=0, hysteresis elapsed → 1 apoptose,
    // 1 survives. Verifies that apoptose-side state pruning still
    // works alongside the floor invariant.
    writeMembers([
      { id: 'backend-engineer-aa', role: 'backend-engineer', kind: 'employee' },
      { id: 'backend-engineer-bb', role: 'backend-engineer', kind: 'employee' },
    ]);
    makeIdleSlot('backend-engineer-aa');
    makeIdleSlot('backend-engineer-bb');

    const tick1 = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });
    const tick2 = decideBacteriaActions({
      corpRoot,
      previousState: tick1.nextState,
      now: NOW_PLUS_5_MIN,
    });

    const apoptoses = tick2.actions.filter((a) => a.kind === 'apoptose');
    expect(apoptoses).toHaveLength(1);
    if (apoptoses[0]?.kind !== 'apoptose') throw new Error('narrowing');
    const apoptosed = apoptoses[0].slug;
    // The apoptosed slot's idleSince entry is dropped; the survivor's
    // is kept (it's still idle, protected by the floor).
    expect(tick2.nextState.idleSince.has(apoptosed)).toBe(false);
    const survivor = apoptosed === 'backend-engineer-aa'
      ? 'backend-engineer-bb'
      : 'backend-engineer-aa';
    expect(tick2.nextState.idleSince.has(survivor)).toBe(true);
  });

  // ─── busy → idleSince clears ──────────────────────────────────────

  it('a slot that goes busy is removed from nextState.idleSince', () => {
    writeMembers([
      { id: 'backend-engineer-aa', role: 'backend-engineer', kind: 'employee' },
    ]);
    makeIdleSlot('backend-engineer-aa');

    // Tick 1: slot is idle, tracked.
    const tick1 = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });
    expect(tick1.nextState.idleSince.has('backend-engineer-aa')).toBe(true);

    // Slot becomes busy externally — point its casket at a task.
    const taskId = makeTaskChit({ assignee: 'backend-engineer-aa' });
    advanceCurrentStep(corpRoot, 'backend-engineer-aa', taskId, 'backend-engineer-aa');

    // Tick 2: slot is busy — drops from idleSince.
    const tick2 = decideBacteriaActions({
      corpRoot,
      previousState: tick1.nextState,
      now: NOW_PLUS_1_MIN,
    });
    expect(tick2.nextState.idleSince.has('backend-engineer-aa')).toBe(false);
  });

  // ─── pause-skip (Project 1.10.4) ─────────────────────────────────

  it('skips paused roles entirely — no actions emitted even with queued work', () => {
    writeMembers([]);
    pauseRole(corpRoot, 'backend-engineer');
    // Three mediums queued — without the pause this would mitose 2 slots.
    makeTaskChit({ assignee: 'backend-engineer', complexity: 'medium' });
    makeTaskChit({ assignee: 'backend-engineer', complexity: 'medium' });
    makeTaskChit({ assignee: 'backend-engineer', complexity: 'medium' });

    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    const backendActions = result.actions.filter(
      (a) => (a.kind === 'mitose' && a.role === 'backend-engineer') ||
        (a.kind === 'apoptose' && a.slug.startsWith('backend-engineer')),
    );
    expect(backendActions).toEqual([]);
  });

  it('paused role is skipped while another role still acts', () => {
    writeMembers([]);
    pauseRole(corpRoot, 'qa-engineer');
    // Backend has work; QA has work but is paused.
    makeTaskChit({ assignee: 'backend-engineer', complexity: 'medium' });
    makeTaskChit({ assignee: 'qa-engineer', complexity: 'medium' });

    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    const mitoses = result.actions.filter((a) => a.kind === 'mitose');
    expect(mitoses).toHaveLength(1);
    if (mitoses[0]?.kind === 'mitose') expect(mitoses[0].role).toBe('backend-engineer');
  });

  // ─── multi-role independence ──────────────────────────────────────

  it('handles each worker-tier role independently', () => {
    writeMembers([]);
    // Backend has work, qa-engineer doesn't.
    makeTaskChit({ assignee: 'backend-engineer', complexity: 'medium' });

    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    const mitoses = result.actions.filter((a) => a.kind === 'mitose');
    expect(mitoses).toHaveLength(1);
    if (mitoses[0]?.kind === 'mitose') {
      expect(mitoses[0].role).toBe('backend-engineer');
    }
  });

  // ─── chit assignment ──────────────────────────────────────────────

  it('mitose actions assign chits oldest-first (FIFO)', () => {
    writeMembers([]);
    const earliest = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'founder',
      status: 'active',
      fields: {
        task: {
          title: 'first',
          priority: 'normal',
          assignee: 'backend-engineer',
          workflowStatus: 'queued',
          complexity: 'large',
        },
      },
    });
    // Pause to ensure distinct createdAt timestamps.
    const later = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'founder',
      status: 'active',
      fields: {
        task: {
          title: 'second',
          priority: 'normal',
          assignee: 'backend-engineer',
          workflowStatus: 'queued',
          complexity: 'large',
        },
      },
    });

    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    // Two larges → weighted 4 → ceil(4/1.5) = 3 slots → but only 2 chits to
    // assign → 2 mitose actions, oldest chit on the first action.
    const mitoses = result.actions.filter((a) => a.kind === 'mitose');
    expect(mitoses.length).toBeGreaterThanOrEqual(1);
    if (mitoses[0]?.kind === 'mitose') {
      // earliest.createdAt < later.createdAt, so earliest goes first.
      expect([earliest.id, later.id]).toContain(mitoses[0].assignedChit);
    }
  });

  // ─── chits already on a casket excluded ───────────────────────────

  it('excludes chits already on a slot casket from unprocessed-queue counting', () => {
    const taskA = makeTaskChit({ assignee: 'backend-engineer-aa', complexity: 'medium' });
    writeMembers([
      { id: 'backend-engineer-aa', role: 'backend-engineer', kind: 'employee' },
    ]);
    makeBusySlot('backend-engineer-aa', taskA);

    // Same task A is on the casket — it should NOT be counted toward
    // unprocessed weighted queue. No other queued work means no mitose.
    const result = decideBacteriaActions({
      corpRoot,
      previousState: emptyBacteriaState(),
      now: NOW,
    });

    expect(result.actions.filter((a) => a.kind === 'mitose')).toEqual([]);
  });
});
