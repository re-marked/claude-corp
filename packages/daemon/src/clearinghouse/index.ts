/**
 * Clearinghouse code primitives — public surface (Project 1.12).
 *
 * The exoskeleton Pressman + Editor agents call into. Substrate
 * (chits, helpers) lives in `@claudecorp/shared`; this package is
 * the daemon-side primitives that operate on the working tree
 * (git ops, test orchestration, conflict classification, diff
 * computation).
 *
 * ### Module map
 *
 *   failure-taxonomy   — typed FailureCategory + FailureRecord +
 *                        Result<T> shape used everywhere.
 *   git-ops            — low-level git wrappers (interface + real
 *                        impl backed by execa).
 *   worktree-pool      — pool of pre-created worktrees with
 *                        reuse + orphan cleanup.
 *   conflict-classifier — pure parser + classifier of merge
 *                        conflict markers; auto-resolution
 *                        suggestor for trivial cases.
 *   rebase-flow        — high-level rebase orchestrator: rebase +
 *                        classify + auto-resolve + sanity-check.
 *   merge-flow         — high-level merge orchestrator: push +
 *                        race detection + hook-rejection capture.
 *   tests-runner       — bounded subprocess + structured output
 *                        for the corp's test command.
 *   test-attribution   — flake detection + PR-vs-main attribution
 *                        (the lead-the-field piece).
 *   editor-diff        — Editor-facing metadata + filtering +
 *                        size guard + comment validation.
 */

// ─── failure-taxonomy ────────────────────────────────────────────────
export {
  failure,
  ok,
  err,
  hasErrnoCode,
  categorizeErrno,
} from './failure-taxonomy.js';
export type {
  FailureCategory,
  FailureRoute,
  FailureRecord,
  Result,
} from './failure-taxonomy.js';

// ─── git-ops ─────────────────────────────────────────────────────────
export {
  realGitOps,
  parseShortstat,
  parseWorktreeListPorcelain,
  normalizeWorktreePath,
  DEFAULT_GIT_TIMEOUT_MS,
  SLOW_GIT_TIMEOUT_MS,
} from './git-ops.js';
export type {
  GitOps,
  DiffStats,
  RebaseOutcome,
  MergeOutcome,
  PushOutcome,
  WorktreeEntry,
} from './git-ops.js';

// ─── worktree-pool ───────────────────────────────────────────────────
export {
  WorktreePool,
  createWorktreePool,
  DEFAULT_POOL_CAP,
  WORKTREE_PARENT_DIR,
  WORKTREE_GITIGNORE,
} from './worktree-pool.js';
export type {
  WorktreeHandle,
  WorktreePoolOpts,
} from './worktree-pool.js';

// ─── conflict-classifier ─────────────────────────────────────────────
export {
  parseConflictMarkers,
  classifyBlock,
  classifyFile,
  suggestResolution,
  applyResolutions,
  isCommentLine,
} from './conflict-classifier.js';
export type {
  ConflictTriviality,
  ConflictBlock,
  ClassifiedFile,
} from './conflict-classifier.js';

// ─── rebase-flow ─────────────────────────────────────────────────────
export {
  attemptRebase,
  SANITY_FILE_MULTIPLIER,
  SANITY_FLOOR_FILE_COUNT,
  MAX_AUTO_RESOLUTION_ROUNDS,
} from './rebase-flow.js';
export type {
  RebaseAttemptOutcome,
  RebaseAttemptResult,
  AttemptRebaseOpts,
  ConflictSummary,
} from './rebase-flow.js';

// ─── merge-flow ──────────────────────────────────────────────────────
export {
  attemptMerge,
  verifyMergeReachability,
} from './merge-flow.js';
export type {
  MergeAttemptOutcome,
  MergeAttemptResult,
  AttemptMergeOpts,
} from './merge-flow.js';

// ─── tests-runner ────────────────────────────────────────────────────
export {
  runTests,
  DEFAULT_TEST_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  DEFAULT_TEST_COMMAND,
} from './tests-runner.js';
export type {
  TestOutcome,
  TestRunResult,
  TestFailureSummary,
  RunTestsOpts,
} from './tests-runner.js';

// ─── test-attribution ────────────────────────────────────────────────
export {
  compareRuns,
  attributeFailure,
  attributionSummary,
  flakeComparisonSummary,
  runWithFlakeRetry,
  runTestsOnRef,
} from './test-attribution.js';
export type {
  RunComparison,
  AttributedFailure,
  RunOnRefOpts,
  RunWithFlakeRetryOpts,
  RunWithFlakeRetryResult,
} from './test-attribution.js';

// ─── editor-diff ─────────────────────────────────────────────────────
export {
  computeReviewableDiff,
  shouldFilterFile,
  validateCommentPosition,
  parseNumstatOutput,
  parseNameStatusOutput,
  normalizeRenamePath,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_LINES,
} from './editor-diff.js';
export type {
  FileStatus,
  ReviewableFile,
  FilteredFile,
  ReviewableDiff,
  ComputeReviewableDiffOpts,
  ValidateCommentPositionOpts,
  CommentValidationResult,
} from './editor-diff.js';

// ─── enter-clearance ─────────────────────────────────────────────────
// Bridge from audit-approve to merge-lane (Project 1.12 PR 3). Called
// by `cc-cli audit`'s approve path on 1.12-aware corps; pushes the
// branch, creates the clearance-submission chit, advances the task
// workflow status. Replaces the user-typed `cc-cli clear` ceremony.
export {
  enterClearance,
  isClearinghouseAwareCorp,
} from './enter-clearance.js';
export type {
  EnterClearanceOpts,
  EnterClearanceResult,
} from './enter-clearance.js';
