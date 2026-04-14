import { describe, it, expect, beforeEach } from 'vitest';
import {
  HarnessRegistry,
  MockHarness,
  defaultHarnessRegistry,
  type HarnessFactory,
} from '../../packages/daemon/src/harness/index.js';

const BASE_CONFIG = {
  corpRoot: '/tmp/does-not-exist',
  globalConfig: {
    apiKeys: {},
    daemon: { portRange: [18800, 18999] as [number, number], logLevel: 'info' as const },
    defaults: { model: 'mock', provider: 'mock' },
  },
};

describe('HarnessRegistry', () => {
  let reg: HarnessRegistry;

  beforeEach(() => {
    reg = new HarnessRegistry();
  });

  describe('register', () => {
    it('starts empty', () => {
      expect(reg.size).toBe(0);
      expect(reg.list()).toEqual([]);
    });

    it('accepts a factory and marks has() true', () => {
      reg.register('mock', () => new MockHarness());
      expect(reg.has('mock')).toBe(true);
      expect(reg.size).toBe(1);
      expect(reg.list()).toEqual(['mock']);
    });

    it('preserves registration order', () => {
      reg.register('a', () => new MockHarness());
      reg.register('b', () => new MockHarness());
      reg.register('c', () => new MockHarness());
      expect(reg.list()).toEqual(['a', 'b', 'c']);
    });

    it('throws on empty name', () => {
      expect(() => reg.register('', () => new MockHarness())).toThrow(/non-empty/);
    });

    it('throws on duplicate registration', () => {
      reg.register('mock', () => new MockHarness());
      expect(() => reg.register('mock', () => new MockHarness())).toThrow(/already registered/);
    });

    it('allows re-register after unregister', () => {
      reg.register('mock', () => new MockHarness());
      reg.unregister('mock');
      expect(() => reg.register('mock', () => new MockHarness())).not.toThrow();
    });
  });

  describe('unregister', () => {
    it('returns true when a factory was removed', () => {
      reg.register('mock', () => new MockHarness());
      expect(reg.unregister('mock')).toBe(true);
      expect(reg.has('mock')).toBe(false);
    });

    it('returns false when the name was not registered', () => {
      expect(reg.unregister('ghost')).toBe(false);
    });
  });

  describe('create', () => {
    it('instantiates via the factory and initializes once', async () => {
      let initCalls = 0;
      const factory: HarnessFactory = () => {
        const h = new MockHarness();
        const origInit = h.init.bind(h);
        h.init = async (cfg) => {
          initCalls += 1;
          return origInit(cfg);
        };
        return h;
      };
      reg.register('mock', factory);
      const harness = await reg.create('mock', BASE_CONFIG);
      expect(harness.name).toBe('mock');
      expect(initCalls).toBe(1);
    });

    it('passes config to init()', async () => {
      let received: unknown = null;
      reg.register('mock', () => {
        const h = new MockHarness();
        h.init = async (cfg) => { received = cfg; };
        return h;
      });
      await reg.create('mock', BASE_CONFIG);
      expect(received).toBe(BASE_CONFIG);
    });

    it('supports async factories', async () => {
      reg.register('async', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return new MockHarness();
      });
      const harness = await reg.create('async', BASE_CONFIG);
      expect(harness.name).toBe('mock');
    });

    it('throws on unknown harness name with a helpful message', async () => {
      reg.register('known', () => new MockHarness());
      await expect(reg.create('unknown', BASE_CONFIG)).rejects.toThrow(/Unknown harness "unknown"/);
      await expect(reg.create('unknown', BASE_CONFIG)).rejects.toThrow(/known/);
    });

    it('reports "(none registered)" when registry is empty', async () => {
      await expect(reg.create('anything', BASE_CONFIG)).rejects.toThrow(/none registered/);
    });
  });

  describe('clear', () => {
    it('removes all registrations', () => {
      reg.register('a', () => new MockHarness());
      reg.register('b', () => new MockHarness());
      reg.clear();
      expect(reg.size).toBe(0);
      expect(reg.list()).toEqual([]);
    });
  });
});

describe('defaultHarnessRegistry', () => {
  it('is a HarnessRegistry instance', () => {
    expect(defaultHarnessRegistry).toBeInstanceOf(HarnessRegistry);
  });

  it('is a singleton — same reference on every import', async () => {
    const mod = await import('../../packages/daemon/src/harness/index.js');
    expect(mod.defaultHarnessRegistry).toBe(defaultHarnessRegistry);
  });
});
