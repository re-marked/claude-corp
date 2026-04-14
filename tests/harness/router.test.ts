import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HarnessRouter,
  MockHarness,
  HarnessError,
  type AgentHarness,
  type AgentSpec,
  type DispatchOpts,
} from '../../packages/daemon/src/harness/index.js';

const BASE_CONFIG = {
  corpRoot: '/tmp/does-not-exist',
  globalConfig: {
    apiKeys: {},
    daemon: { portRange: [18800, 18999] as [number, number], logLevel: 'info' as const },
    defaults: { model: 'mock', provider: 'mock' },
  },
};

const BASE_OPTS = (overrides: Partial<DispatchOpts> = {}): DispatchOpts => ({
  agentId: 'ceo',
  message: 'hello',
  sessionKey: 'say:ceo:mark',
  context: {} as never,
  ...overrides,
});

function makeHarnesses(
  entries: Record<string, AgentHarness>,
): Map<string, AgentHarness> {
  return new Map(Object.entries(entries));
}

describe('HarnessRouter', () => {
  describe('construction', () => {
    it('throws when the harness map is empty', () => {
      expect(
        () => new HarnessRouter({
          harnesses: new Map(),
          resolveHarness: () => undefined,
        }),
      ).toThrow(/at least one underlying harness/);
    });

    it('accepts a single-harness configuration', () => {
      expect(
        () => new HarnessRouter({
          harnesses: makeHarnesses({ mock: new MockHarness() }),
          resolveHarness: () => undefined,
        }),
      ).not.toThrow();
    });
  });

  describe('resolution chain', () => {
    let primary: MockHarness;
    let secondary: MockHarness;
    let router: HarnessRouter;
    let resolveHarness: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      primary = new MockHarness({ default: { content: 'primary says hi' } });
      secondary = new MockHarness({ default: { content: 'secondary says hi' } });
      resolveHarness = vi.fn<(agentId: string) => string | undefined>(() => undefined);
      router = new HarnessRouter({
        harnesses: makeHarnesses({ primary, secondary }),
        resolveHarness,
        fallbackHarness: 'primary',
      });
      await router.init(BASE_CONFIG);
    });

    it('falls back when resolveHarness returns undefined', async () => {
      const result = await router.dispatch(BASE_OPTS());
      expect(result.content).toBe('primary says hi');
      expect(resolveHarness).toHaveBeenCalledWith('ceo');
    });

    it('uses resolveHarness return value over fallback', async () => {
      resolveHarness.mockReturnValue('secondary');
      const result = await router.dispatch(BASE_OPTS());
      expect(result.content).toBe('secondary says hi');
    });

    it('AgentSpec.harness overrides resolveHarness during addAgent', async () => {
      const primarySpy = vi.spyOn(primary, 'addAgent');
      const secondarySpy = vi.spyOn(secondary, 'addAgent');
      resolveHarness.mockReturnValue('primary');
      await router.addAgent({
        agentId: 'ceo',
        displayName: 'CEO',
        workspace: '/tmp',
        harness: 'secondary',
      } satisfies AgentSpec);
      expect(secondarySpy).toHaveBeenCalledTimes(1);
      expect(primarySpy).not.toHaveBeenCalled();
    });

    it('getHarnessNameFor exposes resolution for diagnostics', () => {
      resolveHarness.mockReturnValue('secondary');
      expect(router.getHarnessNameFor('ceo')).toBe('secondary');
      resolveHarness.mockReturnValue(undefined);
      expect(router.getHarnessNameFor('ceo')).toBe('primary'); // fallback
    });

    it('registeredHarnessNames lists underlying harnesses', () => {
      expect(router.registeredHarnessNames()).toEqual(['primary', 'secondary']);
    });

    it('default fallback is "openclaw" when none specified', async () => {
      const single = new MockHarness({ default: { content: 'x' } });
      const r = new HarnessRouter({
        harnesses: makeHarnesses({ openclaw: single }),
        resolveHarness: () => undefined,
      });
      await r.init(BASE_CONFIG);
      expect(r.getHarnessNameFor('ceo')).toBe('openclaw');
    });
  });

  describe('unknown-harness errors', () => {
    let router: HarnessRouter;

    beforeEach(async () => {
      const primary = new MockHarness({ default: { content: 'ok' } });
      router = new HarnessRouter({
        harnesses: makeHarnesses({ primary }),
        resolveHarness: () => 'does-not-exist',
        fallbackHarness: 'primary',
      });
      await router.init(BASE_CONFIG);
    });

    it('dispatch throws HarnessError(internal) listing registered names', async () => {
      await expect(router.dispatch(BASE_OPTS())).rejects.toBeInstanceOf(HarnessError);
      try {
        await router.dispatch(BASE_OPTS());
      } catch (err) {
        const e = err as HarnessError;
        expect(e.category).toBe('internal');
        expect(e.harnessName).toBe('router');
        expect(e.message).toMatch(/does-not-exist/);
        expect(e.message).toMatch(/primary/); // registered names
      }
    });

    it('addAgent throws HarnessError(internal) with helpful message', async () => {
      await expect(
        router.addAgent({
          agentId: 'ceo',
          displayName: 'CEO',
          workspace: '/tmp',
          harness: 'also-missing',
        }),
      ).rejects.toBeInstanceOf(HarnessError);
    });

    it('unknown-harness dispatch counts toward health.errors', async () => {
      await router.dispatch(BASE_OPTS()).catch(() => void 0);
      await router.dispatch(BASE_OPTS()).catch(() => void 0);
      const h = await router.health();
      expect(h.errors).toBeGreaterThanOrEqual(2);
    });
  });

  describe('lifecycle fan-out', () => {
    it('init fans out to every underlying harness', async () => {
      const a = new MockHarness();
      const b = new MockHarness();
      const spyA = vi.spyOn(a, 'init');
      const spyB = vi.spyOn(b, 'init');
      const router = new HarnessRouter({
        harnesses: makeHarnesses({ a, b }),
        resolveHarness: () => undefined,
        fallbackHarness: 'a',
      });
      await router.init(BASE_CONFIG);
      expect(spyA).toHaveBeenCalledWith(BASE_CONFIG);
      expect(spyB).toHaveBeenCalledWith(BASE_CONFIG);
    });

    it('shutdown fans out to every underlying harness', async () => {
      const a = new MockHarness();
      const b = new MockHarness();
      const spyA = vi.spyOn(a, 'shutdown');
      const spyB = vi.spyOn(b, 'shutdown');
      const router = new HarnessRouter({
        harnesses: makeHarnesses({ a, b }),
        resolveHarness: () => undefined,
        fallbackHarness: 'a',
      });
      await router.init(BASE_CONFIG);
      await router.shutdown();
      expect(spyA).toHaveBeenCalled();
      expect(spyB).toHaveBeenCalled();
    });

    it('removeAgent fans out (cleanup safety)', async () => {
      const a = new MockHarness();
      const b = new MockHarness();
      const spyA = vi.spyOn(a, 'removeAgent');
      const spyB = vi.spyOn(b, 'removeAgent');
      const router = new HarnessRouter({
        harnesses: makeHarnesses({ a, b }),
        resolveHarness: () => undefined,
        fallbackHarness: 'a',
      });
      await router.init(BASE_CONFIG);
      await router.removeAgent('ceo');
      expect(spyA).toHaveBeenCalledWith('ceo');
      expect(spyB).toHaveBeenCalledWith('ceo');
    });
  });

  describe('health aggregation', () => {
    it('ok: true when any underlying harness is ok', async () => {
      const okHarness = new MockHarness();
      const router = new HarnessRouter({
        harnesses: makeHarnesses({ ok: okHarness }),
        resolveHarness: () => undefined,
        fallbackHarness: 'ok',
      });
      await router.init(BASE_CONFIG);
      const h = await router.health();
      expect(h.ok).toBe(true);
    });

    it('info.harnesses lists every underlying with per-harness stats', async () => {
      const a = new MockHarness({ default: { content: 'A' } });
      const b = new MockHarness({ default: { content: 'B' } });
      const router = new HarnessRouter({
        harnesses: makeHarnesses({ a, b }),
        resolveHarness: (id) => (id === 'ceo' ? 'a' : 'b'),
        fallbackHarness: 'a',
      });
      await router.init(BASE_CONFIG);
      await router.dispatch(BASE_OPTS({ agentId: 'ceo' }));
      await router.dispatch(BASE_OPTS({ agentId: 'herald', sessionKey: 'k2' }));
      const h = await router.health();
      const harnesses = h.info?.harnesses as Array<Record<string, unknown>>;
      expect(harnesses).toHaveLength(2);
      expect(harnesses.map((x) => x.registeredAs)).toEqual(['a', 'b']);
      expect(harnesses.every((x) => typeof x.dispatches === 'number')).toBe(true);
    });

    it('info.fallback reflects configured fallback name', async () => {
      const router = new HarnessRouter({
        harnesses: makeHarnesses({ mock: new MockHarness() }),
        resolveHarness: () => undefined,
        fallbackHarness: 'mock',
      });
      await router.init(BASE_CONFIG);
      const h = await router.health();
      expect(h.info?.fallback).toBe('mock');
    });

    it('dispatches + errors aggregate across router + delegated', async () => {
      const a = new MockHarness({ default: { content: 'A' } });
      const router = new HarnessRouter({
        harnesses: makeHarnesses({ a }),
        resolveHarness: () => 'a',
      });
      await router.init(BASE_CONFIG);
      await router.dispatch(BASE_OPTS());
      await router.dispatch(BASE_OPTS({ sessionKey: 'k2' }));
      const h = await router.health();
      expect(h.dispatches).toBeGreaterThanOrEqual(2);
    });

    it('lastDispatchAt reflects most recent dispatch across harnesses', async () => {
      const a = new MockHarness();
      const router = new HarnessRouter({
        harnesses: makeHarnesses({ a }),
        resolveHarness: () => 'a',
      });
      await router.init(BASE_CONFIG);
      expect((await router.health()).lastDispatchAt).toBeNull();
      const before = Date.now();
      await router.dispatch(BASE_OPTS()).catch(() => void 0);
      const h = await router.health();
      expect(h.lastDispatchAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('dispatch delegation', () => {
    it('delegates DispatchOpts unchanged to the target harness', async () => {
      const target = new MockHarness({ default: { content: 'delegated' } });
      const spy = vi.spyOn(target, 'dispatch');
      const router = new HarnessRouter({
        harnesses: makeHarnesses({ target }),
        resolveHarness: () => 'target',
      });
      await router.init(BASE_CONFIG);
      const opts = BASE_OPTS({ message: 'test-input' });
      await router.dispatch(opts);
      expect(spy).toHaveBeenCalledWith(opts);
    });

    it('re-throws non-HarnessError errors from underlying harness', async () => {
      const broken = new MockHarness();
      broken.dispatch = vi.fn(async () => { throw new TypeError('boom'); }) as never;
      const router = new HarnessRouter({
        harnesses: makeHarnesses({ broken }),
        resolveHarness: () => 'broken',
      });
      await router.init(BASE_CONFIG);
      await expect(router.dispatch(BASE_OPTS())).rejects.toBeInstanceOf(TypeError);
    });
  });
});
