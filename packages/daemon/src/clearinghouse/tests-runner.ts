/**
 * Test orchestration for the Clearinghouse (Project 1.12).
 *
 * Spawns the corp's test command with bounded timeout, captures
 * structured output, and returns a typed result the Pressman /
 * attribution layer can act on.
 *
 * ### Why format-agnostic
 *
 * Parsing every test framework's output (vitest, jest, mocha, pytest,
 * cargo test, go test, etc) is a deep rabbit hole. v1 takes the
 * pragmatic path:
 *
 *   - Exit code is the truth (0 = pass, non-zero = fail).
 *   - Raw output is captured (truncated to N KB) for blocker prose
 *     so the author sees what failed.
 *   - Per-test parsing is best-effort: we recognize vitest's
 *     `--reporter=json` output when present (Claude Corp's own
 *     suite is vitest), and fall through to "no per-test data"
 *     for everything else.
 *
 * Pressman doesn't need per-test data to operate. The flake
 * detector + attribution use the same exit-code-and-output shape.
 *
 * ### Config
 *
 * Test command resolution order:
 *   1. opts.command (caller-provided, e.g. from corp.json).
 *   2. CLEARINGHOUSE_TEST_COMMAND env var.
 *   3. Fallback: 'pnpm test'.
 *
 * Caller controls the test command per corp; this module just runs
 * it.
 *
 * ### Output capture limits
 *
 * Raw output gets truncated to MAX_OUTPUT_BYTES (256KB) to prevent
 * a chatty test suite from blowing chit size limits. Truncation
 * preserves the head + tail with a marker in between.
 */

import { execa, ExecaError } from 'execa';
import { failure, ok, err, hasErrnoCode, type Result } from './failure-taxonomy.js';

// ─── Config ──────────────────────────────────────────────────────────

/** Default per-run timeout. 10 minutes covers most realistic suites. */
export const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Output capture cap. Larger values get truncated (head + tail kept). */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/** Fallback when no command is configured. */
export const DEFAULT_TEST_COMMAND = 'pnpm test';

// ─── Shape ───────────────────────────────────────────────────────────

export type TestOutcome =
  | 'passed' // exit 0
  | 'failed' // non-zero exit, completed normally
  | 'timeout' // exceeded timeout, killed
  | 'crashed' // signal-killed or non-int exit code (shouldn't happen but defensive)
  | 'tool-missing'; // command binary not found

export interface TestRunResult {
  readonly outcome: TestOutcome;
  /** Total wall-clock duration in ms. */
  readonly durationMs: number;
  /** Captured stdout, possibly truncated. Always populated. */
  readonly stdout: string;
  /** Captured stderr, possibly truncated. Always populated. */
  readonly stderr: string;
  /** Process exit code, when available. */
  readonly exitCode?: number;
  /** True when the output was truncated. */
  readonly truncated: boolean;
  /**
   * Best-effort per-test failure list when we can parse the format.
   * Empty when parsing wasn't possible OR all tests passed.
   */
  readonly failures: readonly TestFailureSummary[];
}

export interface TestFailureSummary {
  /** Test name as the framework reported it (e.g. "describe > it"). */
  readonly name: string;
  /** Short error message — first line of the framework's reported error. */
  readonly summary: string;
}

// ─── Runner ──────────────────────────────────────────────────────────

export interface RunTestsOpts {
  /** Working directory the test command runs in. Typically a worktree path. */
  cwd: string;
  /**
   * Override the test command in shell-style string form. Falls back
   * to env then DEFAULT_TEST_COMMAND. Tokenized by whitespace —
   * does NOT respect quoting. Use the structured `program` + `args`
   * shape when you need quoted arguments.
   */
  command?: string;
  /**
   * Structured override (overrides `command` when both supplied).
   * Lets callers pass exact program + args without worrying about
   * shell tokenization.
   */
  program?: string;
  args?: readonly string[];
  /** Override the per-run timeout. */
  timeoutMs?: number;
  /** Extra env vars merged into process.env. */
  env?: Record<string, string>;
}

/**
 * Spawn the configured test command, capture output with bounded
 * size + duration, return a structured result.
 *
 * Never throws for expected failure modes (test failure, timeout,
 * crash). Throws only for programmer-error situations (bad opts).
 *
 * The Result wrapper is for spawn-level errors that the caller
 * shouldn't have to wrap — tool missing, etc.
 */
export async function runTests(opts: RunTestsOpts): Promise<Result<TestRunResult>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const startedAt = Date.now();

  // Resolve program + args. Structured override wins over the
  // shell-style string. The string path tokenizes by whitespace
  // (good enough for the canonical `pnpm test` shape; not for
  // commands with quoted arguments — use the structured shape there).
  let program: string;
  let args: readonly string[];
  if (opts.program) {
    program = opts.program;
    args = opts.args ?? [];
  } else {
    const command = opts.command ?? process.env.CLEARINGHOUSE_TEST_COMMAND ?? DEFAULT_TEST_COMMAND;
    const tokens = command.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      return err(failure('tool-missing', `Empty test command`, `command='${command}'`));
    }
    program = tokens[0]!;
    args = tokens.slice(1);
  }

  let result: Awaited<ReturnType<typeof execa>>;
  try {
    result = await execa(program!, args, {
      cwd: opts.cwd,
      timeout: timeoutMs,
      reject: false,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      encoding: 'utf8',
      stdio: 'pipe',
      // Buffer caps inside execa so the captured streams don't grow
      // unbounded. We truncate further on our end.
      maxBuffer: MAX_OUTPUT_BYTES * 2,
    });
  } catch (cause) {
    if (hasErrnoCode(cause, 'ENOENT')) {
      return err(failure(
        'tool-missing',
        `Test command '${program}' not found on PATH. Configure CLEARINGHOUSE_TEST_COMMAND or install the runner.`,
        cause instanceof Error ? cause.stack ?? cause.message : String(cause),
      ));
    }
    return err(failure(
      'unknown',
      `Test command spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause instanceof Error ? cause.stack ?? cause.message : String(cause),
    ));
  }

  const durationMs = Date.now() - startedAt;
  const { truncated: stdoutTruncated, output: stdout } = truncateOutput(stringify(result.stdout));
  const { truncated: stderrTruncated, output: stderr } = truncateOutput(stringify(result.stderr));
  const truncated = stdoutTruncated || stderrTruncated;

  let outcome: TestOutcome;
  if (result.timedOut) {
    outcome = 'timeout';
  } else if (result.signal) {
    outcome = 'crashed';
  } else if (result.exitCode === 0) {
    outcome = 'passed';
  } else if (typeof result.exitCode === 'number') {
    outcome = 'failed';
  } else {
    outcome = 'crashed';
  }

  // Best-effort vitest JSON failure parsing when stdout looks like
  // JSON. Falls through silently when format doesn't match.
  const failures = outcome === 'failed' ? extractFailures(stdout) : [];

  return ok({
    outcome,
    durationMs,
    stdout,
    stderr,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : undefined,
    truncated,
    failures,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

interface TruncateResult {
  truncated: boolean;
  output: string;
}

/**
 * Truncate a string keeping head + tail with a separator marker.
 * Preserves the head (where setup/early failures land) and tail
 * (where summary lines live) so the captured output stays useful
 * for diagnosis.
 */
function truncateOutput(s: string): TruncateResult {
  if (s.length <= MAX_OUTPUT_BYTES) return { truncated: false, output: s };
  const half = Math.floor((MAX_OUTPUT_BYTES - 200) / 2);
  const head = s.slice(0, half);
  const tail = s.slice(-half);
  const marker = `\n\n…[truncated ${s.length - MAX_OUTPUT_BYTES + 200} bytes]…\n\n`;
  return { truncated: true, output: head + marker + tail };
}

/**
 * Best-effort parser for per-test failure data. Recognizes:
 *
 *   1. Vitest's standard FAIL line shape:
 *      `FAIL  tests/foo.test.ts > describe-name > it-name`
 *      followed by an indented error block.
 *
 * Falls through to empty when no recognizable failures found.
 *
 * Future formats can be added here as more recognizers without
 * affecting callers — the empty-array result is the safe default.
 */
function extractFailures(stdout: string): TestFailureSummary[] {
  const failures: TestFailureSummary[] = [];
  const lines = stdout.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Vitest FAIL marker.
    const match = /^\s*(?:✗|✘|FAIL|×)\s+(.+?)(?:\s+\d+(?:\.\d+)?(?:ms|s))?$/.exec(line);
    if (!match) continue;
    const name = match[1]!.trim();
    if (!name || name.length > 500) continue;
    // Look ahead a few lines for the error message.
    let summary = '';
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const next = lines[j]!.trim();
      if (next.length === 0) continue;
      // Skip vitest's location/expected/received scaffolding lines.
      if (/^[─⎯]+/.test(next)) continue;
      if (/^Test Files|^Tests\s+\d/.test(next)) break;
      summary = next.slice(0, 300);
      break;
    }
    failures.push({ name, summary: summary || '(no error message captured)' });
  }
  return failures;
}
