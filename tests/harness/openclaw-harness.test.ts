import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OpenClawHarness,
  HarnessError,
  type OpenClawHarnessDeps,
} from '../../packages/daemon/src/harness/index.js';
import type { AgentProcess, ProcessManager } from '../../packages/daemon/src/process-manager.js';
import type { OpenClawWS } from '../../packages/daemon/src/openclaw-ws.js';

/**
 * OpenClawHarness is a thin adapter; tests exercise the behaviors the
 * harness itself owns (unknown_agent, cancellation, gateway selection,
 * health telemetry) rather than the underlying dispatch layer (WS/HTTP
 * protocols), which is covered by dispatch-resilience.test.ts + exercised
 * via integration in real corps.
 */

const BASE_CONFIG = {
  corpRoot: '/tmp/does-not-exist',
  globalConfig: {
    apiKeys: {},
    daemon: { portRange: [18800, 18999] as [number, number], logLevel: 'info' as const },
    defaults: { model: 'openclaw', provider: 'openclaw' },
  },
};

function makeAgent(overrides: Partial<AgentProcess> = {}): AgentProcess {
  return {
    memberId: 'ceo',
    displayName: 'CEO',
    port: 18801,
    status: 'ready',
    gatewayToken: 'tok',
    process: null,
    mode: 'gateway',
    model: 'openclaw:main',
    ...overrides,
  };
}

function makeProcessManager(agents: AgentProcess[]): ProcessManager {
  const map = new Map(agents.map((a) => [a.memberId, a]));
  return {
    getAgent: (id: string) => map.get(id),
    listAgents: () => [...map.values()],
  } as unknown as ProcessManager;
}

function makeWS(connected: boolean): OpenClawWS {
  return { isConnected: () => connected } as unknown as OpenClawWS;
}

function makeDeps(overrides: Partial<OpenClawHarnessDeps> = {}): OpenClawHarnessDeps {
  return {
    processManager: makeProcessManager([makeAgent()]),
    getUserGatewayWS: () => null,
    getCorpGatewayWS: () => null,
    ...overrides,
  };
}

const BASE_OPTS = {
  agentId: 'ceo',
  message: 'hello',
  sessionKey: 'say:ceo:mark',
  context: {} as never,
};

describe('OpenClawHarness', () => {
  let harness: OpenClawHarness;
  let deps: OpenClawHarnessDeps;

  beforeEach(async () => {
    deps = makeDeps();
    harness = new OpenClawHarness(deps);
    await harness.init(BASE_CONFIG);
  });

  describe('lifecycle', () => {
    it('has name "openclaw"', () => {
      expect(harness.name).toBe('openclaw');
    });

    it('init + shutdown are safe to call without side effects on deps', async () => {
      await expect(harness.init(BASE_CONFIG)).resolves.not.toThrow();
      await expect(harness.shutdown()).resolves.not.toThrow();
    });

    it('addAgent / removeAgent are no-ops in PR 1', async () => {
      // Lifecycle stays with ProcessManager + CorpGateway; verify no throw.
      await expect(
        harness.addAgent({ agentId: 'x', displayName: 'X', workspace: '/tmp' }),
      ).resolves.not.toThrow();
      await expect(harness.removeAgent('x')).resolves.not.toThrow();
    });
  });

  describe('health', () => {
    it('ok: false when neither gateway is connected', async () => {
      const h = await harness.health();
      expect(h.ok).toBe(false);
      expect(h.name).toBe('openclaw');
      expect(h.info).toMatchObject({
        userGatewayConnected: false,
        corpGatewayConnected: false,
      });
    });

    it('ok: true when user gateway is connected', async () => {
      deps = makeDeps({ getUserGatewayWS: () => makeWS(true) });
      harness = new OpenClawHarness(deps);
      await harness.init(BASE_CONFIG);
      const h = await harness.health();
      expect(h.ok).toBe(true);
      expect(h.info).toMatchObject({ userGatewayConnected: true, corpGatewayConnected: false });
    });

    it('ok: true when corp gateway is connected', async () => {
      deps = makeDeps({ getCorpGatewayWS: () => makeWS(true) });
      harness = new OpenClawHarness(deps);
      await harness.init(BASE_CONFIG);
      const h = await harness.health();
      expect(h.ok).toBe(true);
      expect(h.info).toMatchObject({ userGatewayConnected: false, corpGatewayConnected: true });
    });

    it('info.agentCount reflects processManager', async () => {
      deps = makeDeps({
        processManager: makeProcessManager([
          makeAgent(),
          makeAgent({ memberId: 'herald', displayName: 'Herald' }),
        ]),
      });
      harness = new OpenClawHarness(deps);
      await harness.init(BASE_CONFIG);
      const h = await harness.health();
      expect(h.info?.agentCount).toBe(2);
    });
  });

  describe('dispatch — error paths', () => {
    it('throws unknown_agent when agent not registered with process manager', async () => {
      await expect(
        harness.dispatch({ ...BASE_OPTS, agentId: 'ghost' }),
      ).rejects.toBeInstanceOf(HarnessError);
      try {
        await harness.dispatch({ ...BASE_OPTS, agentId: 'ghost' });
      } catch (err) {
        const e = err as HarnessError;
        expect(e.category).toBe('unknown_agent');
        expect(e.harnessName).toBe('openclaw');
      }
    });

    it('increments health.errors on unknown_agent', async () => {
      await expect(harness.dispatch({ ...BASE_OPTS, agentId: 'ghost' })).rejects.toThrow();
      const h = await harness.health();
      expect(h.errors).toBeGreaterThanOrEqual(1);
    });

    it('rejects with aborted category when signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(
        harness.dispatch({ ...BASE_OPTS, signal: ac.signal }),
      ).rejects.toMatchObject({ category: 'aborted', harnessName: 'openclaw' });
    });
  });

  describe('dispatch — gateway selection', () => {
    it('queries user gateway for remote-mode agent', async () => {
      const getUser = vi.fn(() => null);
      const getCorp = vi.fn(() => null);
      deps = makeDeps({
        processManager: makeProcessManager([makeAgent({ mode: 'remote' })]),
        getUserGatewayWS: getUser,
        getCorpGatewayWS: getCorp,
      });
      harness = new OpenClawHarness(deps);
      await harness.init(BASE_CONFIG);
      // Dispatch will fail downstream (no real WS / no real port) but we only
      // care which getter was invoked during gateway selection.
      await harness.dispatch(BASE_OPTS).catch(() => void 0);
      expect(getUser).toHaveBeenCalled();
      expect(getCorp).not.toHaveBeenCalled();
    });

    it('queries corp gateway for gateway-mode agent', async () => {
      const getUser = vi.fn(() => null);
      const getCorp = vi.fn(() => null);
      deps = makeDeps({
        processManager: makeProcessManager([makeAgent({ mode: 'gateway' })]),
        getUserGatewayWS: getUser,
        getCorpGatewayWS: getCorp,
      });
      harness = new OpenClawHarness(deps);
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS).catch(() => void 0);
      expect(getCorp).toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
    });

    it('queries corp gateway for local-mode agent', async () => {
      const getUser = vi.fn(() => null);
      const getCorp = vi.fn(() => null);
      deps = makeDeps({
        processManager: makeProcessManager([makeAgent({ mode: 'local' })]),
        getUserGatewayWS: getUser,
        getCorpGatewayWS: getCorp,
      });
      harness = new OpenClawHarness(deps);
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS).catch(() => void 0);
      expect(getCorp).toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
    });
  });

  describe('telemetry', () => {
    it('health.dispatches counts attempts (even failed ones)', async () => {
      await harness.dispatch({ ...BASE_OPTS, agentId: 'ghost' }).catch(() => void 0);
      await harness.dispatch({ ...BASE_OPTS, agentId: 'ghost' }).catch(() => void 0);
      const h = await harness.health();
      expect(h.dispatches).toBe(2);
    });

    it('health.lastDispatchAt updates after each attempt', async () => {
      expect((await harness.health()).lastDispatchAt).toBeNull();
      const before = Date.now();
      await harness.dispatch({ ...BASE_OPTS, agentId: 'ghost' }).catch(() => void 0);
      const h = await harness.health();
      expect(h.lastDispatchAt).toBeGreaterThanOrEqual(before);
    });
  });
});
