import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProcessManager } from '../packages/daemon/src/process-manager.js';
import { hireAgent } from '../packages/daemon/src/hire.js';
import type { GlobalConfig } from '../packages/shared/src/types/global-config.js';

/**
 * Regression for the offline-agents bug Mark hit at 15:06 on
 * 2026-04-15: in a corp where corp.json has harness='claude-code',
 * agents hired AFTER daemon startup (Failsafe, Janitor, Warden,
 * Herald, Planner — all bootstrapped via hireAgent) were getting
 * registered as mode='gateway' instead of mode='harness'. The
 * subsequent dispatch path errored "Agent X is not online" because
 * agentProc.status was 'starting' or 'stopped' (corp gateway never
 * became ready in a corp with no openclaw agents to actually serve).
 *
 * The fix: hireAgent now branches on harness — claude-code agents
 * call registerHarnessAgent (status='ready', mode='harness',
 * dispatched directly through HarnessRouter), while openclaw agents
 * keep the existing registerGatewayAgent path. Mirrors the same
 * branching `processManager.spawnAgent` does on daemon startup —
 * which is why the CEO worked but every system agent didn't.
 */

const GLOBAL_CONFIG: GlobalConfig = {
  apiKeys: { anthropic: 'test-key' },
  daemon: { portRange: [7800, 7900], logLevel: 'info' },
  defaults: { model: 'claude-haiku-4-5', provider: 'anthropic' },
};

function setupCorp(corpRoot: string, opts: { harness: 'openclaw' | 'claude-code'; ceoRank?: string }) {
  mkdirSync(corpRoot, { recursive: true });
  writeFileSync(join(corpRoot, 'corp.json'), JSON.stringify({
    name: 'test-corp',
    displayName: 'Test Corp',
    theme: 'corporate',
    harness: opts.harness,
  }), 'utf-8');
  writeFileSync(join(corpRoot, 'members.json'), JSON.stringify([
    {
      id: 'mark',
      displayName: 'Mark',
      rank: 'owner',
      status: 'active',
      type: 'user',
      scope: 'corp',
      scopeId: 'test-corp',
      spawnedBy: 'mark',
      port: null,
    },
    {
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: 'test-corp',
      agentDir: 'agents/ceo/',
      spawnedBy: 'mark',
      port: null,
      harness: opts.harness,
    },
  ]), 'utf-8');
  writeFileSync(join(corpRoot, 'channels.json'), JSON.stringify([
    {
      id: 'general',
      name: 'general',
      kind: 'channel',
      scope: 'corp',
      scopeId: 'test-corp',
      memberIds: ['mark', 'ceo'],
      createdAt: new Date().toISOString(),
    },
    {
      id: 'tasks',
      name: 'tasks',
      kind: 'channel',
      scope: 'corp',
      scopeId: 'test-corp',
      memberIds: ['mark', 'ceo'],
      createdAt: new Date().toISOString(),
    },
    {
      id: 'logs',
      name: 'logs',
      kind: 'channel',
      scope: 'corp',
      scopeId: 'test-corp',
      memberIds: ['mark', 'ceo'],
      createdAt: new Date().toISOString(),
    },
  ]), 'utf-8');
}

interface StubDaemon {
  corpRoot: string;
  globalConfig: GlobalConfig;
  processManager: ProcessManager;
}

function makeDaemon(corpRoot: string): StubDaemon {
  return {
    corpRoot,
    globalConfig: GLOBAL_CONFIG,
    processManager: new ProcessManager(corpRoot, GLOBAL_CONFIG),
  };
}

describe('hireAgent — harness-aware registration', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = join(tmpdir(), `hire-harness-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  });

  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch {}
  });

  it('claude-code corp: hired worker registers as mode=harness, status=ready', async () => {
    setupCorp(corpRoot, { harness: 'claude-code' });
    const daemon = makeDaemon(corpRoot);
    const harnessSpy = vi.spyOn(daemon.processManager, 'registerHarnessAgent');
    const gatewaySpy = vi.spyOn(daemon.processManager, 'registerGatewayAgent');

    const { member } = await hireAgent(daemon as unknown as Parameters<typeof hireAgent>[0], {
      creatorId: 'ceo',
      agentName: 'failsafe',
      displayName: 'Failsafe',
      rank: 'worker',
    });

    expect(harnessSpy).toHaveBeenCalledOnce();
    expect(harnessSpy).toHaveBeenCalledWith(member.id, expect.objectContaining({ id: member.id }), 'claude-code');
    expect(gatewaySpy).not.toHaveBeenCalled();

    const proc = daemon.processManager.getAgent(member.id);
    expect(proc).toBeDefined();
    expect(proc!.mode).toBe('harness');
    expect(proc!.status).toBe('ready');
  });

  it('claude-code corp: per-agent harness=claude-code overrides registers as harness', async () => {
    setupCorp(corpRoot, { harness: 'openclaw' }); // corp default is openclaw
    const daemon = makeDaemon(corpRoot);
    const harnessSpy = vi.spyOn(daemon.processManager, 'registerHarnessAgent');

    const { member } = await hireAgent(daemon as unknown as Parameters<typeof hireAgent>[0], {
      creatorId: 'ceo',
      agentName: 'cc-worker',
      displayName: 'CC Worker',
      rank: 'worker',
      harness: 'claude-code', // explicit override
    });

    expect(harnessSpy).toHaveBeenCalledOnce();
    const proc = daemon.processManager.getAgent(member.id);
    expect(proc!.mode).toBe('harness');
    expect(proc!.status).toBe('ready');
  });

  it('identityContent is written to IDENTITY.md verbatim for Partner hires (1.9.2 pass-through)', async () => {
    // HireOpts.identityContent (added in 1.9.2 for Sexton's caretaker
    // voice) threads through hireAgent → setupAgentWorkspace → the
    // workspace's IDENTITY.md file. Without this test, a future
    // refactor of hire.ts could silently drop the field and the
    // regression would only surface when a founder noticed an
    // agent's IDENTITY.md showed the generic template instead of the
    // role-specific voice. This pin is cheap + catches real drift.
    setupCorp(corpRoot, { harness: 'claude-code' });
    const daemon = makeDaemon(corpRoot);
    const customIdentity = '# Custom Identity\n\nI am a test Partner with a specific voice.\n';

    const { member } = await hireAgent(daemon as unknown as Parameters<typeof hireAgent>[0], {
      creatorId: 'ceo',
      agentName: 'voiced',
      displayName: 'Voiced',
      rank: 'worker',
      kind: 'partner', // Partners get IDENTITY.md; Employees skip it per 1.1
      identityContent: customIdentity,
    });

    expect(member.agentDir).toBeTruthy();
    const identityPath = join(corpRoot, member.agentDir!, 'IDENTITY.md');
    expect(existsSync(identityPath)).toBe(true);
    expect(readFileSync(identityPath, 'utf-8')).toBe(customIdentity);
  });

  it('identityContent absent: Partner falls back to generic defaultIdentity template', async () => {
    // Negative pin — when the caller omits identityContent, setup-
    // AgentWorkspace's existing default kicks in (defaultIdentity
    // template with displayName + rank interpolated). This guards
    // against someone "simplifying" the optional field by making it
    // required, which would break the existing non-Sexton hire paths.
    setupCorp(corpRoot, { harness: 'claude-code' });
    const daemon = makeDaemon(corpRoot);

    const { member } = await hireAgent(daemon as unknown as Parameters<typeof hireAgent>[0], {
      creatorId: 'ceo',
      agentName: 'plain',
      displayName: 'Plain',
      rank: 'worker',
      kind: 'partner',
      // identityContent: undefined
    });

    const identityPath = join(corpRoot, member.agentDir!, 'IDENTITY.md');
    expect(existsSync(identityPath)).toBe(true);
    const onDisk = readFileSync(identityPath, 'utf-8');
    // Default template carries the displayName in the Basics section —
    // if this assertion fails, either the default template broke OR
    // the pass-through path started leaking custom content from an
    // earlier test's bleed. Both are real bugs.
    expect(onDisk).toContain('**Name:** Plain');
    expect(onDisk).not.toContain('I am a test Partner with a specific voice.');
  });

  it('openclaw corp without ready gateway: hired worker still uses registerGatewayAgent', async () => {
    setupCorp(corpRoot, { harness: 'openclaw' });
    const daemon = makeDaemon(corpRoot);
    const harnessSpy = vi.spyOn(daemon.processManager, 'registerHarnessAgent');
    const gatewaySpy = vi.spyOn(daemon.processManager, 'registerGatewayAgent');

    // No initCorpGateway → corpGateway is null. hireAgent's openclaw path
    // should still call registerGatewayAgent (which handles the null
    // gateway by registering with status='stopped') — important: the
    // bug we're guarding against is using registerGatewayAgent for
    // claude-code agents, not failing back from gateway when null.
    const { member } = await hireAgent(daemon as unknown as Parameters<typeof hireAgent>[0], {
      creatorId: 'ceo',
      agentName: 'oc-worker',
      displayName: 'OC Worker',
      rank: 'worker',
    });

    expect(gatewaySpy).toHaveBeenCalledOnce();
    expect(harnessSpy).not.toHaveBeenCalled();
    const proc = daemon.processManager.getAgent(member.id);
    expect(proc!.mode).toBe('gateway');
  });
});
