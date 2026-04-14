import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  ClaudeCodeHarness,
  HarnessError,
  sessionIdFor,
  type ClaudeChildProcess,
  type ClaudeSpawnFn,
  type DispatchOpts,
} from '../../packages/daemon/src/harness/index.js';

const BASE_CONFIG = {
  corpRoot: '/tmp/does-not-exist',
  globalConfig: {
    apiKeys: {},
    daemon: { portRange: [18800, 18999] as [number, number], logLevel: 'info' as const },
    defaults: { model: 'claude', provider: 'claude' },
  },
};

const BASE_OPTS = (overrides: Partial<DispatchOpts> = {}): DispatchOpts => ({
  agentId: 'ceo',
  message: 'hello',
  sessionKey: 'say:ceo:mark',
  context: { corpRoot: '/corps/test', agentDir: 'agents/ceo' } as never,
  ...overrides,
});

/**
 * Minimal stand-in for child_process.ChildProcess that exposes the same
 * surface ClaudeCodeHarness reads (stdout/stderr/stdin streams + exit
 * event + kill method). Tests script behavior by calling emitLine /
 * emitEvent / emitStderr / exit on the instance.
 */
class MockClaudeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  killSignal: NodeJS.Signals | number | null = null;

  emitLine(line: string): void {
    this.stdout.write(line + '\n');
  }

  emitEvent(event: object): void {
    this.emitLine(JSON.stringify(event));
  }

  emitStderr(text: string): void {
    this.stderr.write(text);
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
    // Real subprocess would emit exit asynchronously after the signal
    setImmediate(() => this.exit(null, typeof signal === 'string' ? signal : 'SIGTERM'));
    return true;
  }
}

interface SpawnCall {
  binary: string;
  args: string[];
  cwd: string;
  proc: MockClaudeProcess;
}

function makeSpawner(scenario: (proc: MockClaudeProcess, call: SpawnCall) => void): {
  spawn: ClaudeSpawnFn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: ClaudeSpawnFn = (binary, args, options) => {
    const proc = new MockClaudeProcess();
    const call: SpawnCall = { binary, args, cwd: options.cwd, proc };
    calls.push(call);
    setImmediate(() => scenario(proc, call));
    return proc as unknown as ClaudeChildProcess;
  };
  return { spawn, calls };
}

/** Helper: standard happy-path scenario that mimics a real claude run. */
function happyPathScenario(content = 'Hello world'): (proc: MockClaudeProcess) => void {
  return (proc) => {
    proc.emitEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-from-claude',
      model: 'claude-opus-4-6',
      tools: ['Read'],
    });
    proc.emitEvent({ type: 'stream_event', event: { type: 'message_start', message: {} } });
    proc.emitEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    for (const word of content.split(' ')) {
      proc.emitEvent({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word + ' ' } },
      });
    }
    proc.emitEvent({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    proc.emitEvent({ type: 'stream_event', event: { type: 'message_stop' } });
    proc.emitEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 50,
      result: content,
      session_id: 'sess-from-claude',
      total_cost_usd: 0.001,
    });
    proc.exit(0);
  };
}

/** Helper: --version probe that succeeds. */
function versionOnlyScenario(version = '2.1.107'): (proc: MockClaudeProcess, call: SpawnCall) => void {
  return (proc, call) => {
    if (call.args.includes('--version')) {
      proc.stdout.write(version + '\n');
      proc.exit(0);
    } else {
      // Other scenarios should override this
      proc.exit(1);
    }
  };
}

describe('ClaudeCodeHarness', () => {
  describe('init + binary detection', () => {
    it('init records binary version when --version succeeds', async () => {
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107 (Claude Code)\n');
          proc.exit(0);
        }
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      const health = await harness.health();
      expect(health.ok).toBe(true);
      expect(health.info?.binaryAvailable).toBe(true);
      expect(health.info?.binaryVersion).toBe('2.1.107 (Claude Code)');
    });

    it('init reports not-ok when binary check fails', async () => {
      const { spawn } = makeSpawner((proc) => {
        proc.emitStderr('command not found');
        proc.exit(127);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      const health = await harness.health();
      expect(health.ok).toBe(false);
      expect(health.info?.binaryAvailable).toBe(false);
      expect(health.info?.binaryVersion).toBeNull();
    });

    it('init reports not-ok when spawn throws synchronously (binary missing)', async () => {
      const spawn: ClaudeSpawnFn = () => { throw new Error('ENOENT'); };
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      const health = await harness.health();
      expect(health.ok).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('addAgent / removeAgent are no-ops (do not throw)', async () => {
      const { spawn } = makeSpawner(versionOnlyScenario());
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await expect(
        harness.addAgent({ agentId: 'ceo', displayName: 'CEO', workspace: '/tmp' }),
      ).resolves.not.toThrow();
      await expect(harness.removeAgent('ceo')).resolves.not.toThrow();
    });

    it('shutdown resolves cleanly without prior init', async () => {
      const harness = new ClaudeCodeHarness({ spawn: () => { throw new Error('not used'); } });
      await expect(harness.shutdown()).resolves.not.toThrow();
    });

    it('has name "claude-code"', () => {
      const harness = new ClaudeCodeHarness({ spawn: () => { throw new Error('not used'); } });
      expect(harness.name).toBe('claude-code');
    });
  });

  describe('dispatch happy path', () => {
    it('streams tokens via onToken with accumulated text', async () => {
      const { spawn, calls } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        happyPathScenario('one two three')(proc);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);

      const tokens: string[] = [];
      const result = await harness.dispatch(BASE_OPTS({
        callbacks: { onToken: (acc) => tokens.push(acc) },
      }));

      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens[tokens.length - 1]).toContain('three');
      expect(result.content).toBe('one two three');
      expect(result.toolCalls).toEqual([]);
      expect(calls).toHaveLength(2); // version + dispatch
    });

    it('always passes --verbose (required when combining --print + stream-json)', async () => {
      // Without --verbose, claude exits with:
      //   "When using --print, --output-format=stream-json requires --verbose"
      // This test guards against a regression where someone removes --verbose.
      const { spawn, calls } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        happyPathScenario('ok')(proc);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS());
      const dispatchCall = calls.find((c) => !c.args.includes('--version'))!;
      expect(dispatchCall.args).toContain('--verbose');
      expect(dispatchCall.args).toContain('--output-format');
      expect(dispatchCall.args).toContain('stream-json');
    });

    it('passes derived UUIDv5 session ID via --session-id', async () => {
      const expectedSessionId = sessionIdFor('say:ceo:mark');
      const { spawn, calls } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        happyPathScenario('ok')(proc);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS());

      const dispatchCall = calls.find((c) => !c.args.includes('--version'))!;
      const sessionIdIdx = dispatchCall.args.indexOf('--session-id');
      expect(sessionIdIdx).toBeGreaterThan(-1);
      expect(dispatchCall.args[sessionIdIdx + 1]).toBe(expectedSessionId);
    });

    it('passes resolved workspace as cwd and via --add-dir (relative agentDir)', async () => {
      const { spawn, calls } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        happyPathScenario('ok')(proc);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS());

      const dispatchCall = calls.find((c) => !c.args.includes('--version'))!;
      // BASE_OPTS provides relative agentDir = 'agents/ceo' → joined with corpRoot
      expect(dispatchCall.cwd).toMatch(/corps[\\/]+test[\\/]+agents[\\/]+ceo/);
      const addDirIdx = dispatchCall.args.indexOf('--add-dir');
      expect(addDirIdx).toBeGreaterThan(-1);
      expect(dispatchCall.args[addDirIdx + 1]).toBe(dispatchCall.cwd);
    });

    it('uses absolute agentDir as-is (no double-join with corpRoot)', async () => {
      // api.ts /cc/say provides agentDir as an absolute path already joined
      // with corpRoot. The harness must NOT join again — that would produce
      // an invalid path like C:/.../corp/C:/.../corp/agents/ceo and Node
      // spawn would surface a misleading ENOENT against the binary.
      const absoluteWorkspace = process.platform === 'win32'
        ? 'C:\\Users\\test\\.claudecorp\\my-corp\\agents\\ceo'
        : '/home/test/.claudecorp/my-corp/agents/ceo';

      const { spawn, calls } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        happyPathScenario('ok')(proc);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS({
        context: { corpRoot: '/different/path', agentDir: absoluteWorkspace } as never,
      }));

      const dispatchCall = calls.find((c) => !c.args.includes('--version'))!;
      expect(dispatchCall.cwd).toBe(absoluteWorkspace);
      const addDirIdx = dispatchCall.args.indexOf('--add-dir');
      expect(dispatchCall.args[addDirIdx + 1]).toBe(absoluteWorkspace);
    });

    it('writes the user message to stdin', async () => {
      const stdinChunks: string[] = [];
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        proc.stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk.toString('utf-8')));
        happyPathScenario('ok')(proc);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS({ message: 'unique-test-prompt' }));
      expect(stdinChunks.join('')).toContain('unique-test-prompt');
    });

    it('captures tool calls into DispatchResult.toolCalls + fires both callbacks', async () => {
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        proc.emitEvent({ type: 'system', subtype: 'init', session_id: 's', model: 'm', tools: [] });
        proc.emitEvent({ type: 'stream_event', event: { type: 'message_start', message: {} } });
        proc.emitEvent({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          },
        });
        proc.emitEvent({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"/foo"}' },
          },
        });
        proc.emitEvent({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
        proc.emitEvent({ type: 'stream_event', event: { type: 'message_stop' } });
        proc.emitEvent({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's', duration_ms: 5 });
        proc.exit(0);
      });

      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);

      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();
      const result = await harness.dispatch(BASE_OPTS({
        callbacks: { onToolStart, onToolEnd },
      }));

      expect(onToolStart).toHaveBeenCalledWith(expect.objectContaining({ name: 'Read', args: { path: '/foo' } }));
      expect(onToolEnd).toHaveBeenCalledWith(expect.objectContaining({ name: 'Read' }));
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.args).toEqual({ path: '/foo' });
    });

    it('tracks per-dispatch + cumulative cost from result_success.total_cost_usd', async () => {
      let dispatchN = 0;
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        const cost = dispatchN === 0 ? 0.0123 : 0.0077;
        dispatchN += 1;
        proc.emitEvent({ type: 'system', subtype: 'init', session_id: 's', model: 'm', tools: [] });
        proc.emitEvent({
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 5,
          result: 'ok',
          session_id: 's',
          total_cost_usd: cost,
        });
        proc.exit(0);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS());
      let health = await harness.health();
      expect(health.info?.lastDispatchCostUsd).toBeCloseTo(0.0123, 6);
      expect(health.info?.totalCostUsd).toBeCloseTo(0.0123, 6);
      await harness.dispatch(BASE_OPTS({ sessionKey: 'say:ceo:two' }));
      health = await harness.health();
      expect(health.info?.lastDispatchCostUsd).toBeCloseTo(0.0077, 6);
      expect(health.info?.totalCostUsd).toBeCloseTo(0.0123 + 0.0077, 6);
    });

    it('cost tracking ignores non-finite + missing values without throwing', async () => {
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        proc.emitEvent({ type: 'system', subtype: 'init', session_id: 's', model: 'm', tools: [] });
        // result_success with no total_cost_usd at all
        proc.emitEvent({
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 5,
          result: 'ok',
          session_id: 's',
        });
        proc.exit(0);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS());
      const health = await harness.health();
      expect(health.info?.totalCostUsd).toBe(0);
      expect(health.info?.lastDispatchCostUsd).toBeNull();
    });

    it('captures rate_limit info into health.info.lastRateLimit', async () => {
      const rateInfo = { status: 'allowed', resetsAt: 1776171600 };
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        proc.emitEvent({ type: 'rate_limit_event', rate_limit_info: rateInfo });
        happyPathScenario('ok')(proc);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS());
      const health = await harness.health();
      expect(health.info?.lastRateLimit).toEqual(rateInfo);
    });

    it('falls back to accumulated text when result envelope omits .result', async () => {
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        proc.emitEvent({ type: 'system', subtype: 'init', session_id: 's', model: 'm', tools: [] });
        proc.emitEvent({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        });
        proc.emitEvent({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fallback content' } },
        });
        proc.emitEvent({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
        proc.emitEvent({ type: 'result', subtype: 'success', is_error: false, session_id: 's', duration_ms: 5 });
        proc.exit(0);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      const result = await harness.dispatch(BASE_OPTS());
      expect(result.content).toBe('fallback content');
    });
  });

  describe('dispatch errors', () => {
    it('throws auth when binary unavailable', async () => {
      const { spawn } = makeSpawner((proc) => {
        proc.exit(127);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await expect(harness.dispatch(BASE_OPTS())).rejects.toMatchObject({
        category: 'auth',
        harnessName: 'claude-code',
      });
    });

    it('throws aborted when signal already aborted (pre-spawn)', async () => {
      const { spawn, calls } = makeSpawner(versionOnlyScenario());
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      const ac = new AbortController();
      ac.abort();
      await expect(harness.dispatch(BASE_OPTS({ signal: ac.signal }))).rejects.toMatchObject({
        category: 'aborted',
        harnessName: 'claude-code',
      });
      // Only the version probe should have run — no dispatch spawn
      expect(calls.filter((c) => !c.args.includes('--version'))).toHaveLength(0);
    });

    it('SIGINTs subprocess + rejects aborted when signal fires mid-flight', async () => {
      let dispatchProc: MockClaudeProcess | null = null;
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        dispatchProc = proc;
        // Don't exit — wait for kill
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      const ac = new AbortController();
      const p = harness.dispatch(BASE_OPTS({ signal: ac.signal }));
      // Wait a tick so spawn happens
      await new Promise((r) => setImmediate(r));
      ac.abort();
      await expect(p).rejects.toMatchObject({ category: 'aborted' });
      expect(dispatchProc!.killed).toBe(true);
      expect(dispatchProc!.killSignal).toBe('SIGINT');
    });

    it('throws rate_limit when result_error is overloaded', async () => {
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        proc.emitEvent({
          type: 'result',
          subtype: 'error',
          is_error: true,
          error: 'Status 529: overloaded — try again soon',
          session_id: 's',
        });
        proc.exit(0);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await expect(harness.dispatch(BASE_OPTS())).rejects.toMatchObject({
        category: 'rate_limit',
      });
    });

    it('throws auth when stderr indicates "not logged in"', async () => {
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        proc.emitStderr('Not logged in. Please run /login.');
        proc.exit(1);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await expect(harness.dispatch(BASE_OPTS())).rejects.toMatchObject({ category: 'auth' });
    });

    it('throws rate_limit when stderr matches 429/quota', async () => {
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        proc.emitStderr('429 rate limit exceeded');
        proc.exit(1);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await expect(harness.dispatch(BASE_OPTS())).rejects.toMatchObject({ category: 'rate_limit' });
    });

    it('throws transport when spawn throws synchronously', async () => {
      // Init succeeds, but dispatch spawn throws
      let firstCall = true;
      const spawn: ClaudeSpawnFn = (binary, args, opts) => {
        if (firstCall) {
          firstCall = false;
          const proc = new MockClaudeProcess();
          setImmediate(() => {
            proc.stdout.write('2.1.107\n');
            proc.exit(0);
          });
          return proc as unknown as ClaudeChildProcess;
        }
        throw new Error('EACCES');
      };
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await expect(harness.dispatch(BASE_OPTS())).rejects.toMatchObject({
        category: 'transport',
      });
    });

    it('throws transport when subprocess emits error event', async () => {
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        setImmediate(() => proc.emit('error', new Error('child process crashed')));
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await expect(harness.dispatch(BASE_OPTS())).rejects.toMatchObject({
        category: 'transport',
      });
    });

    it('throws timeout when dispatch exceeds timeoutMs', async () => {
      let dispatchProc: MockClaudeProcess | null = null;
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        dispatchProc = proc;
        // Never exit — let timeout fire
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await expect(
        harness.dispatch(BASE_OPTS({ timeoutMs: 50 })),
      ).rejects.toMatchObject({ category: 'timeout' });
      expect(dispatchProc!.killed).toBe(true);
      expect(dispatchProc!.killSignal).toBe('SIGKILL');
    });
  });

  describe('telemetry', () => {
    it('dispatches counter increments per attempt (success or failure)', async () => {
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        happyPathScenario('ok')(proc);
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS());
      await harness.dispatch(BASE_OPTS({ sessionKey: 'say:ceo:other' }));
      const health = await harness.health();
      expect(health.dispatches).toBe(2);
      expect(health.errors).toBe(0);
    });

    it('errors counter increments on failed dispatch', async () => {
      let firstDispatch = true;
      const { spawn } = makeSpawner((proc, call) => {
        if (call.args.includes('--version')) {
          proc.stdout.write('2.1.107\n');
          proc.exit(0);
          return;
        }
        if (firstDispatch) {
          firstDispatch = false;
          proc.emitStderr('Not logged in');
          proc.exit(1);
        } else {
          happyPathScenario('ok')(proc);
        }
      });
      const harness = new ClaudeCodeHarness({ spawn });
      await harness.init(BASE_CONFIG);
      await harness.dispatch(BASE_OPTS()).catch(() => void 0);
      await harness.dispatch(BASE_OPTS({ sessionKey: 'say:ceo:two' }));
      const health = await harness.health();
      expect(health.dispatches).toBe(2);
      expect(health.errors).toBe(1);
    });
  });
});
