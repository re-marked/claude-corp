/**
 * AgentHarness — the substrate-agnostic interface for running agent turns.
 *
 * A harness is anything that can take a message + context for a specific agent
 * and produce a response. The canonical implementations are:
 *   - OpenClawHarness — wraps the existing OpenClaw gateway + WebSocket client.
 *   - ClaudeCodeHarness — spawns `claude` subprocesses per dispatch.
 *   - MockHarness — deterministic responses for testing.
 *
 * Claude Corp's daemon never talks to OpenClaw or Claude Code directly — it
 * always goes through `harness.dispatch()`. This keeps the daemon's dispatch
 * logic agnostic to which substrate is actually running an agent.
 *
 * Agent identity, memory, channels, tasks, and culture all live in Claude Corp's
 * filesystem/primitive layer. The harness is responsible only for taking a
 * turn's input and returning its output, with streaming callbacks along the way.
 */

import type { GlobalConfig } from '@claudecorp/shared';
import type { FragmentContext } from '../fragments/index.js';

/** The harness contract every implementation must honor. */
export interface AgentHarness {
  /** Stable identifier for this harness ("openclaw", "claude-code", "mock", …). */
  readonly name: string;

  /** Initialize the harness against a corp. Called once at daemon startup. */
  init(config: HarnessConfig): Promise<void>;

  /** Gracefully shut down any long-running resources. Idempotent. */
  shutdown(): Promise<void>;

  /** Snapshot of the harness's runtime health + telemetry. */
  health(): Promise<HarnessHealth>;

  /**
   * Register an agent with this harness. May be a no-op for harnesses that
   * don't maintain per-agent state (e.g., Claude Code, where the "agent" is
   * just a workspace + a stable session id derived at dispatch time).
   *
   * Harnesses that DO maintain per-agent state (e.g., OpenClaw's gateway
   * registers agents in its config) use this hook to register them.
   */
  addAgent(spec: AgentSpec): Promise<void>;

  /** Unregister an agent. Cleanup + idempotent. */
  removeAgent(agentId: string): Promise<void>;

  /**
   * Run one turn of conversation for the given agent.
   *
   * Callbacks are invoked synchronously as tokens / tool events stream in.
   * The returned promise resolves when the turn fully completes (all tokens
   * received, final lifecycle event observed), or rejects with a HarnessError
   * categorizing the failure.
   *
   * Cancellation: pass `signal` and the harness will abort the underlying
   * operation (ws.close, subprocess.kill, etc.) when the signal fires.
   */
  dispatch(opts: DispatchOpts): Promise<DispatchResult>;
}

/** Per-corp configuration handed to `init()`. */
export interface HarnessConfig {
  /** Absolute path to the corp root directory. */
  corpRoot: string;
  /** Global config (daemon defaults, user gateway info, etc.). */
  globalConfig: GlobalConfig;
}

/** Snapshot returned by `health()`. Used by CLI `cc-cli harness health` + TUI. */
export interface HarnessHealth {
  /** Is the harness currently operational? */
  ok: boolean;
  /** Harness name (denormalized for consumer convenience). */
  name: string;
  /** Milliseconds since the harness was initialized. */
  uptimeMs: number;
  /** Total number of dispatches processed (successful + failed). */
  dispatches: number;
  /** Total number of failed dispatches. */
  errors: number;
  /** Timestamp of the most recent dispatch (ms since epoch). Null if none yet. */
  lastDispatchAt: number | null;
  /** Harness-specific diagnostic info (gateway port, subprocess count, etc.). */
  info?: Record<string, unknown>;
}

/** Input to `addAgent()`. Agents are identified by stable agentId strings. */
export interface AgentSpec {
  /** Stable agent identifier (slug, matches Member.id). */
  agentId: string;
  /** Human-readable name — shown in logs + diagnostics. */
  displayName: string;
  /** Absolute path to the agent's workspace directory. */
  workspace: string;
  /** Model identifier (harness-specific semantics). */
  model?: string;
  /** Provider identifier (harness-specific semantics). */
  provider?: string;
}

/** Input to `dispatch()`. */
export interface DispatchOpts {
  /** The agent to run. Must have been registered via addAgent(). */
  agentId: string;
  /** The user (or originating agent) message to deliver. */
  message: string;
  /**
   * Jack session key. Determines which persistent conversation this turn
   * belongs to (e.g., "say:ceo:mark", "jack:ceo:lead-coder"). Harnesses map
   * this to their native session identity (OpenClaw: used directly;
   * Claude Code: UUIDv5 hash).
   */
  sessionKey: string;
  /** Fragment composition context — used to assemble system instructions. */
  context: FragmentContext;
  /** Streaming callbacks. All optional. */
  callbacks?: DispatchCallbacks;
  /** AbortSignal for caller-initiated cancellation. */
  signal?: AbortSignal;
  /** Override the harness's default turn timeout (ms). */
  timeoutMs?: number;
}

/** Streaming callbacks invoked during a dispatch turn. */
export interface DispatchCallbacks {
  /** Fires on every token delta with the full accumulated response so far. */
  onToken?: (accumulated: string) => void;
  /** Fires when a tool call begins. */
  onToolStart?: (tool: ToolCallInfo) => void;
  /** Fires when a tool call completes (result populated). */
  onToolEnd?: (tool: ToolCallInfo & { result?: string }) => void;
  /** Fires on lifecycle phase transitions (e.g., "slow", "thinking", "end"). */
  onLifecycle?: (phase: string) => void;
}

/** Describes a single tool invocation observed during a dispatch. */
export interface ToolCallInfo {
  /** Tool name as known to the harness (Bash, Read, mcp__foo__bar, etc.). */
  name: string;
  /** Stable id for this call within the dispatch (used to match start→end). */
  toolCallId: string;
  /** Arguments the model passed to the tool, if available. */
  args?: Record<string, unknown>;
  /** Tool result, populated only after end. */
  result?: string;
}

/** Return value of a successful `dispatch()`. */
export interface DispatchResult {
  /** Full assistant content for the turn. */
  content: string;
  /** Model identifier that produced the response (may differ from requested). */
  model: string;
  /** Native session id from the underlying harness, if applicable. */
  sessionId?: string;
  /** Wall-clock duration of the dispatch in milliseconds. */
  durationMs: number;
  /** Tool calls observed during this dispatch, in order. */
  toolCalls: ToolCallInfo[];
}

/** Categorizes a HarnessError for retry/display/telemetry decisions. */
export type HarnessErrorCategory =
  /** Credentials invalid, expired, missing, or insufficient. */
  | 'auth'
  /** Hit a timeout threshold (fast-fail, hard cap, caller abort). */
  | 'timeout'
  /** Caller aborted via AbortSignal. */
  | 'aborted'
  /** Upstream provider rate-limited the request. */
  | 'rate_limit'
  /** WS/HTTP/stdin-stdout connection issue. */
  | 'transport'
  /** Harness returned output that couldn't be parsed. */
  | 'malformed'
  /** Agent hasn't been registered with the harness. */
  | 'unknown_agent'
  /** Anything else. */
  | 'internal';

/** Structured error from a harness. All harnesses should throw these. */
export class HarnessError extends Error {
  readonly category: HarnessErrorCategory;
  readonly harnessName: string;
  override readonly cause?: unknown;

  constructor(opts: {
    category: HarnessErrorCategory;
    harnessName: string;
    message: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'HarnessError';
    this.category = opts.category;
    this.harnessName = opts.harnessName;
    this.cause = opts.cause;
  }
}

/**
 * Factory signature for plugin-style harness registration.
 *
 * Implementations may be async (e.g., to wait for a subprocess to become
 * ready) or sync (e.g., for in-process harnesses like MockHarness).
 */
export type HarnessFactory = (config: HarnessConfig) => Promise<AgentHarness> | AgentHarness;
