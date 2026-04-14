/**
 * ClaudeCodeHarness — AgentHarness implementation backed by the
 * @anthropic-ai/claude-code CLI.
 *
 * Per dispatch:
 *   1. Derive a stable Claude Code session UUID from the Jack key
 *      (uuidv5 via session-id.ts) so the same pair of agents always
 *      converges on the same on-disk session file.
 *   2. Check whether `~/.claude/projects/*\/<uuid>.jsonl` already
 *      exists. If yes → the session is established, pass
 *      `--resume <uuid>` to continue it. If no → first dispatch, pass
 *      `--session-id <uuid>` to create with that specific UUID. Claude
 *      CLI rejects `--session-id` on an already-existing UUID with
 *      "Session ID X is already in use", which is what this branching
 *      prevents.
 *   3. Spawn `claude -p <continuation-flag> <uuid> --output-format
 *      stream-json --include-partial-messages --add-dir <workspace>`
 *      with cwd = agent workspace.
 *   4. Pipe the dispatch message to subprocess stdin.
 *   5. Stream-json NDJSON lines from stdout get parsed by
 *      ClaudeCodeStreamParser and translated into Claude Corp's
 *      DispatchCallbacks (onToken, onToolStart, onToolEnd, onLifecycle).
 *   6. Resolve when result envelope arrives (or process exits with
 *      0 + accumulated content). Reject with categorized HarnessError
 *      otherwise.
 *
 * Subprocesses are ephemeral — spawned per dispatch, exit when done.
 * Session continuity is provided entirely by Claude Code's on-disk
 * session files (`~/.claude/projects/<slug>/<uuid>.jsonl`), plus the
 * --session-id/--resume branching above.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { log, logError } from '../logger.js';
import { ClaudeCodeStreamParser, type ClaudeCodeEvent } from './claude-code-stream.js';
import { sessionIdFor } from './session-id.js';
import { findExecutableInPath } from './spawn-utils.js';
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
    // Resolve the binary to an absolute path so every subsequent spawn
    // skips PATH search and shell wrappers. Node's spawn behavior with
    // bare names is observably inconsistent on Windows in some daemon
    // process contexts, and falling back to shell-mode introduces its
    // own ComSpec-related failures under MSYS/git-bash. Absolute path
    // sidesteps both.
    const resolved = findExecutableInPath(this.binaryPath);
    if (resolved) {
      log(`[harness:claude-code] resolved binary: ${resolved}`);
      this.binaryPath = resolved;
    } else {
      log(`[harness:claude-code] could not resolve "${this.binaryPath}" via PATH; spawn will rely on Node's lookup`);
    }

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

    // First dispatch for this sessionId must use --session-id (creates a
    // new conversation with that specific UUID). Every subsequent dispatch
    // with the same sessionId must use --resume (continues the existing
    // one) — claude rejects --session-id when a session with that UUID
    // already exists ("Session ID X is already in use"). Detection is
    // filesystem-based so it survives daemon restarts: the session file
    // lives at ~/.claude/projects/<encoded-workspace>/<uuid>.jsonl.
    const sessionHasHistory = claudeSessionFileExists(sessionId);
    const continuationFlag = sessionHasHistory ? '--resume' : '--session-id';

    // Resolve the agent's configured model. Each hire writes
    // { model, provider } to the agent's workspace config.json; if
    // provider is Anthropic we pass --model to claude so per-agent
    // overrides (e.g., Planner on opus, CEO on sonnet) actually take
    // effect. Previously the harness ignored config.json.model entirely
    // — every claude-code dispatch ran on claude's global default.
    // Non-anthropic models are meaningless to the claude CLI (the
    // harness is Anthropic-substrate by definition), so we skip the
    // flag rather than pass something claude would reject.
    const modelOverride = resolveAnthropicModel(workspace);

    const args = [
      '-p',
      continuationFlag, sessionId,
      ...(modelOverride ? ['--model', modelOverride] : []),
      '--output-format', 'stream-json',
      // --verbose is REQUIRED when combining --print + --output-format=stream-json.
      // Without it, claude exits with stderr:
      //   "When using --print, --output-format=stream-json requires --verbose"
      // The flag enables full event emission (init, lifecycle, deltas, result),
      // which is exactly what our parser consumes.
      '--verbose',
      '--include-partial-messages',
      // --dangerously-skip-permissions is REQUIRED for autonomous agents:
      // claude's default permission mode pauses tool calls (Bash, Edit,
      // Write, etc.) for interactive approval that nobody can give in a
      // headless dispatch. Without this flag, agents hang the moment they
      // try to run any tool, which is most of what Claude Corp agents do.
      // The "dangerously" framing assumes a human at the terminal — for
      // agents in a corp, autonomous tool use IS the design.
      '--dangerously-skip-permissions',
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

      case 'text_block_complete':
        // Forward each completed text block so callers can persist
        // them block-by-block. Without this, only the final block
        // (via result_success.content) survives a multi-block dispatch.
        callbacks?.onAssistantText?.(event.text);
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
  // Spawn with no shell. The harness pre-resolves `binary` to an
  // absolute path via findExecutableInPath at init time so PATH search
  // inside Node's spawn isn't relied on (see spawn-utils.ts for the
  // empirical reasoning). windowsHide:true keeps a child cmd window
  // from flashing if Node ever does internally invoke a shell wrapper.
  const child: ChildProcess = nodeSpawn(binary, args, {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error('node spawn returned a child without piped stdio');
  }
  return child as unknown as ClaudeChildProcess;
}

/**
 * Resolve an absolute workspace path for a dispatch. Reads the
 * FragmentContext.
 *
 * agentDir convention is loose across the codebase: api.ts /cc/say
 * provides it as an ABSOLUTE path (already joined with corpRoot, with
 * forward-slash normalization), while heartbeat.ts and router.ts
 * provide it as the RELATIVE Member.agentDir. Handle both — when
 * absolute, use as-is; when relative, join with corpRoot.
 *
 * Without this, joining an already-absolute agentDir with corpRoot
 * produces an invalid path like `C:/.../corp/C:/.../corp/agents/ceo`,
 * which Node spawn surfaces as a misleading ENOENT against the binary
 * (it's actually the cwd that doesn't exist).
 */
function resolveWorkspace(opts: DispatchOpts): string {
  const ctx = opts.context as { corpRoot?: string; agentDir?: string };
  const corpRoot = ctx.corpRoot ?? process.cwd();
  const agentDir = ctx.agentDir;
  if (!agentDir) return corpRoot;
  return isAbsolute(agentDir) ? agentDir : join(corpRoot, agentDir);
}

/**
 * Read the agent's config.json and return its model only when the
 * configured provider resolves to Anthropic — the only family claude
 * accepts for `--model`. Returns null when:
 *   - config.json is missing / unreadable
 *   - no model field is set
 *   - provider is something other than anthropic/claude (e.g., an
 *     openclaw agent's openai-codex leaking through; we'd rather
 *     drop the flag than have claude reject it with a cryptic error)
 *
 * Model names pass through verbatim — claude accepts both aliases
 * ('sonnet', 'opus', 'haiku') and full ids ('claude-sonnet-4-6').
 */
function resolveAnthropicModel(workspace: string): string | null {
  const configPath = join(workspace, 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      model?: string;
      provider?: string;
    };
    if (!raw.model || typeof raw.model !== 'string') return null;
    const providerLooksAnthropic =
      !raw.provider ||
      raw.provider === 'anthropic' ||
      raw.provider === 'claude' ||
      raw.model.startsWith('claude-') ||
      raw.model === 'sonnet' ||
      raw.model === 'opus' ||
      raw.model === 'haiku';
    return providerLooksAnthropic ? raw.model : null;
  } catch {
    return null;
  }
}

/**
 * Does claude already have a session file for this UUID?
 *
 * Session files live at `~/.claude/projects/<encoded-workspace>/<uuid>.jsonl`
 * where the encoding claude uses is implementation-defined (we've observed
 * colon/slash/backslash/dot → dash on Windows, but relying on that would
 * be brittle). Instead we scan every sibling directory under ~/.claude/
 * projects/ for the session filename — session UUIDs are globally unique
 * (uuidv5 from a fixed namespace + jackKey), so a match anywhere in the
 * tree is proof this specific session already exists.
 *
 * Used to decide between `--session-id <uuid>` (first dispatch — creates)
 * and `--resume <uuid>` (subsequent dispatches — continues). Claude
 * rejects `--session-id` for an already-in-use UUID with "Session ID X
 * is already in use", which is exactly the bug this check prevents.
 */
function claudeSessionFileExists(sessionId: string): boolean {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return false;
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(projectsDir, entry.name, `${sessionId}.jsonl`))) {
        return true;
      }
    }
  } catch {
    // Permission error reading the projects dir — treat as not-exists so
    // we default to --session-id. Worst case: a legitimate resume fails
    // with "already in use" and the user sees a specific error.
  }
  return false;
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
