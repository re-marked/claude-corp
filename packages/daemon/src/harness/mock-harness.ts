/**
 * MockHarness — deterministic in-process AgentHarness for tests + local
 * development that shouldn't burn real model quota.
 *
 * Usage:
 *
 *   const mock = new MockHarness({
 *     default: { content: 'hello world' },
 *     byAgent: {
 *       ceo: { content: 'I am the CEO.', model: 'mock-v1' },
 *     },
 *     bySession: {
 *       'say:ceo:mark': { content: 'Good morning, Mark.' },
 *     },
 *   });
 *
 *   await mock.addAgent({ agentId: 'ceo', displayName: 'CEO', workspace: '/tmp' });
 *   const result = await mock.dispatch({ agentId: 'ceo', ... });
 *
 * Resolution order for each dispatch: sessionKey → agentId → default → fallback.
 * Responses may be functions, allowing dynamic script behavior per dispatch.
 *
 * Supports simulated streaming (splits content into chunks, invokes onToken
 * per chunk), simulated tool calls (invokes onToolStart/onToolEnd in order),
 * simulated errors (throws HarnessError with a chosen category), and
 * AbortSignal-based cancellation.
 */

import {
  type AgentHarness,
  type AgentSpec,
  type DispatchOpts,
  type DispatchResult,
  type HarnessConfig,
  type HarnessErrorCategory,
  type HarnessHealth,
  type ToolCallInfo,
  HarnessError,
} from './types.js';

export interface MockToolCall {
  name: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  result?: string;
  /** Delay before onToolEnd fires (ms). */
  delayMs?: number;
}

export interface MockResponse {
  /** Full content to return (and stream via onToken). */
  content: string;
  /** Model string reported back in DispatchResult.model. */
  model?: string;
  /**
   * Explicit chunks for streaming. If omitted, content is split on whitespace
   * and streamed word-by-word with a single space between.
   */
  chunks?: string[];
  /** Delay between chunks (ms). Useful for testing streaming UI behavior. */
  chunkDelayMs?: number;
  /** Initial delay before the first token is emitted (ms). */
  delayMs?: number;
  /** Tool calls to simulate in order, interleaved after streaming completes. */
  toolCalls?: MockToolCall[];
  /** When set, dispatch throws a HarnessError instead of returning. */
  error?: { category: HarnessErrorCategory; message: string };
}

export type MockResponseLike = MockResponse | ((opts: DispatchOpts) => MockResponse);

export interface MockHarnessOptions {
  /** Used when no agent- or session-specific response matches. */
  default?: MockResponseLike;
  /** Keyed by agentId. Matches before `default` but after `bySession`. */
  byAgent?: Record<string, MockResponseLike>;
  /** Keyed by sessionKey. Highest-priority match. */
  bySession?: Record<string, MockResponseLike>;
  /**
   * If true, dispatch to an unregistered agent throws "unknown_agent".
   * Default: false — allows tests to exercise dispatch without addAgent().
   */
  strictAddAgent?: boolean;
}

/** Shape exposed to tests via `getDispatches()`. */
export interface RecordedDispatch {
  at: number;
  opts: DispatchOpts;
  result?: DispatchResult;
  error?: HarnessError;
}

const DEFAULT_FALLBACK_RESPONSE: MockResponse = {
  content: 'mock response',
  model: 'mock',
};

export class MockHarness implements AgentHarness {
  readonly name = 'mock';

  private options: MockHarnessOptions;
  private startedAt = 0;
  private registered = new Set<string>();
  private dispatches: RecordedDispatch[] = [];
  private _errors = 0;
  private _lastDispatchAt: number | null = null;

  constructor(options: MockHarnessOptions = {}) {
    this.options = options;
  }

  async init(_config: HarnessConfig): Promise<void> {
    this.startedAt = Date.now();
  }

  async shutdown(): Promise<void> {
    this.registered.clear();
  }

  async health(): Promise<HarnessHealth> {
    return {
      ok: true,
      name: this.name,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      dispatches: this.dispatches.length,
      errors: this._errors,
      lastDispatchAt: this._lastDispatchAt,
      info: {
        registeredAgents: [...this.registered],
      },
    };
  }

  async addAgent(spec: AgentSpec): Promise<void> {
    this.registered.add(spec.agentId);
  }

  async removeAgent(agentId: string): Promise<void> {
    this.registered.delete(agentId);
  }

  async dispatch(opts: DispatchOpts): Promise<DispatchResult> {
    const at = Date.now();
    this._lastDispatchAt = at;
    const record: RecordedDispatch = { at, opts };
    this.dispatches.push(record);

    if (this.options.strictAddAgent && !this.registered.has(opts.agentId)) {
      const err = new HarnessError({
        category: 'unknown_agent',
        harnessName: this.name,
        message: `Agent "${opts.agentId}" not registered (strict mode)`,
      });
      record.error = err;
      this._errors += 1;
      throw err;
    }

    if (opts.signal?.aborted) {
      const err = new HarnessError({
        category: 'aborted',
        harnessName: this.name,
        message: 'Dispatch aborted before it started',
      });
      record.error = err;
      this._errors += 1;
      throw err;
    }

    const response = this.resolveResponse(opts);

    if (response.error) {
      const err = new HarnessError({
        category: response.error.category,
        harnessName: this.name,
        message: response.error.message,
      });
      record.error = err;
      this._errors += 1;
      throw err;
    }

    try {
      if (response.delayMs && response.delayMs > 0) {
        await this.sleepOrAbort(response.delayMs, opts.signal);
      }

      // Stream tokens
      const chunks = response.chunks ?? tokenize(response.content);
      let accumulated = '';
      for (const chunk of chunks) {
        if (opts.signal?.aborted) throw abortError(this.name);
        accumulated += accumulated ? ` ${chunk}` : chunk;
        opts.callbacks?.onToken?.(accumulated);
        if (response.chunkDelayMs && response.chunkDelayMs > 0) {
          await this.sleepOrAbort(response.chunkDelayMs, opts.signal);
        }
      }

      // Simulate tool calls
      const toolCalls: ToolCallInfo[] = [];
      for (const tc of response.toolCalls ?? []) {
        if (opts.signal?.aborted) throw abortError(this.name);
        const toolInfo: ToolCallInfo = {
          name: tc.name,
          toolCallId: tc.toolCallId,
          args: tc.args,
        };
        opts.callbacks?.onToolStart?.(toolInfo);

        if (tc.delayMs && tc.delayMs > 0) {
          await this.sleepOrAbort(tc.delayMs, opts.signal);
        }

        const ended: ToolCallInfo = { ...toolInfo, result: tc.result };
        toolCalls.push(ended);
        opts.callbacks?.onToolEnd?.(ended);
      }

      opts.callbacks?.onLifecycle?.('end');

      const result: DispatchResult = {
        content: response.content,
        model: response.model ?? 'mock',
        sessionId: opts.sessionKey,
        durationMs: Date.now() - at,
        toolCalls,
      };
      record.result = result;
      return result;
    } catch (err) {
      this._errors += 1;
      const wrapped = err instanceof HarnessError
        ? err
        : new HarnessError({
            category: 'internal',
            harnessName: this.name,
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          });
      record.error = wrapped;
      throw wrapped;
    }
  }

  // --- Test helpers ---------------------------------------------------------

  /** Snapshot of all dispatches (successful + failed). */
  getDispatches(): readonly RecordedDispatch[] {
    return this.dispatches;
  }

  /** Registered agentIds. */
  getRegisteredAgents(): readonly string[] {
    return [...this.registered];
  }

  /** Reset history + registrations. Useful between test cases. */
  reset(): void {
    this.dispatches = [];
    this.registered.clear();
    this._errors = 0;
    this._lastDispatchAt = null;
  }

  /** Swap script options at runtime. */
  setOptions(options: MockHarnessOptions): void {
    this.options = options;
  }

  // --- Internals ------------------------------------------------------------

  private resolveResponse(opts: DispatchOpts): MockResponse {
    const candidates: Array<MockResponseLike | undefined> = [
      this.options.bySession?.[opts.sessionKey],
      this.options.byAgent?.[opts.agentId],
      this.options.default,
    ];
    for (const cand of candidates) {
      if (!cand) continue;
      return typeof cand === 'function' ? cand(opts) : cand;
    }
    return DEFAULT_FALLBACK_RESPONSE;
  }

  private async sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    if (signal?.aborted) throw abortError(this.name);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (abortListener) signal?.removeEventListener('abort', abortListener);
        resolve();
      }, ms);
      const abortListener = () => {
        clearTimeout(timer);
        reject(abortError(this.name));
      };
      if (signal) signal.addEventListener('abort', abortListener, { once: true });
    });
  }
}

function tokenize(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

function abortError(harnessName: string): HarnessError {
  return new HarnessError({
    category: 'aborted',
    harnessName,
    message: 'Dispatch aborted by caller',
  });
}
