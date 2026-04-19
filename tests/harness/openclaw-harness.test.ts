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
  // Minimal FragmentContext — fragments like history/workspace/brain
  // read array/string fields on this and crash if they're undefined.
  // Values don't matter for abort-propagation tests; shape does.
  context: {
    agentDir: '/tmp/agent-ceo',
    corpRoot: '/tmp/corp',
    channelName: 'dm-mark-ceo',
    channelMembers: ['CEO', 'Mark'],
    corpMembers: [],
    recentHistory: [],
    agentDisplayName: 'CEO',
    channelKind: 'direct',
    supervisorName: null,
    harness: 'openclaw',
  } as never,
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

  describe('dispatch — caller abort propagation', () => {
    // These prove the PR 1 invariant: when opts.signal fires, openclaw-
    // harness calls wsClient.chatAbort server-side so the provider
    // stream + in-flight tools cease. Without this, "interrupt" in the
    // TUI looked like it worked but the agent kept running in the
    // background and its side effects landed anyway.

    /**
     * Build a WS-shaped fake that simulates a long-running chat.send
     * and spies on chat.abort. `resolveSend` / `emitLifecycle` let
     * tests drive the timing of runId arrival and natural completion.
     */
    function makeAbortableWS(opts: {
      runIdOnSend?: string;
      resolveSendImmediately?: boolean;
    } = {}) {
      const { runIdOnSend = 'run-xyz', resolveSendImmediately = true } = opts;
      const chatAbort = vi.fn(async () => ({ ok: true, aborted: true, runIds: [runIdOnSend] }));
      let resolveSend: (v: { runId: string }) => void = () => {};
      const chatSend = vi.fn(
        () => resolveSendImmediately
          ? Promise.resolve({ runId: runIdOnSend })
          : new Promise<{ runId: string }>((r) => { resolveSend = r; }),
      );
      return {
        ws: {
          isConnected: () => true,
          chatSend,
          chatAbort,
          // dispatchViaWebSocket subscribes to these — return no-op
          // unsubscribes. We never emit end events, so the dispatch
          // promise stays pending forever (which is what we want —
          // the test fires abort, not a natural completion).
          onAgentEvent: vi.fn(() => () => {}),
          onChatEvent: vi.fn(() => () => {}),
        } as unknown as OpenClawWS,
        chatAbort,
        chatSend,
        resolveSend: (v: { runId: string } = { runId: runIdOnSend }) => resolveSend(v),
      };
    }

    it('fires chat.abort with the captured runId when signal fires after chatSend resolves', async () => {
      const { ws, chatAbort } = makeAbortableWS({ runIdOnSend: 'run-42', resolveSendImmediately: true });
      deps = makeDeps({ getCorpGatewayWS: () => ws });
      harness = new OpenClawHarness(deps);
      await harness.init(BASE_CONFIG);

      const ac = new AbortController();
      const dispatchP = harness.dispatch({ ...BASE_OPTS, signal: ac.signal });
      // Yield so chatSend resolves → onRunStarted fires → capturedRunId is set
      await new Promise((r) => setImmediate(r));
      ac.abort();

      await expect(dispatchP).rejects.toMatchObject({ category: 'aborted' });
      expect(chatAbort).toHaveBeenCalledTimes(1);
      expect(chatAbort).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: 'say:ceo:mark',
          runId: 'run-42',
          stopReason: 'caller-abort',
        }),
      );
    });

    it('falls back to sessionKey-only abort when signal fires before runId arrives', async () => {
      // chatSend stays pending — no runId yet — so the abort listener
      // must fire without one, then the onRunStarted replay fires a
      // second abort when the runId finally arrives.
      const { ws, chatAbort, resolveSend } = makeAbortableWS({
        runIdOnSend: 'run-late',
        resolveSendImmediately: false,
      });
      deps = makeDeps({ getCorpGatewayWS: () => ws });
      harness = new OpenClawHarness(deps);
      await harness.init(BASE_CONFIG);

      const ac = new AbortController();
      const dispatchP = harness.dispatch({ ...BASE_OPTS, signal: ac.signal });
      await new Promise((r) => setImmediate(r));
      ac.abort(); // runId not yet captured — first chat.abort is sessionKey-only

      await expect(dispatchP).rejects.toMatchObject({ category: 'aborted' });
      // First call — no runId in params, sessionKey only
      expect(chatAbort.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ sessionKey: 'say:ceo:mark', stopReason: 'caller-abort' }),
      );
      expect(chatAbort.mock.calls[0]?.[0]?.runId).toBeUndefined();

      // Replay — chatSend finally resolves, onRunStarted sees
      // abortIntentFired=true and fires a precise abort with the runId.
      resolveSend();
      await new Promise((r) => setImmediate(r));
      expect(chatAbort).toHaveBeenCalledTimes(2);
      expect(chatAbort.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ sessionKey: 'say:ceo:mark', runId: 'run-late' }),
      );
    });

    it('does not call chat.abort when dispatch completes naturally', async () => {
      // Sanity: chatAbort must only fire on caller abort, not on normal
      // teardown. Without this guard, a spurious abort could interrupt
      // sibling runs on the same session.
      const { ws, chatAbort } = makeAbortableWS();
      deps = makeDeps({ getCorpGatewayWS: () => ws });
      harness = new OpenClawHarness(deps);
      await harness.init(BASE_CONFIG);

      const dispatchP = harness.dispatch({ ...BASE_OPTS });
      // Never abort, never resolve — let the promise hang and just verify
      // the side effect hasn't happened. Short wait to make sure any
      // scheduled work runs.
      await new Promise((r) => setTimeout(r, 20));
      expect(chatAbort).not.toHaveBeenCalled();

      // Clean up — don't leak a pending rejection handler.
      dispatchP.catch(() => void 0);
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
