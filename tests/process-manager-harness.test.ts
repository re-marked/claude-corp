import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProcessManager } from '../packages/daemon/src/process-manager.js';
import type { Member } from '../packages/shared/src/types/member.js';
import type { GlobalConfig } from '../packages/shared/src/types/global-config.js';

/**
 * Tests for ProcessManager's harness-aware agent registration. The fix
 * being pinned: claude-code agents (and any non-openclaw agent) should
 * NOT consume a gateway slot, NOT trigger an OpenClaw process spawn,
 * and should be marked ready immediately since dispatch goes through
 * the AgentHarness directly with no gateway round-trip.
 *
 * We don't drive the full OpenClaw spawn in tests — initCorpGateway
 * is only verified to the point where we can assert "gateway didn't
 * start" (status remains 'stopped'). The startup itself is exercised
 * by the existing daemon integration paths.
 */

const GLOBAL_CONFIG: GlobalConfig = {
  apiKeys: { anthropic: 'test-key' },
  daemon: { portRange: [18800, 18999], logLevel: 'info' },
  defaults: { model: 'claude-haiku-4-5', provider: 'anthropic' },
};

describe('ProcessManager — harness-aware registration', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = join(tmpdir(), `pm-harness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(corpRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function seedCorp(opts: { harness?: string }): void {
    writeFileSync(
      join(corpRoot, 'corp.json'),
      JSON.stringify({
        name: 'test',
        displayName: 'test',
        owner: 'mark',
        ceo: 'ceo',
        description: '',
        theme: 'corporate',
        defaultDmMode: 'jack',
        createdAt: new Date().toISOString(),
        ...(opts.harness ? { harness: opts.harness } : {}),
      }, null, 2),
      'utf-8',
    );
  }

  function seedMember(m: Partial<Member> & { id: string; displayName: string }): Member {
    const full: Member = {
      id: m.id,
      displayName: m.displayName,
      rank: m.rank ?? 'master',
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
    const path = join(corpRoot, 'members.json');
    let existing: Member[] = [];
    try { existing = JSON.parse(require('node:fs').readFileSync(path, 'utf-8')); } catch {}
    writeFileSync(path, JSON.stringify([...existing, full], null, 2), 'utf-8');
    if (full.agentDir) mkdirSync(join(corpRoot, full.agentDir), { recursive: true });
    return full;
  }

  describe('spawnAgent — per-agent harness routing', () => {
    it('returns mode=harness + status=ready for a claude-code agent', async () => {
      seedCorp({});
      seedMember({ id: 'ceo', displayName: 'CEO', harness: 'claude-code' });
      const pm = new ProcessManager(corpRoot, GLOBAL_CONFIG);

      const proc = await pm.spawnAgent('ceo');

      expect(proc.mode).toBe('harness');
      expect(proc.status).toBe('ready');
      expect(proc.port).toBe(0);
      expect(proc.gatewayToken).toBe('');
      expect(proc.model).toBe('claude-code');
    });

    it('returns mode=gateway for an openclaw agent (existing behavior preserved)', async () => {
      seedCorp({});
      seedMember({ id: 'ceo', displayName: 'CEO', harness: 'openclaw' });
      const pm = new ProcessManager(corpRoot, GLOBAL_CONFIG);

      const proc = await pm.spawnAgent('ceo');

      expect(proc.mode).toBe('gateway');
    });

    it('falls back to corp.harness when member has no harness field', async () => {
      seedCorp({ harness: 'claude-code' });
      seedMember({ id: 'ceo', displayName: 'CEO' }); // no per-member harness
      const pm = new ProcessManager(corpRoot, GLOBAL_CONFIG);

      const proc = await pm.spawnAgent('ceo');

      expect(proc.mode).toBe('harness');
      expect(proc.model).toBe('claude-code');
    });

    it('member.harness wins over corp.harness (per-agent override)', async () => {
      seedCorp({ harness: 'claude-code' });
      seedMember({ id: 'pilot', displayName: 'Pilot', harness: 'openclaw' });
      const pm = new ProcessManager(corpRoot, GLOBAL_CONFIG);

      const proc = await pm.spawnAgent('pilot');

      expect(proc.mode).toBe('gateway');
    });

    it('falls back to openclaw when neither member nor corp specifies a harness', async () => {
      seedCorp({});
      seedMember({ id: 'pilot', displayName: 'Pilot' });
      const pm = new ProcessManager(corpRoot, GLOBAL_CONFIG);

      const proc = await pm.spawnAgent('pilot');

      expect(proc.mode).toBe('gateway');
    });

    it('idempotent — repeated spawnAgent returns the same registered process', async () => {
      seedCorp({});
      seedMember({ id: 'ceo', displayName: 'CEO', harness: 'claude-code' });
      const pm = new ProcessManager(corpRoot, GLOBAL_CONFIG);

      const first = await pm.spawnAgent('ceo');
      const second = await pm.spawnAgent('ceo');

      expect(second).toBe(first);
    });
  });

  describe('initCorpGateway — skip start when no openclaw agents', () => {
    it('does not start the OpenClaw process when every agent is non-openclaw', async () => {
      seedCorp({ harness: 'claude-code' });
      seedMember({ id: 'ceo', displayName: 'CEO', harness: 'claude-code' });
      seedMember({ id: 'planner', displayName: 'Planner', harness: 'claude-code' });
      const pm = new ProcessManager(corpRoot, GLOBAL_CONFIG);

      await pm.initCorpGateway();

      // Gateway instance gets created (cheap — just object construction
      // + config read). What we care about: it never started, so no
      // OpenClaw subprocess is consuming RAM/ports for nothing.
      expect(pm.corpGateway).not.toBeNull();
      expect(pm.corpGateway!.getStatus()).toBe('stopped');
      expect(pm.corpGateway!.hasAgents()).toBe(false);
    });

    it('initializes gateway with no agents when corp.harness is claude-code and no per-member overrides', async () => {
      seedCorp({ harness: 'claude-code' });
      seedMember({ id: 'ceo', displayName: 'CEO' }); // inherits corp default
      const pm = new ProcessManager(corpRoot, GLOBAL_CONFIG);

      await pm.initCorpGateway();

      expect(pm.corpGateway!.hasAgents()).toBe(false);
    });
  });
});
