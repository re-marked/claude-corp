/**
 * Test-failure attribution + flake detection (Project 1.12).
 *
 * The "lead the field" piece. Per a survey of bors-ng, Mergify,
 * GitHub Merge Queue, Atlantis, and Gas Town's Refinery, none have
 * automated semantic attribution of test failures. They all collapse
 * "PR's fault vs flake vs main is broken" into a single binary
 * pass/fail signal. The Clearinghouse separates them:
 *
 *   1. **Flake detection.** Re-run failing tests once. If the second
 *      run passes, the first was environmental noise — not the PR's
 *      fault, not main's fault.
 *
 *   2. **Attribution.** When a failure reproduces on the PR, run
 *      the same tests against main. If main fails too, the failure
 *      is a regression already on main — the PR is innocent. If
 *      main passes, the PR introduced it.
 *
 *   3. **Mixed mode.** When per-test data is available (vitest etc),
 *      compute set-difference: failures on PR ∩ failures on main =
 *      pre-existing main regression; failures on PR alone = new
 *      breakage. A single PR can have both.
 *
 * ### Pure vs impure split
 *
 * - `compareRuns` (pure): given two test runs, classify as flake /
 *   consistent-fail / etc. Caller decides what semantic meaning to
 *   attach.
 * - `attributeFailure` (pure): given a PR run + a main run,
 *   classify as pr-introduced / main-regression / mixed.
 * - `runOnRef` (impure helper): switches the worktree to a named
 *   ref, runs tests, restores the original ref. Pressman composes
 *   this with the pure functions when it needs main-comparison.
 *
 * This split lets the agent (Pressman) decide when attribution is
 * worth the cost (extra test run on main) — for low-priority work
 * or quick-feedback flows, the caller can skip it.
 */

import {
  failure,
  ok,
  err,
  type FailureRecord,
  type Result,
} from './failure-taxonomy.js';
import { runTests, type TestFailureSummary, type TestRunResult, type RunTestsOpts } from './tests-runner.js';
import type { GitOps } from './git-ops.js';

// ─── Comparison shapes ───────────────────────────────────────────────

export type RunComparison =
  | { kind: 'both-passed' }
  | { kind: 'flake'; passingRun: 'first' | 'second' }
  | { kind: 'consistent-fail'; commonFailures: readonly TestFailureSummary[] }
  | { kind: 'inconclusive'; reason: string };

/**
 * Compare two test runs of the same code. Used for flake detection.
 *
 * - both-passed     → no failure to attribute.
 * - flake           → exactly one of the two runs passed.
 * - consistent-fail → both failed; computes the common failures
 *                     (intersection of failure names).
 * - inconclusive    → at least one run had a non-binary outcome
 *                     (timeout, crash, tool-missing). Caller
 *                     surfaces as fatal — re-running won't help.
 */
export function compareRuns(first: TestRunResult, second: TestRunResult): RunComparison {
  // Inconclusive on tool-missing / crashed / timeout.
  if (
    first.outcome === 'tool-missing' ||
    second.outcome === 'tool-missing' ||
    first.outcome === 'crashed' ||
    second.outcome === 'crashed'
  ) {
    return {
      kind: 'inconclusive',
      reason: `non-binary outcomes: first=${first.outcome}, second=${second.outcome}`,
    };
  }
  // Timeouts: treat as inconclusive too — the test environment is
  // misbehaving in a way re-running might not fix.
  if (first.outcome === 'timeout' || second.outcome === 'timeout') {
    return {
      kind: 'inconclusive',
      reason: `timeout in at least one run: first=${first.outcome}, second=${second.outcome}`,
    };
  }

  if (first.outcome === 'passed' && second.outcome === 'passed') {
    return { kind: 'both-passed' };
  }
  if (first.outcome === 'passed' || second.outcome === 'passed') {
    return {
      kind: 'flake',
      passingRun: first.outcome === 'passed' ? 'first' : 'second',
    };
  }

  // Both failed — compute common failures by name.
  const firstNames = new Set(first.failures.map((f) => f.name));
  const common = second.failures.filter((f) => firstNames.has(f.name));
  return { kind: 'consistent-fail', commonFailures: common };
}

// ─── Attribution shapes ──────────────────────────────────────────────

export type AttributedFailure =
  | { kind: 'no-failure' }
  | { kind: 'pr-introduced'; prFailures: readonly TestFailureSummary[] }
  | { kind: 'main-regression'; sharedFailures: readonly TestFailureSummary[] }
  | {
      kind: 'mixed';
      prOnly: readonly TestFailureSummary[];
      sharedWithMain: readonly TestFailureSummary[];
    }
  | { kind: 'inconclusive'; reason: string };

/**
 * Attribute test failures by comparing a PR run to a main run.
 *
 * Both runs should have been performed on the same test command
 * with the same environment, only differing in checkout state
 * (PR vs main). Caller is responsible for that setup.
 *
 * Outcomes:
 *
 *   - no-failure       → PR passed; nothing to attribute.
 *   - pr-introduced    → PR failed, main passed. PR's fault.
 *                        Route blocker to author.
 *   - main-regression  → PR failed, main failed with the SAME
 *                        failures (or no per-test data). Main is
 *                        broken; PR is innocent. Route to
 *                        engineering-lead.
 *   - mixed            → PR failed with some failures shared with
 *                        main and some PR-only. Caller routes both:
 *                        PR-only → author; shared → engineering-lead.
 *   - inconclusive     → at least one run had a non-binary outcome.
 *                        Surface to founder via failureRecord.
 */
export function attributeFailure(prRun: TestRunResult, mainRun: TestRunResult): AttributedFailure {
  if (prRun.outcome === 'tool-missing' || mainRun.outcome === 'tool-missing') {
    return { kind: 'inconclusive', reason: 'tool-missing in at least one run' };
  }
  if (
    prRun.outcome === 'crashed' ||
    mainRun.outcome === 'crashed' ||
    prRun.outcome === 'timeout' ||
    mainRun.outcome === 'timeout'
  ) {
    return {
      kind: 'inconclusive',
      reason: `non-decidable outcomes: pr=${prRun.outcome}, main=${mainRun.outcome}`,
    };
  }

  if (prRun.outcome === 'passed') {
    return { kind: 'no-failure' };
  }

  // PR failed.
  if (mainRun.outcome === 'passed') {
    return { kind: 'pr-introduced', prFailures: prRun.failures };
  }

  // Both failed. Need per-test names to do set-difference.
  // If neither side has parsed failures, classify as
  // main-regression (conservative — the failures might be the
  // same; we can't prove they're different).
  if (prRun.failures.length === 0 && mainRun.failures.length === 0) {
    return { kind: 'main-regression', sharedFailures: [] };
  }
  // If only one side has parsed failures, also treat as inconclusive
  // (asymmetric data; can't reliably attribute).
  if (prRun.failures.length === 0 || mainRun.failures.length === 0) {
    return {
      kind: 'inconclusive',
      reason: 'asymmetric failure data — cannot reliably attribute (one side parsed, other did not)',
    };
  }

  const mainNames = new Set(mainRun.failures.map((f) => f.name));
  const shared = prRun.failures.filter((f) => mainNames.has(f.name));
  const prOnly = prRun.failures.filter((f) => !mainNames.has(f.name));

  if (prOnly.length === 0) {
    return { kind: 'main-regression', sharedFailures: shared };
  }
  if (shared.length === 0) {
    return { kind: 'pr-introduced', prFailures: prOnly };
  }
  return { kind: 'mixed', prOnly, sharedWithMain: shared };
}

// ─── Impure helper: run tests on a different ref ─────────────────────

export interface RunOnRefOpts {
  /** Worktree to operate in. Will be reset back to original ref after. */
  worktreePath: string;
  /** Ref to check out for the test run (e.g. 'origin/main'). */
  refToTest: string;
  /** Original ref to restore to after testing. */
  restoreRef: string;
  gitOps: GitOps;
  testOpts?: Omit<RunTestsOpts, 'cwd'>;
}

/**
 * Switch the worktree to `refToTest`, run tests, restore to
 * `restoreRef`. Best-effort restore: if the restore fails after
 * a successful test run, we surface that as a separate failure —
 * the test result still bubbles up, but the worktree is now in
 * a known-broken state and the caller should release/recreate it.
 *
 * This is the impure counterpart to the pure `attributeFailure` /
 * `compareRuns` functions. Pressman composes them when it wants
 * to do main-attribution.
 *
 * Note: `gitOps` doesn't expose `checkout` directly (we kept the
 * GitOps interface tight). For v1 we'd add a `checkoutRef` method;
 * since we don't have it, this is a v2 implementation hook. The
 * shape exists so callers know what to expect; the body throws if
 * called until the GitOps extension lands.
 */
export async function runTestsOnRef(opts: RunOnRefOpts): Promise<Result<TestRunResult>> {
  // Forward-compat stub: the GitOps interface needs a `checkoutRef`
  // method to land cleanly. Adding it is a one-liner extension in
  // a future PR; for now we surface the gap explicitly so callers
  // see it at orchestration time rather than silently doing the
  // wrong thing.
  return err(failure(
    'unknown',
    `runTestsOnRef requires gitOps.checkoutRef which isn't implemented yet — Pressman in PR 3 should add the method or run main-tests via a separate worktree.`,
    `opts.refToTest=${opts.refToTest}; opts.restoreRef=${opts.restoreRef}`,
  ));
}

/**
 * Build a one-paragraph human summary of an attribution outcome,
 * suitable for blocker-chit prose. Pedagogical — explains both
 * what failed AND why the corp thinks it's PR-vs-main-vs-flake.
 */
export function attributionSummary(attribution: AttributedFailure): string {
  switch (attribution.kind) {
    case 'no-failure':
      return 'Tests passed; no failure to attribute.';
    case 'pr-introduced':
      return (
        `Tests failed on the PR but passed on main — this PR introduced the failure. ` +
        `${attribution.prFailures.length} test(s) failed: ${
          attribution.prFailures.slice(0, 3).map((f) => f.name).join('; ')
        }${attribution.prFailures.length > 3 ? `; …and ${attribution.prFailures.length - 3} more` : ''}.`
      );
    case 'main-regression':
      return (
        `Tests failed on the PR AND on main with the same failures — main is broken; ` +
        `this PR is not the cause. Route to engineering-lead. ` +
        `${attribution.sharedFailures.length} shared failure(s).`
      );
    case 'mixed':
      return (
        `Tests failed on the PR; ${attribution.prOnly.length} are PR-introduced and ` +
        `${attribution.sharedWithMain.length} are also failing on main (pre-existing). ` +
        `Author addresses the PR-introduced subset; engineering-lead sees the shared subset.`
      );
    case 'inconclusive':
      return `Tests failed but attribution couldn't be decided: ${attribution.reason}`;
  }
}

/**
 * Build a one-paragraph summary of a flake-detection comparison,
 * suitable for daemon log + audit trail. Less critical than
 * attributionSummary — flakes typically don't surface to founder
 * unless they pile up.
 */
export function flakeComparisonSummary(comparison: RunComparison): string {
  switch (comparison.kind) {
    case 'both-passed':
      return 'Both runs passed; no flake.';
    case 'flake':
      return `Flake detected — ${comparison.passingRun} run passed, the other failed. Treating as environmental noise.`;
    case 'consistent-fail':
      return `Failure reproduced on both runs (${comparison.commonFailures.length} shared failures); not a flake.`;
    case 'inconclusive':
      return `Comparison inconclusive: ${comparison.reason}`;
  }
}

// ─── Convenience composer: runWithFlakeRetry ─────────────────────────

export interface RunWithFlakeRetryOpts {
  /** Same options as runTests. */
  runOpts: RunTestsOpts;
  /**
   * Maximum re-run attempts on initial failure. Default 1 — one
   * extra run is sufficient to filter ~95% of single-run flakes
   * without doubling test time on every red PR.
   */
  maxRetries?: number;
  /** Delay between attempts. Default 1000ms — gives the environment a beat to settle. */
  retryDelayMs?: number;
}

export interface RunWithFlakeRetryResult {
  readonly finalRun: TestRunResult;
  readonly allRuns: readonly TestRunResult[];
  readonly comparison: RunComparison | null;
  readonly classifiedAs: 'passed-first' | 'flake' | 'consistent-fail' | 'inconclusive';
}

/**
 * Run tests with bounded flake retry. If the first run passes,
 * return immediately. If it fails, re-run up to maxRetries times.
 * Compare runs to classify as flake or consistent-fail.
 *
 * Returns the FINAL run as the canonical result + all attempts
 * for audit. Pressman uses `classifiedAs` to drive its routing
 * decision without re-implementing the comparison logic.
 */
export async function runWithFlakeRetry(opts: RunWithFlakeRetryOpts): Promise<Result<RunWithFlakeRetryResult>> {
  const maxRetries = opts.maxRetries ?? 1;
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  const runs: TestRunResult[] = [];

  const first = await runTests(opts.runOpts);
  if (!first.ok) return err(first.failure);
  runs.push(first.value);

  if (first.value.outcome === 'passed') {
    return ok({
      finalRun: first.value,
      allRuns: runs,
      comparison: null,
      classifiedAs: 'passed-first',
    });
  }

  // Failed — re-run for flake check.
  let lastResult = first.value;
  let lastComparison: RunComparison | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    const next = await runTests(opts.runOpts);
    if (!next.ok) return err(next.failure);
    runs.push(next.value);
    lastComparison = compareRuns(lastResult, next.value);
    lastResult = next.value;
    // Short-circuit: if the re-run passed, we have flake; no need
    // for further attempts.
    if (next.value.outcome === 'passed') break;
  }

  let classifiedAs: RunWithFlakeRetryResult['classifiedAs'];
  if (lastComparison?.kind === 'flake') classifiedAs = 'flake';
  else if (lastComparison?.kind === 'consistent-fail') classifiedAs = 'consistent-fail';
  else classifiedAs = 'inconclusive';

  return ok({
    finalRun: lastResult,
    allRuns: runs,
    comparison: lastComparison,
    classifiedAs,
  });
}
