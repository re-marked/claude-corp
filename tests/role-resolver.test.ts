import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveRoleToEmployee,
  createChit,
  createCasketIfMissing,
  advanceCurrentStep,
} from '../packages/shared/src/index.js';
import type { Member } from '../packages/shared/src/types/member.js';

/**
 * Unit tests for resolveRoleToEmployee (Project 1.4). Every test
 * builds a real members.json + Casket chits in tmpdir and exercises
 * the picker against fixtures with known shape.
 *
 * Coverage matrix:
 *   - unknown-role (not in ROLES registry)
 *   - role-is-partner-only (tier=decree / tier=role-lead)
 *   - no-candidates (pool-eligible role but no Employees exist)
 *   - resolved (idle-first / least-priority / data-gap-fallback)
 *     with assertions on pickPhase + candidates list ordering
 */

describe('resolveRoleToEmployee', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'role-resolver-test-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  function writeMembers(members: Partial<Member>[]): void {
    // Add required defaults so the Member type is satisfied.
    const full = members.map((m) => ({
      id: m.id ?? 'stub',
      displayName: m.displayName ?? (m.id ?? 'Stub'),
      rank: m.rank ?? 'worker',
      status: m.status ?? 'active',
      type: m.type ?? 'agent',
      scope: m.scope ?? 'corp',
      scopeId: m.scopeId ?? '',
      ...m,
    }));
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify(full, null, 2), 'utf-8');
  }

  // ─── unknown-role ────────────────────────────────────────────────

  it('returns unknown-role when the id is not in the ROLES registry', () => {
    writeMembers([]);
    const result = resolveRoleToEmployee(corpRoot, 'zorblax-specialist');
    expect(result).toMatchObject({ kind: 'unknown-role', role: 'zorblax-specialist' });
  });

  // ─── role-is-partner-only ────────────────────────────────────────

  it('rejects Partner-by-decree roles with candidate list', () => {
    writeMembers([
      { id: 'alice', displayName: 'Alice', role: 'ceo', kind: 'partner' },
      { id: 'bob', displayName: 'Bob', role: 'ceo', kind: 'partner' },
    ]);
    const result = resolveRoleToEmployee(corpRoot, 'ceo');
    expect(result.kind).toBe('role-is-partner-only');
    if (result.kind === 'role-is-partner-only') {
      expect(result.partnerCandidates.map((p) => p.slug).sort()).toEqual(['alice', 'bob']);
    }
  });

  it('rejects Partner-by-role (tier=role-lead) roles', () => {
    writeMembers([
      { id: 'ada', displayName: 'Ada', role: 'engineering-lead', kind: 'partner' },
    ]);
    const result = resolveRoleToEmployee(corpRoot, 'engineering-lead');
    expect(result.kind).toBe('role-is-partner-only');
  });

  it('role-is-partner-only returns empty candidate list when no Partners hired yet', () => {
    writeMembers([]);
    const result = resolveRoleToEmployee(corpRoot, 'herald');
    expect(result.kind).toBe('role-is-partner-only');
    if (result.kind === 'role-is-partner-only') {
      expect(result.partnerCandidates).toEqual([]);
    }
  });

  // ─── no-candidates ───────────────────────────────────────────────

  it('returns no-candidates for a pool-eligible role with zero Employees', () => {
    writeMembers([
      // CEO partner, no backend-engineer Employees.
      { id: 'alice', displayName: 'Alice', role: 'ceo', kind: 'partner' },
    ]);
    const result = resolveRoleToEmployee(corpRoot, 'backend-engineer');
    expect(result.kind).toBe('no-candidates');
    if (result.kind === 'no-candidates') {
      expect(result.poolEligible).toBe(true);
    }
  });

  it('skips inactive Employees when counting candidates', () => {
    writeMembers([
      { id: 'toast', displayName: 'Toast', role: 'backend-engineer', kind: 'employee', status: 'fired' },
    ]);
    const result = resolveRoleToEmployee(corpRoot, 'backend-engineer');
    expect(result.kind).toBe('no-candidates');
  });

  // ─── resolved (picker) ───────────────────────────────────────────

  it('picks idle-first phase when any candidate has null currentStep', () => {
    writeMembers([
      { id: 'toast', displayName: 'Toast', role: 'backend-engineer', kind: 'employee' },
      { id: 'ghost', displayName: 'Ghost', role: 'backend-engineer', kind: 'employee' },
    ]);
    createCasketIfMissing(corpRoot, 'toast', 'founder');
    createCasketIfMissing(corpRoot, 'ghost', 'founder');

    // Both idle — picker should return lexically-first candidate.
    const result = resolveRoleToEmployee(corpRoot, 'backend-engineer');
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.slug).toBe('ghost'); // 'ghost' < 'toast' lexically
      expect(result.pickPhase).toBe('idle-first');
      expect(result.currentStep).toBeNull();
      expect([...result.candidates].sort()).toEqual(['ghost', 'toast']);
    }
  });

  it('idle-first wins over busy candidate even when busy is lexically-first', () => {
    writeMembers([
      { id: 'alpha', displayName: 'Alpha', role: 'backend-engineer', kind: 'employee' },
      { id: 'zeta', displayName: 'Zeta', role: 'backend-engineer', kind: 'employee' },
    ]);
    createCasketIfMissing(corpRoot, 'alpha', 'founder');
    createCasketIfMissing(corpRoot, 'zeta', 'founder');
    // Make alpha busy.
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'busy-work', priority: 'normal' } },
      createdBy: 'founder',
    });
    advanceCurrentStep(corpRoot, 'alpha', task.id, 'founder');

    const result = resolveRoleToEmployee(corpRoot, 'backend-engineer');
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.slug).toBe('zeta');
      expect(result.pickPhase).toBe('idle-first');
    }
  });

  it('least-priority picks the candidate whose current task has lowest priority when all busy', () => {
    writeMembers([
      { id: 'aaa', displayName: 'Aaa', role: 'backend-engineer', kind: 'employee' },
      { id: 'bbb', displayName: 'Bbb', role: 'backend-engineer', kind: 'employee' },
    ]);
    createCasketIfMissing(corpRoot, 'aaa', 'founder');
    createCasketIfMissing(corpRoot, 'bbb', 'founder');

    const critical = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'critical-work', priority: 'critical' } },
      createdBy: 'founder',
    });
    const low = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'low-work', priority: 'low' } },
      createdBy: 'founder',
    });
    // aaa is on a critical task, bbb is on a low task. Picker displaces
    // the LOW-priority worker (bbb), leaving critical work on aaa.
    advanceCurrentStep(corpRoot, 'aaa', critical.id, 'founder');
    advanceCurrentStep(corpRoot, 'bbb', low.id, 'founder');

    const result = resolveRoleToEmployee(corpRoot, 'backend-engineer');
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.slug).toBe('bbb');
      expect(result.pickPhase).toBe('least-priority');
    }
  });

  it('data-gap-fallback picks lexically-first when current-step chits are unreadable', () => {
    writeMembers([
      { id: 'aaa', displayName: 'Aaa', role: 'backend-engineer', kind: 'employee' },
      { id: 'bbb', displayName: 'Bbb', role: 'backend-engineer', kind: 'employee' },
    ]);
    createCasketIfMissing(corpRoot, 'aaa', 'founder');
    createCasketIfMissing(corpRoot, 'bbb', 'founder');
    // Point both Caskets at non-existent chit ids (simulates corruption).
    advanceCurrentStep(corpRoot, 'aaa', 'chit-t-phantom1', 'founder');
    advanceCurrentStep(corpRoot, 'bbb', 'chit-t-phantom2', 'founder');

    const result = resolveRoleToEmployee(corpRoot, 'backend-engineer');
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.slug).toBe('aaa'); // lexically first
      expect(result.pickPhase).toBe('data-gap-fallback');
    }
  });

  // ─── determinism ─────────────────────────────────────────────────

  it('is deterministic: same fixture produces same result', () => {
    writeMembers([
      { id: 'toast', displayName: 'Toast', role: 'backend-engineer', kind: 'employee' },
      { id: 'ghost', displayName: 'Ghost', role: 'backend-engineer', kind: 'employee' },
      { id: 'copper', displayName: 'Copper', role: 'backend-engineer', kind: 'employee' },
    ]);
    createCasketIfMissing(corpRoot, 'toast', 'founder');
    createCasketIfMissing(corpRoot, 'ghost', 'founder');
    createCasketIfMissing(corpRoot, 'copper', 'founder');

    const first = resolveRoleToEmployee(corpRoot, 'backend-engineer');
    const second = resolveRoleToEmployee(corpRoot, 'backend-engineer');
    const third = resolveRoleToEmployee(corpRoot, 'backend-engineer');
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });
});
