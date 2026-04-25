import { describe, it, expect } from 'vitest';
import {
  computeRoleStats,
  formatHumanStatus,
} from '../packages/cli/src/commands/bacteria/status.js';
import {
  getRole,
  type ApoptoseEvent,
  type BacteriaEvent,
  type Member,
  type MitoseEvent,
  type RoleEntry,
} from '../packages/shared/src/index.js';

/**
 * Coverage for cc-cli bacteria status's pure helpers (Project 1.10.4).
 * computeRoleStats and formatHumanStatus are pure given members +
 * events + pause-set; no filesystem, no I/O.
 */

describe('bacteria status', () => {
  const backendRole = getRole('backend-engineer') as RoleEntry;

  function member(overrides: Partial<Member> = {}): Member {
    return {
      id: 'backend-engineer-aa',
      displayName: 'Toast',
      rank: 'worker',
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: '',
      agentDir: 'agents/backend-engineer-aa/',
      port: null,
      spawnedBy: null,
      createdAt: '2026-04-25T08:00:00.000Z',
      kind: 'employee',
      role: 'backend-engineer',
      ...overrides,
    };
  }

  function mitose(slug: string, ts: string, generation = 1): MitoseEvent {
    return {
      kind: 'mitose',
      ts,
      role: 'backend-engineer',
      slug,
      generation,
      parentSlug: null,
      assignedChit: 'chit-t-abc',
    };
  }

  function apoptose(slug: string, ts: string, lifetimeMs: number): ApoptoseEvent {
    return {
      kind: 'apoptose',
      ts,
      role: 'backend-engineer',
      slug,
      generation: 1,
      parentSlug: null,
      chosenName: 'Toast',
      reason: 'queue drained',
      idleSince: ts,
      lifetimeMs,
      tasksCompleted: 5,
    };
  }

  // ─── computeRoleStats ─────────────────────────────────────────────

  it('empty pool, no events — zeros across the board', () => {
    const stats = computeRoleStats(backendRole, [], [], new Set());
    expect(stats.active).toBe(0);
    expect(stats.generations).toBeNull();
    expect(stats.todayMitoses).toBe(0);
    expect(stats.todayApoptoses).toBe(0);
    expect(stats.peakToday).toBe(0);
    expect(stats.meanLifespanMs).toBeNull();
    expect(stats.paused).toBe(false);
  });

  it('counts active employees and computes generation range', () => {
    const members = [
      member({ id: 'backend-engineer-aa', generation: 0 }),
      member({ id: 'backend-engineer-bb', generation: 2 }),
      member({ id: 'backend-engineer-cc', generation: 4 }),
    ];
    const stats = computeRoleStats(backendRole, members, [], new Set());
    expect(stats.active).toBe(3);
    expect(stats.generations).toEqual({ min: 0, max: 4 });
  });

  it('counts today mitoses + apoptoses + computes mean lifespan', () => {
    const events: BacteriaEvent[] = [
      mitose('backend-engineer-aa', '2026-04-25T10:00:00.000Z'),
      mitose('backend-engineer-bb', '2026-04-25T10:30:00.000Z'),
      apoptose('backend-engineer-aa', '2026-04-25T11:00:00.000Z', 3_600_000),
      apoptose('backend-engineer-bb', '2026-04-25T11:30:00.000Z', 3_000_000),
    ];
    const stats = computeRoleStats(backendRole, [], events, new Set());
    expect(stats.todayMitoses).toBe(2);
    expect(stats.todayApoptoses).toBe(2);
    // (3.6M + 3M) / 2 = 3.3M ms
    expect(stats.meanLifespanMs).toBe(3_300_000);
  });

  it('peak simultaneous reflects mid-day high water mark', () => {
    // Start of day: 0 active (none of these slots existed yet).
    // After mitose1 mitose2 mitose3: 3 active.
    // After apoptose1: 2.
    // Final: 2 active in members.
    const events: BacteriaEvent[] = [
      mitose('backend-engineer-aa', '2026-04-25T10:00:00.000Z'),
      mitose('backend-engineer-bb', '2026-04-25T10:01:00.000Z'),
      mitose('backend-engineer-cc', '2026-04-25T10:02:00.000Z'),
      apoptose('backend-engineer-aa', '2026-04-25T10:03:00.000Z', 180_000),
    ];
    const members = [
      member({ id: 'backend-engineer-bb' }),
      member({ id: 'backend-engineer-cc' }),
    ];
    const stats = computeRoleStats(backendRole, members, events, new Set());
    expect(stats.peakToday).toBe(3);
  });

  it('flags paused state', () => {
    const stats = computeRoleStats(
      backendRole,
      [],
      [],
      new Set(['backend-engineer']),
    );
    expect(stats.paused).toBe(true);
  });

  it('flags target / hysteresis as override when RoleEntry sets them', () => {
    const tunedRole: RoleEntry = { ...backendRole, bacteriaTarget: 2.5, bacteriaHysteresisMs: 60_000 };
    const stats = computeRoleStats(tunedRole, [], [], new Set());
    expect(stats.target).toEqual({ value: 2.5, isOverride: true });
    expect(stats.hysteresisMs).toEqual({ value: 60_000, isOverride: true });
  });

  it('flags defaults when RoleEntry omits the fields', () => {
    const stats = computeRoleStats(backendRole, [], [], new Set());
    expect(stats.target.isOverride).toBe(false);
    expect(stats.hysteresisMs.isOverride).toBe(false);
  });

  // ─── formatHumanStatus ────────────────────────────────────────────

  it('formatHumanStatus prints role name + active count + today stats', () => {
    const stats = computeRoleStats(
      backendRole,
      [member({ id: 'backend-engineer-aa', generation: 1 })],
      [
        mitose('backend-engineer-aa', '2026-04-25T10:00:00.000Z', 1),
        apoptose('backend-engineer-bb', '2026-04-25T11:00:00.000Z', 3_600_000),
      ],
      new Set(),
    );
    const out = formatHumanStatus([stats]);
    expect(out).toContain('Backend Engineer (backend-engineer):');
    expect(out).toContain('1 active');
    expect(out).toContain('1 mitoses, 1 apoptoses');
    expect(out).toContain('mean lifespan:');
  });

  it('formatHumanStatus prints "no activity" for quiet roles', () => {
    const stats = computeRoleStats(backendRole, [], [], new Set());
    const out = formatHumanStatus([stats]);
    expect(out).toContain('today: no activity');
  });

  it('formatHumanStatus shows PAUSED label when paused', () => {
    const stats = computeRoleStats(
      backendRole,
      [],
      [],
      new Set(['backend-engineer']),
    );
    const out = formatHumanStatus([stats]);
    expect(out).toContain('paused: PAUSED');
  });

  it('formatHumanStatus shows (override) marker when tuned', () => {
    const tunedRole: RoleEntry = { ...backendRole, bacteriaTarget: 2.5 };
    const stats = computeRoleStats(tunedRole, [], [], new Set());
    const out = formatHumanStatus([stats]);
    expect(out).toContain('target: 2.5 (override)');
  });
});
