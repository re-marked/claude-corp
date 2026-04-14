/**
 * Runs the parameterized AgentHarness contract against each concrete
 * implementation. Adding a new harness means plugging it in here — no
 * need to rewrite the universal invariants.
 */

import {
  MockHarness,
  OpenClawHarness,
  HarnessRouter,
  type OpenClawHarnessDeps,
} from '../../packages/daemon/src/harness/index.js';
import type { AgentProcess, ProcessManager } from '../../packages/daemon/src/process-manager.js';
import { runHarnessContract } from './contract.js';

// --- MockHarness ------------------------------------------------------------

runHarnessContract(
  {
    make: () => new MockHarness({ default: { content: 'hi', model: 'mock-v1' } }),
    happyPath: {
      opts: {
        agentId: 'ceo',
        message: 'hello',
        sessionKey: 'say:ceo:mark',
        context: {} as never,
      },
    },
  },
  'MockHarness',
);

// --- OpenClawHarness (mocked deps, no happy path) ---------------------------

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

runHarnessContract(
  {
    make: () => {
      const deps: OpenClawHarnessDeps = {
        processManager: makeProcessManager([makeAgent()]),
        getUserGatewayWS: () => null,
        getCorpGatewayWS: () => null,
      };
      return new OpenClawHarness(deps);
    },
    // No happyPath: OpenClawHarness requires a real WS or HTTP endpoint to
    // produce a successful dispatch, which we don't spin up in unit tests.
    // dispatch-resilience.test.ts + integration smoke tests cover that
    // surface; the contract here just verifies lifecycle + cancellation +
    // health shape against the same interface.
  },
  'OpenClawHarness',
);

// --- HarnessRouter (wrapping a single MockHarness) --------------------------

runHarnessContract(
  {
    make: () => {
      const inner = new MockHarness({ default: { content: 'router happy path', model: 'mock-v1' } });
      return new HarnessRouter({
        harnesses: new Map([['mock', inner]]),
        resolveHarness: () => 'mock',
        fallbackHarness: 'mock',
      });
    },
    happyPath: {
      opts: {
        agentId: 'ceo',
        message: 'hello',
        sessionKey: 'say:ceo:mark',
        context: {} as never,
      },
    },
  },
  'HarnessRouter',
);
