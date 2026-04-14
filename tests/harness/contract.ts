/**
 * Parameterized AgentHarness contract tests.
 *
 * Every harness implementation must pass these tests. Individual harness
 * test files import `runHarnessContract(factory, name)` and invoke it in
 * a top-level describe block — the contract enforces the universal shape
 * that Claude Corp's daemon relies on regardless of substrate.
 *
 * Keep this focused on what's universally true across harnesses. Anything
 * implementation-specific (response resolution, gateway selection, tool
 * scripting, etc.) stays in that harness's own test file.
 */

import { describe, it, expect } from 'vitest';
import {
  HarnessError,
  type AgentHarness,
  type DispatchOpts,
  type HarnessConfig,
} from '../../packages/daemon/src/harness/index.js';

const BASE_CONFIG: HarnessConfig = {
  corpRoot: '/tmp/does-not-exist',
  globalConfig: {
    apiKeys: {},
    daemon: { portRange: [18800, 18999], logLevel: 'info' },
    defaults: { model: 'mock', provider: 'mock' },
  },
};

export interface ContractHarnessFactory {
  /** Construct a fresh, un-initialized harness instance. */
  make: () => AgentHarness;
  /**
   * (Optional) DispatchOpts to use in "happy path" tests. If omitted, the
   * contract skips success-path tests for harnesses that require external
   * infrastructure (network, subprocess, etc.) that the test environment
   * can't satisfy.
   */
  happyPath?: {
    opts: DispatchOpts;
    /** Called inside the harness to register the agent if addAgent matters. */
    registerAgent?: (harness: AgentHarness) => Promise<void>;
  };
}

/**
 * Run the AgentHarness contract against a harness factory.
 *
 * @param factory  Opaque constructor for a fresh harness instance each test.
 * @param name     Display name used in the describe() block.
 */
export function runHarnessContract(factory: ContractHarnessFactory, name: string): void {
  describe(`AgentHarness contract: ${name}`, () => {
    describe('identity', () => {
      it('has a non-empty string name', () => {
        const h = factory.make();
        expect(typeof h.name).toBe('string');
        expect(h.name.length).toBeGreaterThan(0);
      });
    });

    describe('lifecycle', () => {
      it('init resolves', async () => {
        const h = factory.make();
        await expect(h.init(BASE_CONFIG)).resolves.not.toThrow();
      });

      it('shutdown resolves without prior init', async () => {
        const h = factory.make();
        await expect(h.shutdown()).resolves.not.toThrow();
      });

      it('shutdown after init resolves', async () => {
        const h = factory.make();
        await h.init(BASE_CONFIG);
        await expect(h.shutdown()).resolves.not.toThrow();
      });

      it('addAgent + removeAgent do not throw for any input', async () => {
        const h = factory.make();
        await h.init(BASE_CONFIG);
        await expect(
          h.addAgent({ agentId: 'ceo', displayName: 'CEO', workspace: '/tmp' }),
        ).resolves.not.toThrow();
        await expect(h.removeAgent('ceo')).resolves.not.toThrow();
        await expect(h.removeAgent('never-added')).resolves.not.toThrow();
      });
    });

    describe('health shape', () => {
      it('returns all required HarnessHealth fields', async () => {
        const h = factory.make();
        await h.init(BASE_CONFIG);
        const health = await h.health();
        expect(typeof health.ok).toBe('boolean');
        expect(health.name).toBe(h.name);
        expect(typeof health.uptimeMs).toBe('number');
        expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
        expect(typeof health.dispatches).toBe('number');
        expect(typeof health.errors).toBe('number');
        // lastDispatchAt is null OR a number
        expect(
          health.lastDispatchAt === null || typeof health.lastDispatchAt === 'number',
        ).toBe(true);
      });

      it('starts with zero dispatches and zero errors', async () => {
        const h = factory.make();
        await h.init(BASE_CONFIG);
        const health = await h.health();
        expect(health.dispatches).toBe(0);
        expect(health.errors).toBe(0);
        expect(health.lastDispatchAt).toBeNull();
      });
    });

    describe('cancellation', () => {
      it('pre-aborted signal rejects with HarnessError(aborted) before any work', async () => {
        const h = factory.make();
        await h.init(BASE_CONFIG);
        const ac = new AbortController();
        ac.abort();

        const opts: DispatchOpts = factory.happyPath?.opts
          ?? {
            agentId: 'ceo',
            message: 'hello',
            sessionKey: 'say:ceo:mark',
            context: {} as never,
          };

        await expect(h.dispatch({ ...opts, signal: ac.signal })).rejects.toBeInstanceOf(HarnessError);
        try {
          await h.dispatch({ ...opts, signal: ac.signal });
        } catch (err) {
          expect((err as HarnessError).category).toBe('aborted');
          expect((err as HarnessError).harnessName).toBe(h.name);
        }
      });
    });

    if (factory.happyPath) {
      describe('happy path', () => {
        const { opts, registerAgent } = factory.happyPath!;

        it('dispatch returns a DispatchResult with required shape', async () => {
          const h = factory.make();
          await h.init(BASE_CONFIG);
          if (registerAgent) await registerAgent(h);

          const result = await h.dispatch(opts);
          expect(typeof result.content).toBe('string');
          expect(typeof result.model).toBe('string');
          expect(typeof result.durationMs).toBe('number');
          expect(result.durationMs).toBeGreaterThanOrEqual(0);
          expect(Array.isArray(result.toolCalls)).toBe(true);
        });

        it('dispatch increments health.dispatches on success', async () => {
          const h = factory.make();
          await h.init(BASE_CONFIG);
          if (registerAgent) await registerAgent(h);

          const before = (await h.health()).dispatches;
          await h.dispatch(opts);
          const after = (await h.health()).dispatches;
          expect(after).toBe(before + 1);
        });

        it('dispatch updates health.lastDispatchAt', async () => {
          const h = factory.make();
          await h.init(BASE_CONFIG);
          if (registerAgent) await registerAgent(h);

          expect((await h.health()).lastDispatchAt).toBeNull();
          const tBefore = Date.now();
          await h.dispatch(opts);
          const tAfter = (await h.health()).lastDispatchAt;
          expect(tAfter).toBeGreaterThanOrEqual(tBefore);
        });
      });
    }
  });
}
