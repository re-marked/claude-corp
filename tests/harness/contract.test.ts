/**
 * Runs the parameterized AgentHarness contract against each concrete
 * implementation. Adding a new harness means plugging it in here — no
 * need to rewrite the universal invariants.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  MockHarness,
  OpenClawHarness,
  HarnessRouter,
  ClaudeCodeHarness,
  type OpenClawHarnessDeps,
  type ClaudeChildProcess,
  type ClaudeSpawnFn,
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

// --- ClaudeCodeHarness (mocked subprocess) ---------------------------------

class FakeClaudeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  killSignal: NodeJS.Signals | number | null = null;

  emitEvent(event: object): void {
    this.stdout.write(JSON.stringify(event) + '\n');
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', code, signal);
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal ?? null;
    setImmediate(() => this.exit(null, typeof signal === 'string' ? signal : 'SIGTERM'));
    return true;
  }
}

function makeContractSpawner(): ClaudeSpawnFn {
  return (binary, args) => {
    const proc = new FakeClaudeProcess();
    setImmediate(() => {
      if (args.includes('--version')) {
        proc.stdout.write('2.1.107 (mock)\n');
        proc.exit(0);
        return;
      }
      // Minimal happy-path stream
      proc.emitEvent({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-mock', tools: [] });
      proc.emitEvent({ type: 'stream_event', event: { type: 'message_start', message: {} } });
      proc.emitEvent({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      });
      proc.emitEvent({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'contract happy path' } },
      });
      proc.emitEvent({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      proc.emitEvent({ type: 'stream_event', event: { type: 'message_stop' } });
      proc.emitEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5,
        result: 'contract happy path',
        session_id: 's',
      });
      proc.exit(0);
    });
    return proc as unknown as ClaudeChildProcess;
  };
}

runHarnessContract(
  {
    make: () => new ClaudeCodeHarness({ spawn: makeContractSpawner() }),
    happyPath: {
      opts: {
        agentId: 'ceo',
        message: 'hello',
        sessionKey: 'say:ceo:mark',
        context: { corpRoot: '/tmp', agentDir: 'agents/ceo' } as never,
      },
    },
  },
  'ClaudeCodeHarness',
);
