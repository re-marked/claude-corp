import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfNamingFragment } from '../packages/daemon/src/fragments/self-naming.js';
import type { FragmentContext } from '../packages/daemon/src/fragments/types.js';
import type { Member } from '../packages/shared/src/index.js';

/**
 * Coverage for the self-naming fragment (Project 1.10.3).
 *
 * Two surfaces:
 *   - applies()  — selection logic; must fire only for fresh
 *                  Employees with displayName === id.
 *   - render()   — produces the prompt with role label, slug, and
 *                  parent-as-sibling line when applicable.
 */

describe('selfNamingFragment', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'self-naming-fragment-'));
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      // Windows fs-handle races
    }
  });

  function makeCtx(overrides: Partial<FragmentContext> = {}): FragmentContext {
    return {
      agentDir: '/tmp/agent',
      corpRoot,
      channelName: 'general',
      channelMembers: [],
      corpMembers: [],
      recentHistory: [],
      agentMemberId: 'backend-engineer-ab',
      agentDisplayName: 'backend-engineer-ab',
      agentKind: 'employee',
      agentRole: 'backend-engineer',
      channelKind: 'direct',
      supervisorName: null,
      ...overrides,
    };
  }

  // ─── applies() selection ──────────────────────────────────────────

  it('applies for fresh Employee (displayName === slug)', () => {
    const ctx = makeCtx();
    expect(selfNamingFragment.applies(ctx)).toBe(true);
  });

  it('does not apply once the Employee renames (displayName !== slug)', () => {
    const ctx = makeCtx({ agentDisplayName: 'Toast' });
    expect(selfNamingFragment.applies(ctx)).toBe(false);
  });

  it('does not apply for Partners', () => {
    const ctx = makeCtx({ agentKind: 'partner' });
    expect(selfNamingFragment.applies(ctx)).toBe(false);
  });

  it('does not apply when agentKind is missing', () => {
    const ctx = makeCtx({ agentKind: undefined });
    expect(selfNamingFragment.applies(ctx)).toBe(false);
  });

  it('does not apply when agentMemberId is missing', () => {
    const ctx = makeCtx({ agentMemberId: undefined, agentDisplayName: '' });
    expect(selfNamingFragment.applies(ctx)).toBe(false);
  });

  // ─── render() output ──────────────────────────────────────────────

  it('renders slug + role label + rename CTA', () => {
    const ctx = makeCtx();
    const out = selfNamingFragment.render(ctx);
    expect(out).toContain('backend-engineer-ab');
    expect(out).toContain('Backend Engineer');
    expect(out).toContain('cc-cli whoami rename');
    expect(out).toContain('--agent backend-engineer-ab');
  });

  it('renders sibling line when parent slot has chosen a name', () => {
    const members: Member[] = [
      {
        id: 'backend-engineer-ab',
        displayName: 'backend-engineer-ab',
        rank: 'worker',
        status: 'active',
        type: 'agent',
        scope: 'corp',
        scopeId: '',
        agentDir: 'agents/backend-engineer-ab/',
        port: null,
        spawnedBy: null,
        createdAt: '2026-04-25T15:00:00.000Z',
        kind: 'employee',
        role: 'backend-engineer',
        parentSlot: 'backend-engineer-bd',
        generation: 3,
      },
      {
        id: 'backend-engineer-bd',
        displayName: 'Toast', // parent has chosen a name
        rank: 'worker',
        status: 'active',
        type: 'agent',
        scope: 'corp',
        scopeId: '',
        agentDir: 'agents/backend-engineer-bd/',
        port: null,
        spawnedBy: null,
        createdAt: '2026-04-25T10:00:00.000Z',
        kind: 'employee',
        role: 'backend-engineer',
      },
    ];
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify(members), 'utf-8');

    const out = selfNamingFragment.render(makeCtx());
    expect(out).toContain('Your sibling: **Toast**');
  });

  it('omits sibling line when parent slot is unset (gen 0)', () => {
    const members: Member[] = [
      {
        id: 'backend-engineer-aa',
        displayName: 'backend-engineer-aa',
        rank: 'worker',
        status: 'active',
        type: 'agent',
        scope: 'corp',
        scopeId: '',
        agentDir: 'agents/backend-engineer-aa/',
        port: null,
        spawnedBy: null,
        createdAt: '2026-04-25T10:00:00.000Z',
        kind: 'employee',
        role: 'backend-engineer',
        // parentSlot: undefined → gen 0 first-of-lineage
      },
    ];
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify(members), 'utf-8');

    const out = selfNamingFragment.render(
      makeCtx({ agentMemberId: 'backend-engineer-aa', agentDisplayName: 'backend-engineer-aa' }),
    );
    expect(out).not.toContain('Your sibling');
  });

  it('does not crash when members.json is unreadable (best-effort filesystem)', () => {
    rmSync(join(corpRoot, 'members.json'));
    // Fragment should still render — just without a sibling line.
    const out = selfNamingFragment.render(makeCtx());
    expect(out).toContain('backend-engineer-ab');
    expect(out).not.toContain('Your sibling');
  });
});
