import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyHarnessSwitch } from '../packages/tui/src/utils/harness-switch.js';
import type { Member } from '../packages/shared/src/types/member.js';

/**
 * Tests for the TUI's applyHarnessSwitch — the same work cc-cli does
 * in cmdAgentSetHarness, extracted so both paths converge. Verifies
 * the three coordinated writes land correctly: members.json update,
 * agent config.json update (or graceful skip when absent), and the
 * reconcileAgentWorkspace call that migrates filenames + writes/moves
 * CLAUDE.md to match the target harness.
 */

describe('applyHarnessSwitch', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = join(tmpdir(), `harness-switch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(corpRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function seedMember(m: Partial<Member> & { id: string; displayName: string }): Member {
    const full: Member = {
      id: m.id,
      displayName: m.displayName,
      rank: m.rank ?? 'worker',
      status: m.status ?? 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: 'test',
      agentDir: m.agentDir ?? `agents/${m.id}/`,
      port: null,
      spawnedBy: 'mark',
      createdAt: new Date().toISOString(),
      ...(m.harness ? { harness: m.harness } : {}),
    };
    const membersPath = join(corpRoot, 'members.json');
    const existing = existsSync(membersPath)
      ? JSON.parse(readFileSync(membersPath, 'utf-8')) as Member[]
      : [];
    writeFileSync(membersPath, JSON.stringify([...existing, full], null, 2), 'utf-8');
    if (full.agentDir) {
      mkdirSync(join(corpRoot, full.agentDir), { recursive: true });
    }
    return full;
  }

  function readMembers(): Member[] {
    return JSON.parse(readFileSync(join(corpRoot, 'members.json'), 'utf-8')) as Member[];
  }

  it('updates members.json with the new harness', () => {
    const member = seedMember({ id: 'pilot', displayName: 'Pilot', harness: 'openclaw' });

    applyHarnessSwitch({ corpRoot, member, targetHarness: 'claude-code' });

    const after = readMembers().find(m => m.id === 'pilot')!;
    expect(after.harness).toBe('claude-code');
  });

  it('leaves other agents in members.json untouched', () => {
    seedMember({ id: 'alice', displayName: 'Alice', harness: 'openclaw' });
    const bob = seedMember({ id: 'bob', displayName: 'Bob', harness: 'openclaw' });
    seedMember({ id: 'carol', displayName: 'Carol', harness: 'claude-code' });

    applyHarnessSwitch({ corpRoot, member: bob, targetHarness: 'claude-code' });

    const after = readMembers();
    expect(after.find(m => m.id === 'alice')!.harness).toBe('openclaw');
    expect(after.find(m => m.id === 'bob')!.harness).toBe('claude-code');
    expect(after.find(m => m.id === 'carol')!.harness).toBe('claude-code');
  });

  it('updates the agent\'s config.json when present', () => {
    const member = seedMember({ id: 'pilot', displayName: 'Pilot' });
    writeFileSync(
      join(corpRoot, member.agentDir!, 'config.json'),
      JSON.stringify({ memberId: 'pilot', displayName: 'Pilot', harness: 'openclaw' }, null, 2),
      'utf-8',
    );

    applyHarnessSwitch({ corpRoot, member, targetHarness: 'claude-code' });

    const cfg = JSON.parse(readFileSync(join(corpRoot, member.agentDir!, 'config.json'), 'utf-8'));
    expect(cfg.harness).toBe('claude-code');
    expect(cfg.memberId).toBe('pilot'); // other fields preserved
  });

  it('silently skips config.json update when the file is absent', () => {
    const member = seedMember({ id: 'pilot', displayName: 'Pilot' });
    // No config.json written.

    expect(() =>
      applyHarnessSwitch({ corpRoot, member, targetHarness: 'claude-code' }),
    ).not.toThrow();
    expect(readMembers().find(m => m.id === 'pilot')!.harness).toBe('claude-code');
  });

  it('writes CLAUDE.md when switching to claude-code', () => {
    const member = seedMember({ id: 'pilot', displayName: 'Pilot', harness: 'openclaw' });

    const result = applyHarnessSwitch({ corpRoot, member, targetHarness: 'claude-code' });

    expect(result.claudeMdWritten).toBe(true);
    expect(existsSync(join(corpRoot, member.agentDir!, 'CLAUDE.md'))).toBe(true);
    const content = readFileSync(join(corpRoot, member.agentDir!, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# I am Pilot');
  });

  it('moves CLAUDE.md aside when switching away from claude-code', () => {
    const member = seedMember({ id: 'pilot', displayName: 'Pilot', harness: 'claude-code' });
    writeFileSync(join(corpRoot, member.agentDir!, 'CLAUDE.md'), 'existing content', 'utf-8');

    const result = applyHarnessSwitch({ corpRoot, member, targetHarness: 'openclaw' });

    expect(result.claudeMdBackedUp).toMatch(/CLAUDE\.md\.backup\./);
    expect(existsSync(join(corpRoot, member.agentDir!, 'CLAUDE.md'))).toBe(false);
  });

  it('migrates legacy filenames on switch (RULES.md → AGENTS.md)', () => {
    const member = seedMember({ id: 'pilot', displayName: 'Pilot', harness: 'openclaw' });
    writeFileSync(join(corpRoot, member.agentDir!, 'RULES.md'), 'rules content', 'utf-8');

    const result = applyHarnessSwitch({ corpRoot, member, targetHarness: 'claude-code' });

    expect(result.renamed).toEqual([{ from: 'RULES.md', to: 'AGENTS.md' }]);
    expect(existsSync(join(corpRoot, member.agentDir!, 'RULES.md'))).toBe(false);
    expect(readFileSync(join(corpRoot, member.agentDir!, 'AGENTS.md'), 'utf-8')).toBe('rules content');
  });

  it('resolves conflicts when both legacy and canonical names exist', () => {
    const member = seedMember({ id: 'pilot', displayName: 'Pilot', harness: 'openclaw' });
    writeFileSync(join(corpRoot, member.agentDir!, 'AGENTS.md'), 'canonical-initial', 'utf-8');
    writeFileSync(join(corpRoot, member.agentDir!, 'RULES.md'), 'legacy-later', 'utf-8');

    const result = applyHarnessSwitch({ corpRoot, member, targetHarness: 'claude-code' });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.from).toBe('RULES.md');
    // Reconciler keeps the newer file (by mtime) + backs up the older. A
    // .backup file exists for whichever one lost — matching prefix is
    // enough to assert the safety net fired.
    const afterFiles = readdirSync(join(corpRoot, member.agentDir!));
    const anyBackup = afterFiles.some(f => f.includes('.backup.'));
    expect(anyBackup).toBe(true);
  });

  it('returns empty reconcile result when member has no agentDir', () => {
    const member = seedMember({ id: 'ephemeral', displayName: 'Ephemeral' });
    // Blank out agentDir AFTER seed (seed already wrote it, but we can
    // simulate a member with no workspace by passing a stripped member
    // into applyHarnessSwitch directly).
    const stripped: Member = { ...member, agentDir: null as unknown as string };

    const result = applyHarnessSwitch({ corpRoot, member: stripped, targetHarness: 'claude-code' });

    expect(result.renamed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.claudeMdWritten).toBe(false);
    expect(result.claudeMdBackedUp).toBeNull();
    // members.json should still have been updated with the new harness
    expect(readMembers().find(m => m.id === 'ephemeral')!.harness).toBe('claude-code');
  });
});
