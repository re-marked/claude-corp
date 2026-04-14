/**
 * ClaudeCodeHarness — AgentHarness implementation backed by the
 * @anthropic-ai/claude-code CLI.
 *
 * Per dispatch:
 *   1. Derive a stable Claude Code session UUID from the Jack key
 *      (uuidv5 via session-id.ts) so resume always lands on the same
 *      on-disk session file.
 *   2. Spawn `claude -p --session-id <uuid> --output-format stream-json
 *      --include-partial-messages --add-dir <workspace>` with cwd =
 *      agent workspace.
 *   3. Pipe the dispatch message to subprocess stdin.
 *   4. Stream-json NDJSON lines from stdout get parsed by
 *      ClaudeCodeStreamParser and translated into Claude Corp's
 *      DispatchCallbacks (onToken, onToolStart, onToolEnd, onLifecycle).
 *   5. Resolve when result envelope arrives (or process exits with
 *      0 + accumulated content). Reject with categorized HarnessError
 *      otherwise.
 *
 * Context loading (CLAUDE.md generation, system-prompt files, fragment
 * adaptation) is PR 4. PR 3 ships the dispatch plumbing only — agents
 * spawned through this harness today don't yet have their identity
 * loaded, but the substrate works.
 *
 * Subprocesses are ephemeral — spawned per dispatch, exit when done.
 * Session continuity is provided entirely by Claude Code's on-disk
 * session files (`~/.claude/projects/<slug>/<uuid>.jsonl`).
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { log, logError } from '../logger.js';
import { ClaudeCodeStreamParser, type ClaudeCodeEvent } from './claude-code-stream.js';
import { sessionIdFor } from './session-id.js';
import {
  type AgentHarness,
  type AgentSpec,
  type DispatchOpts,
  type DispatchResult,
  type HarnessConfig,
  type HarnessHealth,
  type ToolCallInfo,
  type HarnessErrorCategory,
  HarnessError,
} from './types.js';

/** Subset of Node's ChildProcess we depend on — kept narrow so tests can mock it. */
export interface ClaudeChildProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ClaudeSpawnOptions {
  cwd: string;
}

/** Spawn function signature — defaults to node:child_process.spawn, override for tests. */
export type ClaudeSpawnFn = (
  binary: string,
  args: string[],
  options: ClaudeSpawnOptions,
) => ClaudeChildProcess;

export interface ClaudeCodeHarnessDeps {
  /** Path to the claude binary. Default: 'claude' (resolved via PATH). */
  binaryPath?: string;
  /** Spawn function. Default: node:child_process.spawn. Override for tests. */
  spawn?: ClaudeSpawnFn;
  /** Hard timeout per dispatch (ms). Default: 15 minutes. */
  defaultTimeoutMs?: number;
  /**
   * Directory for opt-in raw stream-json transcript capture. When set,
   * each dispatch writes its NDJSON to a timestamped file under this
   * directory for replay-style debugging. Defaults to env var
   * CLAUDECORP_CCH_CAPTURE_DIR or undefined.
   */
  captureDir?: string;
}

interface DispatchInternalState {
  resolvedContent: string;
  resolvedSessionId: string;
  resolvedModel: string;
  errorEvent: { message: string; isOverloaded: boolean } | null;
  toolCalls: ToolCallInfo[];
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 5_000;

export class ClaudeCodeHarness implements AgentHarness {
  readonly name = 'claude-code';

  private binaryPath: string;
  private spawnFn: ClaudeSpawnFn;
  private defaultTimeoutMs: number;
  private captureDir?: string;

  private startedAt = 0;
  private _binaryAvailable = false;
  private _binaryVersion: string | null = null;
  private _lastRateLimit: Record<string, unknown> | null = null;
  private _dispatches = 0;
  private _errors = 0;
  private _lastDispatchAt: number | null = null;
  private _totalCostUsd = 0;
  private _lastDispatchCostUsd: number | null = null;

  constructor(deps: ClaudeCodeHarnessDeps = {}) {
    this.binaryPath = deps.binaryPath ?? 'claude';
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.captureDir = deps.captureDir ?? process.env.CLAUDECORP_CCH_CAPTURE_DIR;
  }

  async init(_config: HarnessConfig): Promise<void> {
    this.startedAt = Date.now();
    // Pre-flight binary check is non-fatal: daemon should still start
    // even when claude isn't installed. Routing to claude-code from an
    // agent will then fail at dispatch with a helpful HarnessError(auth)
    // pointing the user at the install instructions.
    try {
      this._binaryVersion = await this.runVersionCheck();
      this._binaryAvailable = true;
      log(`[harness:claude-code] init complete — claude ${this._binaryVersion}`);
    } catch (err) {
      this._binaryAvailable = false;
      this._binaryVersion = null;
      log(`[harness:claude-code] init: claude binary unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  async shutdown(): Promise<void> {
    // No long-lived resources — subprocesses are ephemeral per dispatch.
  }

  async health(): Promise<HarnessHealth> {
    return {
      ok: this._binaryAvailable,
      name: this.name,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      dispatches: this._dispatches,
      errors: this._errors,
      lastDispatchAt: this._lastDispatchAt,
      info: {
        binaryAvailable: this._binaryAvailable,
        binaryVersion: this._binaryVersion,
        lastRateLimit: this._lastRateLimit,
        captureEnabled: !!this.captureDir,
        totalCostUsd: round6(this._totalCostUsd),
        lastDispatchCostUsd: this._lastDispatchCostUsd,
      },
    };
  }

  async addAgent(_spec: AgentSpec): Promise<void> {
    // No per-agent state — claude is invoked fresh per dispatch with cwd =
    // agent workspace and --add-dir <workspace>. Agent identity / context
    // arrives via the workspace files (loaded in PR 4).
  }

  async removeAgent(_agentId: string): Promise<void> {
    // No-op — no per-agent state to clean up.
  }

  async dispatch(opts: DispatchOpts): Promise<DispatchResult> {
    const start = Date.now();
    this._dispatches += 1;
    this._lastDispatchAt = start;

    if (opts.signal?.aborted) {
      this._errors += 1;
      throw new HarnessError({
        category: 'aborted',
        harnessName: this.name,
        message: 'Dispatch aborted before it started',
      });
    }

    if (!this._binaryAvailable) {
      this._errors += 1;
      throw new HarnessError({
        category: 'auth',
        harnessName: this.name,
        message: 'Claude Code binary not available. Install with: npm install -g @anthropic-ai/claude-code',
      });
    }

    const sessionId = sessionIdFor(opts.sessionKey);
    const workspace = resolveWorkspace(opts);

    const args = [
      '-p',
      '--session-id', sessionId,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--add-dir', workspace,
    ];

    return this.runOneDispatch(opts, args, sessionId, workspace, start);
  }

  // --- Internals ----------------------------------------------------------

  private runOneDispatch(
    opts: DispatchOpts,
    args: string[],
    sessionId: string,
    workspace: string,
    start: number,
  ): Promise<DispatchResult> {
    const parser = new ClaudeCodeStreamParser();
    const state: DispatchInternalState = {
      resolvedContent: '',
      resolvedSessionId: sessionId,
      resolvedModel: this._binaryVersion ? `claude-code/${this._binaryVersion}` : 'claude-code',
      errorEvent: null,
      toolCalls: [],
    };

    let captureStream: { write: (line: string) => void; close: () => void } | null = null;
    if (this.captureDir) {
      try {
        captureStream = openCaptureStream(this.captureDir, opts.agentId, sessionId);
      } catch (err) {
        logError(`[harness:claude-code] capture init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return new Promise<DispatchResult>((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      let abortListener: (() => void) | null = null;
      let settled = false;
      let stderrBuf = '';
      let stdoutBuf = '';

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (abortListener && opts.signal) opts.signal.removeEventListener('abort', abortListener);
        captureStream?.close();
      };

      const settle = (cb: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        cb();
      };

      let child: ClaudeChildProcess;
      try {
        child = this.spawnFn(this.binaryPath, args, { cwd: workspace });
      } catch (err) {
        this._errors += 1;
        return reject(new HarnessError({
          category: 'transport',
          harnessName: this.name,
          message: `Failed to spawn claude: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        }));
      }

      // Write the user message to stdin. Wrap in try/catch since stdin
      // can EPIPE if claude exited early (e.g., binary was found but
      // crashed during arg parsing).
      try {
        child.stdin.end(opts.message + '\n');
      } catch (err) {
        logError(`[harness:claude-code] stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const handleEvent = (event: ClaudeCodeEvent) => {
        this.translateEvent(event, opts.callbacks, state);
      };

      child.stdout.on('data', (chunk: string | Buffer) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        if (captureStream) captureStream.write(text);
        stdoutBuf += text;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) parser.parseLine(line, handleEvent);
      });

      child.stderr.on('data', (chunk: string | Buffer) => {
        stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });

      child.on('error', (err) => {
        // Spawn-time errors (binary missing, EACCES, etc.) surface here.
        settle(() => {
          this._errors += 1;
          reject(new HarnessError({
            category: 'transport',
            harnessName: this.name,
            message: `claude subprocess error: ${err.message}`,
            cause: err,
          }));
        });
      });

      child.on('exit', (code, signal) => {
        // Drain any final partial line.
        if (stdoutBuf.trim()) {
          parser.parseLine(stdoutBuf, handleEvent);
          stdoutBuf = '';
        }

        settle(() => {
          opts.callbacks?.onLifecycle?.('end');

          if (state.errorEvent) {
            this._errors += 1;
            reject(new HarnessError({
              category: state.errorEvent.isOverloaded ? 'rate_limit' : (categorizeStderr(stderrBuf) ?? 'internal'),
              harnessName: this.name,
              message: state.errorEvent.message,
            }));
            return;
          }

          if (signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGKILL') {
            this._errors += 1;
            // Aborted via caller signal vs killed by timeout — distinguish by
            // checking opts.signal first. Timeouts set their own rejection
            // before this handler runs in normal flow.
            const cause: HarnessErrorCategory = opts.signal?.aborted ? 'aborted' : 'aborted';
            reject(new HarnessError({
              category: cause,
              harnessName: this.name,
              message: `claude dispatch killed by ${signal}`,
            }));
            return;
          }

          if (code !== 0) {
            this._errors += 1;
            const stderrCategory = categorizeStderr(stderrBuf);
            reject(new HarnessError({
              category: stderrCategory ?? 'internal',
              harnessName: this.name,
              message: stderrToMessage(stderrBuf) || `claude exited with code ${code}`,
            }));
            return;
          }

          const finalContent = state.resolvedContent || parser.getAccumulatedText();
          resolve({
            content: finalContent,
            model: state.resolvedModel,
            sessionId: state.resolvedSessionId,
            durationMs: Date.now() - start,
            toolCalls: state.toolCalls,
          });
        });
      });

      // Caller cancellation: SIGINT the subprocess; the exit handler
      // resolves the rejection with category=aborted.
      if (opts.signal) {
        abortListener = () => {
          try { child.kill('SIGINT'); } catch {}
        };
        opts.signal.addEventListener('abort', abortListener, { once: true });
      }

      // Hard timeout: SIGKILL after the configured cap.
      const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timeoutHandle = setTimeout(() => {
          if (settled) return;
          try { child.kill('SIGKILL'); } catch {}
          settle(() => {
            this._errors += 1;
            reject(new HarnessError({
              category: 'timeout',
              harnessName: this.name,
              message: `claude dispatch exceeded ${Math.round(timeoutMs / 1000)}s`,
            }));
          });
        }, timeoutMs);
      }
    });
  }

  private translateEvent(
    event: ClaudeCodeEvent,
    callbacks: DispatchOpts['callbacks'],
    state: DispatchInternalState,
  ): void {
    switch (event.type) {
      case 'init':
        if (event.sessionId) state.resolvedSessionId = event.sessionId;
        if (event.model) state.resolvedModel = event.model;
        break;

      case 'token':
        callbacks?.onToken?.(event.accumulated);
        break;

      case 'tool_call': {
        const info: ToolCallInfo = {
          name: event.name,
          toolCallId: event.toolCallId,
          args: event.args,
        };
        state.toolCalls.push({ ...info });
        callbacks?.onToolStart?.(info);
        // Claude Code executes tools internally in --print mode; the
        // result feeds back into the next assistant turn rather than
        // surfacing as a discrete event. Fire onToolEnd immediately
        // with no result so Claude Corp's downstream observers see a
        // matched start/end pair.
        callbacks?.onToolEnd?.({ ...info });
        break;
      }

      case 'lifecycle':
        callbacks?.onLifecycle?.(event.phase);
        break;

      case 'rate_limit':
        this._lastRateLimit = event.info;
        break;

      case 'assistant_message':
        // Full assistant text — already streamed via tokens. Use as
        // fallback content if no result event arrives (defensive).
        if (!state.resolvedContent && event.content) {
          state.resolvedContent = event.content;
        }
        break;

      case 'result_success':
        state.resolvedContent = event.content;
        if (event.sessionId) state.resolvedSessionId = event.sessionId;
        if (typeof event.cost === 'number' && Number.isFinite(event.cost)) {
          this._totalCostUsd += event.cost;
          this._lastDispatchCostUsd = event.cost;
        }
        break;

      case 'result_error':
        state.errorEvent = {
          message: event.message,
          isOverloaded: !!event.isOverloaded,
        };
        if (event.sessionId) state.resolvedSessionId = event.sessionId;
        break;

      case 'malformed':
        logError(`[harness:claude-code] malformed stream-json line (${event.reason}): ${event.raw.slice(0, 200)}`);
        break;
    }
  }

  private runVersionCheck(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: ClaudeChildProcess;
      try {
        child = this.spawnFn(this.binaryPath, ['--version'], { cwd: process.cwd() });
      } catch (err) {
        return reject(err);
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (cb: () => void) => {
        if (settled) return;
        settled = true;
        cb();
      };

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        settle(() => reject(new Error(`claude --version timed out after ${VERSION_CHECK_TIMEOUT_MS}ms`)));
      }, VERSION_CHECK_TIMEOUT_MS);

      child.stdout.on('data', (chunk: string | Buffer) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });
      child.stderr.on('data', (chunk: string | Buffer) => {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        settle(() => reject(err));
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        settle(() => {
          if (code === 0) {
            resolve(stdout.trim() || 'unknown');
          } else {
            reject(new Error(stderr.trim() || `claude --version exited with ${code}`));
          }
        });
      });
    });
  }
}

function defaultSpawn(binary: string, args: string[], options: ClaudeSpawnOptions): ClaudeChildProcess {
  const child: ChildProcess = nodeSpawn(binary, args, {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error('node spawn returned a child without piped stdio');
  }
  return child as unknown as ClaudeChildProcess;
}

/**
 * Resolve an absolute workspace path for a dispatch. Reads the
 * FragmentContext that accompanies every dispatch — agentDir is
 * relative to corpRoot, so we join the two. Falls back to corpRoot if
 * agentDir is missing.
 */
function resolveWorkspace(opts: DispatchOpts): string {
  const ctx = opts.context as { corpRoot?: string; agentDir?: string };
  const corpRoot = ctx.corpRoot ?? process.cwd();
  const agentDir = ctx.agentDir ?? '';
  return agentDir ? join(corpRoot, agentDir) : corpRoot;
}

/**
 * Categorize stderr text into a HarnessErrorCategory. Returns null when
 * nothing recognizable is matched (caller falls back to 'internal').
 */
function categorizeStderr(stderr: string): HarnessErrorCategory | null {
  const text = stderr.toLowerCase();
  if (/\bnot logged in\b|\/login|please log in|run.*login/i.test(stderr)) return 'auth';
  if (/\benoent\b.*claude|command not found.*claude|spawn claude/i.test(stderr)) return 'auth';
  if (/rate.?limit|429|usage.*exceeded|quota/i.test(text)) return 'rate_limit';
  if (/timed?\s*out|deadline.*exceeded/i.test(text)) return 'timeout';
  if (/connection|econnrefused|enotfound|network/i.test(text)) return 'transport';
  return null;
}

function stderrToMessage(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  return lines.slice(-3).join('\n').slice(0, 500);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function openCaptureStream(dir: string, agentId: string, sessionId: string) {
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${ts}-${agentId}-${sessionId.slice(0, 8)}.ndjson`);
  let buf = '';
  return {
    write(chunk: string) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) writeFileSync(file, line + '\n', { flag: 'a' });
      }
    },
    close() {
      if (buf.trim()) writeFileSync(file, buf + '\n', { flag: 'a' });
      buf = '';
    },
  };
}
