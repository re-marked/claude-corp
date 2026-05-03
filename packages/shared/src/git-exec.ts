/**
 * git-exec.ts — safe synchronous git shell-out for walk-aware audit
 * (Project 2.1) and future consumers (Sexton patrols, Clearinghouse
 * health checks). One-purpose helper: spawn `git` with array args, no
 * shell, with classified error outcomes that map cleanly onto the
 * three-state CheckResult contract from walk.ts.
 *
 * ### Why sync, not async
 *
 * Audit (Project 2.3) is synchronous: cc-cli audit reads chits, runs
 * the gate, exits. Making the checker async would cascade into
 * audit/done/the Stop hook chain. Sync execFileSync blocks the
 * process for up to 10s per call, which is fine because:
 *   - Audit fires from the Stop hook — the agent's session is
 *     already paused waiting for the decision.
 *   - The 10s default timeout is a hard ceiling; runaway git commands
 *     can't trap us.
 *   - Sync API keeps walk.ts checker functions pure-function-shaped,
 *     trivially testable.
 *
 * If a future use case actually needs async (parallel checks across
 * many tasks for a Sexton patrol, e.g.) we can add an async sibling
 * without touching the sync surface.
 *
 * ### Why no shell
 *
 * `execFileSync('git', args, opts)` invokes git directly with array
 * args — no shell interpolation, no quoting concerns, no injection
 * surface. Templated patterns from blueprints (`feat/{{feature}}`)
 * arrive as concrete strings post-Handlebars; passing them as args
 * is safe regardless of their content (special chars, spaces, etc.
 * are passed through literally to git's argv).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Outcome of a safeGitExec call. Discriminates execution-level
 * states; STDERR-content classification (e.g. "fatal: not a git
 * repository" → unable-to-check vs "fatal: ambiguous argument" →
 * unmet-for-this-checker) is checker-specific and lives in the
 * caller, not here.
 *
 *   - `ok`               — git ran, exit code 0. stdout / stderr captured.
 *   - `cmd-failed`       — git ran, exit code non-zero. Caller inspects
 *                          stderr to decide unmet vs unable.
 *   - `cmd-not-found`    — git binary not in PATH (ENOENT spawning).
 *                          Always unable-to-check; environment lacks git.
 *   - `cwd-missing`      — opts.cwd doesn't exist as a directory.
 *                          Pre-checked before spawn so we don't waste a
 *                          process start on a doomed call. Always
 *                          unable-to-check; the worktree path was
 *                          mis-resolved or the dir was deleted.
 *   - `permission-denied`— EACCES on git binary or cwd. Unable-to-check.
 *   - `timeout`          — execFileSync killed the child after timeoutMs.
 *                          Unable-to-check; either the repo is huge or
 *                          git is hung. Sexton kink surfaces repeats.
 *   - `other`            — unknown spawn error (rare; defensive bucket).
 *                          Treat as unable-to-check upstream.
 */
export type GitExecOutcome =
  | 'ok'
  | 'cmd-failed'
  | 'cmd-not-found'
  | 'cwd-missing'
  | 'permission-denied'
  | 'timeout'
  | 'other';

export interface SafeGitExecResult {
  /** Outcome class — see GitExecOutcome docstring. */
  readonly outcome: GitExecOutcome;
  /** Captured stdout (utf-8). Empty when spawn failed. */
  readonly stdout: string;
  /** Captured stderr (utf-8). Empty when spawn failed. May contain useful classification info on cmd-failed (e.g. "fatal: not a git repository"). */
  readonly stderr: string;
  /** Exit code on `ok` (0) or `cmd-failed` (non-zero). Null when the process didn't reach completion (cmd-not-found, cwd-missing, timeout, etc.). */
  readonly exitCode: number | null;
  /** Wall-clock duration of the call in milliseconds. Useful for diagnostics; surfaces slow-git cases via audit logs. */
  readonly durationMs: number;
}

export interface SafeGitExecOpts {
  /**
   * Working directory for the git invocation. Required — passing a
   * relative path here would resolve against process.cwd() which is
   * unpredictable when called from a daemon. Pre-checked for existence
   * before spawn to short-circuit doomed calls.
   */
  readonly cwd: string;
  /**
   * Timeout in milliseconds. Default 10_000 (10s). When exceeded,
   * execFileSync sends SIGTERM and the result outcome is `timeout`.
   * Set higher for known-slow repos; set lower for hot-path checks
   * where blocking is unacceptable.
   */
  readonly timeoutMs?: number;
  /**
   * Max output buffer in bytes. Default 10 MB. git operations we care
   * about (branch --list, log --format=%H) produce small outputs, so
   * the default is generous. If a command would exceed this, the
   * call fails with `cmd-failed` (Node's MAXBUFFER error).
   */
  readonly maxBufferBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Spawn git synchronously with classified error outcomes. Pure on
 * the input args + cwd state; the only side effect is the child
 * process invocation (no fs writes, no chit mutation).
 *
 * Outcome mapping is deterministic for callers — every Node error
 * shape is bucketed into a GitExecOutcome variant, so checkers can
 * pattern-match without inspecting raw error properties.
 */
export function safeGitExec(
  args: readonly string[],
  opts: SafeGitExecOpts,
): SafeGitExecResult {
  const start = Date.now();

  // Pre-check cwd. execFileSync would fail with ENOENT on the cwd
  // anyway, but the error shape (errno on the spawn vs on the
  // file lookup) varies by platform; pre-check makes the outcome
  // unambiguous and shaves a process start when we already know
  // the answer.
  if (!existsSync(opts.cwd)) {
    return {
      outcome: 'cwd-missing',
      stdout: '',
      stderr: `cwd does not exist: ${opts.cwd}`,
      exitCode: null,
      durationMs: Date.now() - start,
    };
  }

  try {
    const stdout = execFileSync('git', [...args], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: 'utf-8',
      maxBuffer: opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
      // stdio: pipe so we capture stdout + stderr separately. Default
      // for execFileSync is already pipe; explicit for clarity.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      outcome: 'ok',
      stdout,
      stderr: '', // execFileSync only returns stdout on success.
      exitCode: 0,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number | null;
      signal?: NodeJS.Signals | null;
    };
    const stdout = bufferOrStringToString(e.stdout);
    const stderr = bufferOrStringToString(e.stderr);
    const durationMs = Date.now() - start;

    // ENOENT on spawn = git binary not found. Distinct from
    // cwd-missing (we pre-checked cwd above; a post-check ENOENT
    // here is the binary).
    if (e.code === 'ENOENT') {
      return {
        outcome: 'cmd-not-found',
        stdout: '',
        stderr: 'git binary not found in PATH',
        exitCode: null,
        durationMs,
      };
    }
    if (e.code === 'EACCES') {
      return {
        outcome: 'permission-denied',
        stdout,
        stderr: stderr || (e.message ?? 'permission denied'),
        exitCode: null,
        durationMs,
      };
    }
    // Killed by signal → timeout (we set the timeout option; SIGTERM
    // is the default kill signal). signal could also be SIGKILL on
    // some platforms; both indicate the process didn't exit normally
    // because of the timeout.
    if (e.signal) {
      return {
        outcome: 'timeout',
        stdout,
        stderr,
        exitCode: null,
        durationMs,
      };
    }
    // Non-zero exit. e.status is the exit code. e.code may be the
    // string version of the same (e.g. '128') — prefer e.status.
    if (typeof e.status === 'number') {
      return {
        outcome: 'cmd-failed',
        stdout,
        stderr,
        exitCode: e.status,
        durationMs,
      };
    }
    // Catch-all defensive bucket. Shouldn't reach in practice; map
    // to `other` so callers know to treat as unable-to-check.
    return {
      outcome: 'other',
      stdout,
      stderr: stderr || (e.message ?? 'unknown spawn error'),
      exitCode: null,
      durationMs,
    };
  }
}

function bufferOrStringToString(v: Buffer | string | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return v.toString('utf-8');
}
