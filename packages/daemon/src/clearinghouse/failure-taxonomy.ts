/**
 * Failure taxonomy (Project 1.12).
 *
 * Every operation in the Clearinghouse pipeline (rebase, test run,
 * merge, push) can fail in qualitatively different ways, and the
 * Pressman/Editor agents need to act on those differences:
 *
 *   - A network timeout retries with backoff.
 *   - A test flake retries once, then re-runs to confirm.
 *   - A substantive merge conflict files a blocker.
 *   - A trivial conflict gets auto-resolved.
 *   - A push race re-rebases and re-pushes silently.
 *   - A hook rejection surfaces the hook output to the author.
 *   - Disk full pages the founder.
 *   - A missing tool binary halts the lane.
 *
 * Threading raw error strings through the pipeline loses these
 * distinctions. This module defines the shared vocabulary every
 * primitive emits, so consumers can route by category without
 * regex-matching on stderr.
 *
 * ### Design choices
 *
 * - Categories are exhaustive enough to drive distinct retry
 *   strategies but not so granular that consumers care about the
 *   exact subtype (we track 12, not 50). A future need can split
 *   a category without changing call sites that switch on it.
 *
 * - Each FailureRecord carries `pedagogicalSummary` (human-facing,
 *   1-2 sentences, suitable for blocker-chit prose) plus
 *   `rawDetail` (full error text for daemon logs). Pressman writes
 *   the summary into review-comment / blocker chits; the raw goes
 *   to the structured log so chit-hygiene can inspect later.
 *
 * - `retryable` + `retryDelayMs` are advisory hints, not commands.
 *   The orchestrator decides whether to actually retry based on the
 *   submission's `retryCount` vs the cap. A category being
 *   retryable doesn't override the cap.
 *
 * - The `route` field tells consumers WHO should see the failure
 *   when retries exhaust:
 *     'author'  — patch is broken; route blocker to author's role.
 *     'engineering-lead' — main branch is broken (regression on
 *                          main); the PR is innocent. Escalate up.
 *     'founder' — corp infrastructure is broken (disk full, tool
 *                 missing, network down). Tier-3 inbox.
 */

export type FailureCategory =
  // Rebase outcomes
  | 'rebase-conflict-trivial' // whitespace-only/comment-only — auto-resolvable
  | 'rebase-conflict-substantive' // real semantic conflict — needs author
  | 'rebase-sanity-check-failed' // post-rebase diff blew up unexpectedly (corruption, weird state)
  // Test outcomes
  | 'test-flake' // re-run resolved; advisory only
  | 'test-real-fail' // failure reproduces; PR's fault
  | 'test-main-regression' // failure also on main; PR is innocent, main is broken
  | 'test-timeout' // tests hung past hard timeout
  | 'test-crashed' // test process crashed (non-zero exit before completion)
  // Push outcomes
  | 'push-rejection-race' // someone pushed in between; re-rebase + retry
  | 'push-rejection-hook' // origin hook rejected; surface hook output to author
  // Infrastructure
  | 'network-timeout' // git fetch/push timed out
  | 'disk-full' // ENOSPC during worktree/checkout
  | 'tool-missing' // git or pnpm or gh not on PATH
  | 'branch-deleted' // PR branch gone from origin
  | 'unknown'; // unclassified — treat as fatal, surface to founder

export type FailureRoute = 'author' | 'engineering-lead' | 'founder';

export interface FailureRecord {
  /** Which category this failure belongs to. */
  readonly category: FailureCategory;
  /**
   * One-paragraph human-readable summary. Goes into blocker-chit /
   * review-comment prose and Sexton's wake digest. Should read as a
   * complete sentence the founder/author could act on cold.
   */
  readonly pedagogicalSummary: string;
  /**
   * Full error text — stderr, exit codes, stack traces. Goes to
   * daemon log; not surfaced to founder unless they ask via
   * `cc-cli clearinghouse show <submission-id>`.
   */
  readonly rawDetail: string;
  /**
   * Advisory: should the orchestrator retry this operation? The
   * orchestrator is free to ignore based on retry-budget exhaustion.
   */
  readonly retryable: boolean;
  /**
   * Suggested delay before retry. Used for backoff on
   * network/disk/race categories. Absent for non-retryable.
   */
  readonly retryDelayMs?: number;
  /**
   * Where the failure surfaces if/when retries exhaust. Drives the
   * blocker-chit recipient via 1.4.1 role-resolver.
   */
  readonly route: FailureRoute;
}

/**
 * Classification metadata per category — defaults the consumer can
 * override. Centralizes the "is this retryable / where does it
 * route" decisions so call sites just produce the category and
 * narrative; the classifier fills in the rest.
 */
const CATEGORY_DEFAULTS: Record<FailureCategory, { retryable: boolean; retryDelayMs?: number; route: FailureRoute }> = {
  'rebase-conflict-trivial': { retryable: true, retryDelayMs: 0, route: 'author' },
  'rebase-conflict-substantive': { retryable: false, route: 'author' },
  'rebase-sanity-check-failed': { retryable: true, retryDelayMs: 5000, route: 'engineering-lead' },
  'test-flake': { retryable: true, retryDelayMs: 1000, route: 'author' }, // advisory; usually not surfaced
  'test-real-fail': { retryable: false, route: 'author' },
  'test-main-regression': { retryable: false, route: 'engineering-lead' },
  'test-timeout': { retryable: true, retryDelayMs: 5000, route: 'author' },
  'test-crashed': { retryable: true, retryDelayMs: 5000, route: 'author' },
  'push-rejection-race': { retryable: true, retryDelayMs: 2000, route: 'author' },
  'push-rejection-hook': { retryable: false, route: 'author' },
  'network-timeout': { retryable: true, retryDelayMs: 10_000, route: 'founder' },
  'disk-full': { retryable: false, route: 'founder' },
  'tool-missing': { retryable: false, route: 'founder' },
  'branch-deleted': { retryable: false, route: 'author' },
  unknown: { retryable: false, route: 'founder' },
};

/**
 * Build a FailureRecord from category + narrative. Pulls retry/route
 * defaults from the category, allows override for special cases.
 */
export function failure(
  category: FailureCategory,
  pedagogicalSummary: string,
  rawDetail: string,
  overrides: Partial<Pick<FailureRecord, 'retryable' | 'retryDelayMs' | 'route'>> = {},
): FailureRecord {
  const defaults = CATEGORY_DEFAULTS[category];
  const result: FailureRecord = {
    category,
    pedagogicalSummary,
    rawDetail,
    retryable: overrides.retryable ?? defaults.retryable,
    route: overrides.route ?? defaults.route,
  };
  const retryDelay = overrides.retryDelayMs ?? defaults.retryDelayMs;
  if (retryDelay !== undefined) {
    return { ...result, retryDelayMs: retryDelay };
  }
  return result;
}

/**
 * True if `cause` is a Node.js Error with a code matching one of
 * the supplied codes — a tiny helper so call sites can write
 * `if (hasErrnoCode(err, 'ENOSPC'))` without crawling through `as`
 * casts.
 */
export function hasErrnoCode(cause: unknown, ...codes: string[]): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return codes.includes(code);
}

/**
 * Classify a Node `Error.code` (errno-string) onto our taxonomy.
 * Doesn't cover every errno, just the ones the Clearinghouse cares
 * about. Falls through to 'unknown' for anything unrecognized so
 * the caller can wrap with their own context.
 */
export function categorizeErrno(code: string | undefined): FailureCategory | undefined {
  if (!code) return undefined;
  switch (code) {
    case 'ENOSPC':
      return 'disk-full';
    case 'ENOENT':
      // Tool missing OR file missing. Caller decides; we just
      // suggest a category and let the wrapper provide context.
      return 'tool-missing';
    case 'ETIMEDOUT':
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'network-timeout';
    default:
      return undefined;
  }
}

/**
 * Discriminated-union `Result<T>` for primitives that can either
 * return a value or a structured failure. Avoids throwing for
 * expected failure modes (so call sites don't try/catch around
 * everything) while still making "I failed and here's why" a typed
 * outcome the orchestrator can switch on.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; failure: FailureRecord };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(failure: FailureRecord): Result<T> {
  return { ok: false, failure };
}
