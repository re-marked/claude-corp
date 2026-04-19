/**
 * OpenClawHarness — AgentHarness implementation backed by OpenClaw's gateway.
 *
 * Wraps the existing `dispatchToAgent` + OpenClawWS plumbing behind the
 * harness interface. This is a zero-behavior-change adapter: every dispatch
 * still goes through the same WS (preferred) or HTTP SSE (fallback) code path.
 *
 * Per-agent wsClient selection (remote vs corp gateway) stays the same as
 * what daemon call sites did inline before this refactor — now centralized
 * here so daemon code is harness-agnostic.
 *
 * Agent lifecycle (spawn, register with corp gateway, terminate) remains
 * owned by ProcessManager + CorpGateway in PR 1. `addAgent`/`removeAgent`
 * are no-ops here for that reason — future PRs can migrate lifecycle into
 * the harness when it makes sense to do so.
 */

import { dispatchToAgent } from '../dispatch.js';
import type { OpenClawWS } from '../openclaw-ws.js';
import type { ProcessManager } from '../process-manager.js';
import { log, logError } from '../logger.js';
import {
  type AgentHarness,
  type AgentSpec,
  type DispatchOpts,
  type DispatchResult,
  type HarnessConfig,
  type HarnessHealth,
  type ToolCallInfo,
  HarnessError,
} from './types.js';

export interface OpenClawHarnessDeps {
  /** Source of truth for agent process records (port, mode, model, token). */
  processManager: ProcessManager;
  /** Returns the user's OpenClaw gateway WS client, or null if unavailable. */
  getUserGatewayWS: () => OpenClawWS | null;
  /** Returns the corp's internal OpenClaw gateway WS client, or null if unavailable. */
  getCorpGatewayWS: () => OpenClawWS | null;
}

export class OpenClawHarness implements AgentHarness {
  readonly name = 'openclaw';

  private deps: OpenClawHarnessDeps;
  private startedAt = 0;
  private _dispatches = 0;
  private _errors = 0;
  private _lastDispatchAt: number | null = null;

  constructor(deps: OpenClawHarnessDeps) {
    this.deps = deps;
  }

  async init(_config: HarnessConfig): Promise<void> {
    this.startedAt = Date.now();
    log('[harness:openclaw] init');
  }

  async shutdown(): Promise<void> {
    // OpenClaw's WS clients + gateway subprocess are owned by the daemon
    // (connectOpenClawWS, CorpGateway). This harness is a thin adapter;
    // its own shutdown is a no-op beyond logging.
    log('[harness:openclaw] shutdown');
  }

  async health(): Promise<HarnessHealth> {
    const userGw = this.deps.getUserGatewayWS();
    const corpGw = this.deps.getCorpGatewayWS();
    const userConnected = userGw?.isConnected() ?? false;
    const corpConnected = corpGw?.isConnected() ?? false;
    return {
      ok: userConnected || corpConnected,
      name: this.name,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      dispatches: this._dispatches,
      errors: this._errors,
      lastDispatchAt: this._lastDispatchAt,
      info: {
        userGatewayConnected: userConnected,
        corpGatewayConnected: corpConnected,
        agentCount: this.deps.processManager.listAgents().length,
      },
    };
  }

  async addAgent(_spec: AgentSpec): Promise<void> {
    // PR 1: no-op. Agent lifecycle stays with ProcessManager + CorpGateway,
    // unchanged. Future PRs can migrate registration responsibility here
    // once per-harness routing is in place.
  }

  async removeAgent(_agentId: string): Promise<void> {
    // PR 1: no-op. See addAgent above.
  }

  async dispatch(opts: DispatchOpts): Promise<DispatchResult> {
    const start = Date.now();
    this._dispatches += 1;
    this._lastDispatchAt = start;

    const agentProc = this.deps.processManager.getAgent(opts.agentId);
    if (!agentProc) {
      this._errors += 1;
      throw new HarnessError({
        category: 'unknown_agent',
        harnessName: this.name,
        message: `Agent "${opts.agentId}" not registered with process manager`,
      });
    }

    const wsClient = agentProc.mode === 'remote'
      ? this.deps.getUserGatewayWS()
      : this.deps.getCorpGatewayWS();

    // Collect tool calls for DispatchResult telemetry while still forwarding
    // them to caller callbacks.
    const toolCalls: ToolCallInfo[] = [];
    const { callbacks } = opts;

    const onToolStart = (tool: ToolCallInfo) => {
      toolCalls.push({ ...tool });
      callbacks?.onToolStart?.(tool);
    };
    const onToolEnd = (tool: ToolCallInfo & { result?: string }) => {
      const existing = toolCalls.find((t) => t.toolCallId === tool.toolCallId);
      if (existing) {
        existing.result = tool.result;
        if (tool.args !== undefined) existing.args = tool.args;
      } else {
        toolCalls.push({ ...tool });
      }
      callbacks?.onToolEnd?.(tool);
    };

    // Pre-check signal before we spawn any work — otherwise a rejected
    // dispatchPromise would be abandoned and show up as an unhandled
    // rejection.
    if (opts.signal?.aborted) {
      this._errors += 1;
      throw new HarnessError({
        category: 'aborted',
        harnessName: this.name,
        message: 'Dispatch aborted before it started',
      });
    }

    // AbortSignal support: when the caller aborts, fire chat.abort on
    // the gateway so the provider stream + in-flight tool calls actually
    // stop server-side. Track the runId via onRunStarted so we can abort
    // precisely (not just by sessionKey — that would kill sibling runs
    // on the same session, which matters once we unify to one session
    // per agent in PR 2/3).
    //
    // Race: if the caller aborts before chat.send resolves with a
    // runId, fall back to aborting by sessionKey (wider but correct).
    // We also queue the intent so the post-runId abort lands if the
    // signal fires during the chatSend round-trip.
    let capturedRunId: string | null = null;
    let abortIntentFired = false;

    const dispatchPromise = dispatchToAgent(
      agentProc,
      opts.message,
      opts.context,
      opts.sessionKey,
      callbacks?.onToken,
      wsClient,
      {
        onToolStart,
        onToolEnd,
        onRunStarted: (runId) => {
          capturedRunId = runId;
          // Signal fired before we had a runId → apply it now.
          if (abortIntentFired && wsClient?.isConnected()) {
            void wsClient.chatAbort({
              sessionKey: opts.sessionKey,
              runId,
              stopReason: 'caller-abort',
            }).catch(() => { /* best-effort */ });
          }
        },
      },
    );

    let abortPromise: Promise<never> | null = null;
    let abortListener: (() => void) | null = null;
    if (opts.signal) {
      abortPromise = new Promise<never>((_, reject) => {
        abortListener = () => {
          abortIntentFired = true;
          // Fire server-side abort. Precise when we have a runId;
          // wider (sessionKey-scoped) otherwise.
          if (wsClient?.isConnected()) {
            const abortParams: Parameters<typeof wsClient.chatAbort>[0] = {
              sessionKey: opts.sessionKey,
              stopReason: 'caller-abort',
            };
            if (capturedRunId) abortParams.runId = capturedRunId;
            void wsClient.chatAbort(abortParams).catch(() => { /* best-effort */ });
          }
          reject(new HarnessError({
            category: 'aborted',
            harnessName: this.name,
            message: 'Dispatch aborted by caller',
          }));
        };
        opts.signal!.addEventListener('abort', abortListener, { once: true });
      });
    }

    try {
      const result = abortPromise
        ? await Promise.race([dispatchPromise, abortPromise])
        : await dispatchPromise;

      return {
        content: result.content,
        model: result.model,
        sessionId: opts.sessionKey,
        durationMs: Date.now() - start,
        toolCalls,
      };
    } catch (err) {
      this._errors += 1;
      throw err instanceof HarnessError ? err : this.normalizeError(err);
    } finally {
      if (opts.signal && abortListener) {
        opts.signal.removeEventListener('abort', abortListener);
      }
    }
  }

  /**
   * Map a raw error from dispatchToAgent / WS client to a categorized
   * HarnessError. Keeps matching to thrown Error `.message` text since
   * that's what the underlying dispatch layer surfaces.
   */
  private normalizeError(err: unknown): HarnessError {
    const message = err instanceof Error ? err.message : String(err);

    if (/timed out|timeout/i.test(message)) {
      return new HarnessError({ category: 'timeout', harnessName: this.name, message, cause: err });
    }
    if (/\b401\b|unauthorized|auth/i.test(message)) {
      return new HarnessError({ category: 'auth', harnessName: this.name, message, cause: err });
    }
    if (/\b429\b|rate.?limit|overload/i.test(message)) {
      return new HarnessError({ category: 'rate_limit', harnessName: this.name, message, cause: err });
    }
    if (/websocket|ECONNREFUSED|socket hang up|ENOTFOUND|connect/i.test(message)) {
      return new HarnessError({ category: 'transport', harnessName: this.name, message, cause: err });
    }

    logError(`[harness:openclaw] uncategorized error: ${message}`);
    return new HarnessError({ category: 'internal', harnessName: this.name, message, cause: err });
  }
}
