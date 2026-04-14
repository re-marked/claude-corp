import { describe, it, expect, beforeEach } from 'vitest';
import {
  MockHarness,
  HarnessError,
  type DispatchOpts,
  type ToolCallInfo,
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

describe('MockHarness — interface contract', () => {
  let harness: MockHarness;

  beforeEach(async () => {
    harness = new MockHarness();
    await harness.init(BASE_CONFIG);
  });

  describe('lifecycle', () => {
    it('has name "mock"', () => {
      expect(harness.name).toBe('mock');
    });

    it('init + shutdown are idempotent and safe to call multiple times', async () => {
      await expect(harness.init(BASE_CONFIG)).resolves.not.toThrow();
      await expect(harness.shutdown()).resolves.not.toThrow();
      await expect(harness.shutdown()).resolves.not.toThrow();
    });

    it('health reports ok: true + zero dispatches initially', async () => {
      const h = await harness.health();
      expect(h.ok).toBe(true);
      expect(h.name).toBe('mock');
      expect(h.dispatches).toBe(0);
      expect(h.errors).toBe(0);
      expect(h.lastDispatchAt).toBeNull();
      expect(h.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it('health reflects dispatch counts + lastDispatchAt after dispatch', async () => {
      harness.setOptions({ default: { content: 'ok' } });
      const before = Date.now();
      await harness.dispatch(BASE_OPTS());
      const h = await harness.health();
      expect(h.dispatches).toBe(1);
      expect(h.errors).toBe(0);
      expect(h.lastDispatchAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('agent registration', () => {
    it('addAgent / removeAgent tracks registered set', async () => {
      await harness.addAgent({ agentId: 'ceo', displayName: 'CEO', workspace: '/tmp' });
      await harness.addAgent({ agentId: 'herald', displayName: 'Herald', workspace: '/tmp' });
      expect(harness.getRegisteredAgents()).toEqual(expect.arrayContaining(['ceo', 'herald']));
      await harness.removeAgent('ceo');
      expect(harness.getRegisteredAgents()).toEqual(['herald']);
    });

    it('non-strict mode dispatches to unregistered agents', async () => {
      harness.setOptions({ default: { content: 'ok' } });
      const result = await harness.dispatch(BASE_OPTS({ agentId: 'ghost' }));
      expect(result.content).toBe('ok');
    });

    it('strictAddAgent mode rejects unregistered agents with unknown_agent', async () => {
      harness = new MockHarness({ strictAddAgent: true, default: { content: 'ok' } });
      await harness.init(BASE_CONFIG);
      await expect(harness.dispatch(BASE_OPTS({ agentId: 'ghost' }))).rejects.toBeInstanceOf(HarnessError);
      try {
        await harness.dispatch(BASE_OPTS({ agentId: 'ghost' }));
      } catch (err) {
        expect((err as HarnessError).category).toBe('unknown_agent');
      }
    });
  });

  describe('response resolution', () => {
    it('prefers bySession over byAgent over default', async () => {
      harness.setOptions({
        default: { content: 'default' },
        byAgent: { ceo: { content: 'agent' } },
        bySession: { 'say:ceo:mark': { content: 'session' } },
      });
      expect((await harness.dispatch(BASE_OPTS())).content).toBe('session');
      expect((await harness.dispatch(BASE_OPTS({ sessionKey: 'other' }))).content).toBe('agent');
      expect((await harness.dispatch(BASE_OPTS({ agentId: 'x', sessionKey: 'y' }))).content).toBe('default');
    });

    it('falls back to hard-coded response when no script matches', async () => {
      const result = await harness.dispatch(BASE_OPTS());
      expect(result.content).toBe('mock response');
      expect(result.model).toBe('mock');
    });

    it('accepts a function as response for dynamic scripts', async () => {
      harness.setOptions({
        default: (opts) => ({ content: `echo: ${opts.message}` }),
      });
      const result = await harness.dispatch(BASE_OPTS({ message: 'test' }));
      expect(result.content).toBe('echo: test');
    });
  });

  describe('streaming', () => {
    it('invokes onToken with accumulated text per chunk', async () => {
      harness.setOptions({ default: { content: 'one two three' } });
      const tokens: string[] = [];
      await harness.dispatch(BASE_OPTS({
        callbacks: { onToken: (acc) => tokens.push(acc) },
      }));
      expect(tokens).toEqual(['one', 'one two', 'one two three']);
    });

    it('uses explicit chunks when provided', async () => {
      harness.setOptions({ default: { content: 'unused', chunks: ['A', 'B', 'C'] } });
      const tokens: string[] = [];
      await harness.dispatch(BASE_OPTS({
        callbacks: { onToken: (acc) => tokens.push(acc) },
      }));
      expect(tokens).toEqual(['A', 'A B', 'A B C']);
    });

    it('fires onLifecycle end after streaming', async () => {
      harness.setOptions({ default: { content: 'x' } });
      const phases: string[] = [];
      await harness.dispatch(BASE_OPTS({
        callbacks: { onLifecycle: (p) => phases.push(p) },
      }));
      expect(phases).toContain('end');
    });
  });

  describe('tool calls', () => {
    it('invokes onToolStart + onToolEnd in order, populating result on end', async () => {
      harness.setOptions({
        default: {
          content: 'done',
          toolCalls: [
            { name: 'Read', toolCallId: 't1', args: { path: '/foo' }, result: 'file contents' },
          ],
        },
      });
      const starts: ToolCallInfo[] = [];
      const ends: (ToolCallInfo & { result?: string })[] = [];
      await harness.dispatch(BASE_OPTS({
        callbacks: {
          onToolStart: (t) => starts.push({ ...t }),
          onToolEnd: (t) => ends.push({ ...t }),
        },
      }));
      expect(starts).toHaveLength(1);
      expect(starts[0]!.name).toBe('Read');
      expect(starts[0]!.args).toEqual({ path: '/foo' });
      expect(ends).toHaveLength(1);
      expect(ends[0]!.result).toBe('file contents');
    });

    it('DispatchResult.toolCalls captures all tools observed', async () => {
      harness.setOptions({
        default: {
          content: 'done',
          toolCalls: [
            { name: 'Read', toolCallId: 't1', result: 'a' },
            { name: 'Bash', toolCallId: 't2', result: 'b' },
          ],
        },
      });
      const result = await harness.dispatch(BASE_OPTS());
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls.map((t) => t.name)).toEqual(['Read', 'Bash']);
    });
  });

  describe('errors', () => {
    it('throws HarnessError with configured category', async () => {
      harness.setOptions({
        default: { content: '', error: { category: 'rate_limit', message: 'quota exhausted' } },
      });
      await expect(harness.dispatch(BASE_OPTS())).rejects.toBeInstanceOf(HarnessError);
      try {
        await harness.dispatch(BASE_OPTS());
      } catch (err) {
        const e = err as HarnessError;
        expect(e.category).toBe('rate_limit');
        expect(e.harnessName).toBe('mock');
        expect(e.message).toBe('quota exhausted');
      }
    });

    it('health.errors increments on failed dispatch', async () => {
      harness.setOptions({
        default: { content: '', error: { category: 'internal', message: 'boom' } },
      });
      await expect(harness.dispatch(BASE_OPTS())).rejects.toBeInstanceOf(HarnessError);
      const h = await harness.health();
      expect(h.errors).toBe(1);
    });
  });

  describe('cancellation', () => {
    it('already-aborted signal rejects before streaming starts', async () => {
      harness.setOptions({ default: { content: 'never seen' } });
      const ac = new AbortController();
      ac.abort();
      await expect(harness.dispatch(BASE_OPTS({ signal: ac.signal }))).rejects.toMatchObject({
        category: 'aborted',
      });
    });

    it('aborting mid-stream stops future onToken calls', async () => {
      harness.setOptions({
        default: { content: 'one two three four five', chunkDelayMs: 20 },
      });
      const ac = new AbortController();
      const tokens: string[] = [];
      const p = harness.dispatch(BASE_OPTS({
        signal: ac.signal,
        callbacks: { onToken: (acc) => tokens.push(acc) },
      }));
      setTimeout(() => ac.abort(), 25);
      await expect(p).rejects.toMatchObject({ category: 'aborted' });
      // At least one token should have been observed, and fewer than all five.
      expect(tokens.length).toBeLessThan(5);
    });
  });

  describe('DispatchResult shape', () => {
    it('returns content, model, sessionId, durationMs, toolCalls', async () => {
      harness.setOptions({ default: { content: 'resp', model: 'mock-v2' } });
      const result = await harness.dispatch(BASE_OPTS({ sessionKey: 'abc' }));
      expect(result.content).toBe('resp');
      expect(result.model).toBe('mock-v2');
      expect(result.sessionId).toBe('abc');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.toolCalls)).toBe(true);
    });
  });

  describe('test helpers', () => {
    it('getDispatches records every attempt', async () => {
      harness.setOptions({ default: { content: 'a' } });
      await harness.dispatch(BASE_OPTS({ sessionKey: 's1' }));
      await harness.dispatch(BASE_OPTS({ sessionKey: 's2' }));
      const records = harness.getDispatches();
      expect(records).toHaveLength(2);
      expect(records[0]!.opts.sessionKey).toBe('s1');
      expect(records[1]!.opts.sessionKey).toBe('s2');
    });

    it('reset clears dispatch history and registration', async () => {
      harness.setOptions({ default: { content: 'a' } });
      await harness.addAgent({ agentId: 'x', displayName: 'X', workspace: '/tmp' });
      await harness.dispatch(BASE_OPTS());
      harness.reset();
      expect(harness.getDispatches()).toHaveLength(0);
      expect(harness.getRegisteredAgents()).toEqual([]);
    });
  });
});
