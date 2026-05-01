import { describe, it, expect } from 'vitest';
import { resolveKind, inferKind } from '../packages/shared/src/wtf-state.js';

/**
 * Project 1.1: resolveKind(member) preference order.
 *   1. Explicit Member.kind when set (post-1.1 hires).
 *   2. Rank-based inferKind fallback (pre-1.1 agents on disk).
 *
 * This is the "drift" axis most likely to matter in practice:
 * a member with explicit kind='employee' but rank='leader' must
 * resolve to 'employee' — NOT 'partner' via the legacy rank
 * heuristic. Otherwise the structural field is worthless.
 */

describe('resolveKind', () => {
  it('prefers explicit member.kind when set, regardless of rank', () => {
    expect(resolveKind({ rank: 'leader', kind: 'employee' })).toBe('employee');
    expect(resolveKind({ rank: 'worker', kind: 'partner' })).toBe('partner');
    expect(resolveKind({ rank: 'master', kind: 'employee' })).toBe('employee');
  });

  it('falls back to inferKind(rank) when member.kind is absent', () => {
    expect(resolveKind({ rank: 'owner' })).toBe('partner');
    expect(resolveKind({ rank: 'master' })).toBe('partner');
    expect(resolveKind({ rank: 'leader' })).toBe('partner');
    expect(resolveKind({ rank: 'worker' })).toBe('employee');
    expect(resolveKind({ rank: 'subagent' })).toBe('employee');
  });

  it('treats pre-1.1 missing-kind as partner for owner/master/leader ranks', () => {
    // The backwards-compat invariant: every agent that predates 1.1
    // is persistent-named, i.e. already structurally a Partner. Null
    // kind must NOT silently demote them to Employee.
    for (const rank of ['owner', 'master', 'leader']) {
      expect(resolveKind({ rank })).toBe('partner');
    }
  });
});

describe('inferKind (rank-only fallback)', () => {
  it('maps owner/master/leader → partner', () => {
    expect(inferKind('owner')).toBe('partner');
    expect(inferKind('master')).toBe('partner');
    expect(inferKind('leader')).toBe('partner');
  });

  it('maps worker/subagent → employee', () => {
    expect(inferKind('worker')).toBe('employee');
    expect(inferKind('subagent')).toBe('employee');
  });

  it('defaults unknown ranks to partner (keeps soul-file paths in play)', () => {
    expect(inferKind('unknown-future-rank')).toBe('partner');
    expect(inferKind('')).toBe('partner');
  });
});
