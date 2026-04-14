import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveMemberHarness,
  corpHasOpenClawAgent,
  DEFAULT_HARNESS,
} from '../packages/daemon/src/harness-resolve.js';
import type { Member } from '../packages/shared/src/types/member.js';

/**
 * Harness-resolution rules live in one place to prevent drift between
 * subsystems (HarnessRouter per-dispatch, ProcessManager.spawnAgent,
 * Daemon.connectOpenClawWS). These tests pin the rule down: Member.
 * harness > Corporation.harness > 'openclaw'.
 */

function mkMember(over: Partial<Member> & { id: string }): Member {
  return {
    id: over.id,
    displayName: over.id,
    rank: over.rank ?? 'worker',
    status: over.status ?? 'active',
    type: over.type ?? 'agent',
    scope: 'corp',
    scopeId: 'test',
    agentDir: over.agentDir ?? `agents/${over.id}/`,
    port: null,
    spawnedBy: 'mark',
    createdAt: new Date().toISOString(),
    ...(over.harness ? { harness: over.harness } : {}),
  };
}

describe('resolveMemberHarness', () => {
  it('returns member.harness when set', () => {
    expect(resolveMemberHarness(mkMember({ id: 'a', harness: 'claude-code' }), 'openclaw')).toBe('claude-code');
  });

  it('falls back to corp harness when member.harness is unset', () => {
    expect(resolveMemberHarness(mkMember({ id: 'a' }), 'claude-code')).toBe('claude-code');
  });

  it('falls back to openclaw when neither is set', () => {
    expect(resolveMemberHarness(mkMember({ id: 'a' }), undefined)).toBe(DEFAULT_HARNESS);
    expect(resolveMemberHarness(mkMember({ id: 'a' }), undefined)).toBe('openclaw');
  });

  it('falls back to openclaw when the member is undefined', () => {
    expect(resolveMemberHarness(undefined, undefined)).toBe('openclaw');
  });

  it('member.harness wins over corp.harness even when both set', () => {
    expect(resolveMemberHarness(mkMember({ id: 'a', harness: 'openclaw' }), 'claude-code')).toBe('openclaw');
  });
});

describe('corpHasOpenClawAgent', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = join(tmpdir(), `harness-resolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(corpRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function seed(corpHarness: string | undefined, members: Member[]): void {
    writeFileSync(
      join(corpRoot, 'corp.json'),
      JSON.stringify({
        name: 'test', displayName: 'test', owner: 'mark', ceo: null,
        description: '', theme: 'corporate', defaultDmMode: 'jack',
        createdAt: new Date().toISOString(),
        ...(corpHarness ? { harness: corpHarness } : {}),
      }, null, 2),
    );
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify(members, null, 2));
  }

  it('returns true when any agent resolves to openclaw explicitly', () => {
    seed('claude-code', [
      mkMember({ id: 'ceo', harness: 'claude-code' }),
      mkMember({ id: 'pilot', harness: 'openclaw' }), // per-agent override
    ]);
    expect(corpHasOpenClawAgent(corpRoot)).toBe(true);
  });

  it('returns true when any agent inherits openclaw from corp default', () => {
    seed('openclaw', [mkMember({ id: 'ceo' })]);
    expect(corpHasOpenClawAgent(corpRoot)).toBe(true);
  });

  it('returns true when corp has no explicit harness (falls back to openclaw)', () => {
    seed(undefined, [mkMember({ id: 'ceo' })]);
    expect(corpHasOpenClawAgent(corpRoot)).toBe(true);
  });

  it('returns false when every agent resolves to claude-code', () => {
    seed('claude-code', [
      mkMember({ id: 'ceo' }),
      mkMember({ id: 'pilot', harness: 'claude-code' }),
    ]);
    expect(corpHasOpenClawAgent(corpRoot)).toBe(false);
  });

  it('skips non-agent members (founder user, etc.)', () => {
    seed('claude-code', [
      mkMember({ id: 'mark', type: 'user' }),
      mkMember({ id: 'ceo', harness: 'claude-code' }),
    ]);
    expect(corpHasOpenClawAgent(corpRoot)).toBe(false);
  });

  it('returns false when corp has zero agents', () => {
    seed('claude-code', []);
    expect(corpHasOpenClawAgent(corpRoot)).toBe(false);
  });

  it('errs toward true on malformed configs (missing files)', () => {
    // No corp.json, no members.json written.
    expect(corpHasOpenClawAgent(corpRoot)).toBe(true);
  });
});
