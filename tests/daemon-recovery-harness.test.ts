import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverCeoGateway } from '../packages/daemon/src/daemon-recovery.js';
import type { Daemon } from '../packages/daemon/src/daemon.js';
import type { AgentProcess } from '../packages/daemon/src/process-manager.js';

/**
 * Regression test for the CEO Gateway Recovery clock crashing
 * harness-mode CEOs. Before the fix, recoverCeoGateway pinged
 * `http://127.0.0.1:${agentProc.port}/v1/chat/completions` for ALL
 * CEOs — but harness-mode agents have port=0 (no listening gateway,
 * dispatch goes through subprocess). After 3 failed pings (90s of
 * recovery clock ticks), the harmless-but-portless CEO got marked
 * `status: 'crashed'`, and the next /cc/say dispatch saw "Agent CEO
 * is not online".
 */

describe('recoverCeoGateway — harness-mode CEO', () => {
  let corpRoot: string;
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    corpRoot = join(tmpdir(), `recovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(corpRoot, { recursive: true });
    writeFileSync(
      join(corpRoot, 'members.json'),
      JSON.stringify([
        {
          id: 'ceo',
          displayName: 'CEO',
          rank: 'master',
          status: 'active',
          type: 'agent',
          scope: 'corp',
          scopeId: 'test',
          agentDir: 'agents/ceo/',
          port: null,
          spawnedBy: 'mark',
          createdAt: new Date().toISOString(),
          harness: 'claude-code',
        },
      ], null, 2),
      'utf-8',
    );
    fetchSpy.mockReset();
  });

  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function makeDaemon(ceoProc: AgentProcess): Daemon {
    return {
      corpRoot,
      processManager: { getAgent: (id: string) => id === 'ceo' ? ceoProc : null },
      // Recovery references these but won't reach them in the harness path.
      openclawWS: null,
      globalConfig: { userGateway: undefined },
    } as unknown as Daemon;
  }

  function harnessCeoProc(): AgentProcess {
    return {
      memberId: 'ceo',
      displayName: 'CEO',
      port: 0,
      status: 'ready',
      gatewayToken: '',
      process: null,
      mode: 'harness',
      model: 'claude-code',
    };
  }

  it('does not ping a harness-mode CEO (no gateway exists to ping)', async () => {
    const ceoProc = harnessCeoProc();
    const daemon = makeDaemon(ceoProc);

    await recoverCeoGateway(daemon);

    // No fetch issued. Without the harness guard the call below would
    // hit http://127.0.0.1:0/v1/chat/completions — guaranteed failure.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not mark a healthy harness-mode CEO as crashed even after multiple ticks', async () => {
    const ceoProc = harnessCeoProc();
    const daemon = makeDaemon(ceoProc);

    // Fire the recovery clock 5 times (would be 5 failed pings + a
    // crash-mark in the old code). status should stay 'ready'.
    for (let i = 0; i < 5; i++) {
      await recoverCeoGateway(daemon);
    }

    expect(ceoProc.status).toBe('ready');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
