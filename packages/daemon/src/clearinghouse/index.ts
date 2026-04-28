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

// ─── workflow ────────────────────────────────────────────────────────
// Stateless step primitives the Pressman session calls via cc-cli
// clearinghouse subcommands. Each primitive runs in a fresh CLI
// process, returns Result<T>, and operates only on on-disk state.
export {
  pickNext,
  acquireWorktree,
  rebaseStep,
  testStep,
  mergeStep,
  finalizeMerged,
  fileBlocker,
  markFailedAndRelease,
  releaseAll,
  cleanupOrphanWorktrees,
  DEFAULT_BASE_BRANCH,
  PRESSMAN_RETRY_CAP,
} from './workflow.js';
export type {
  PickedSubmission,
  PickNextOpts,
  AcquireWorktreeOpts,
  AcquiredWorktree,
  RebaseStepOpts,
  TestStepOpts,
  MergeStepOpts,
  FinalizeMergedOpts,
  FileBlockerOpts,
  FileBlockerResult,
  BlockerKind,
  MarkFailedAndReleaseOpts,
  MarkFailedAndReleaseResult,
  ReleaseAllOpts,
  CleanupOrphanWorktreesOpts,
  CleanupOrphanWorktreesResult,
} from './workflow.js';

// ─── pressman ────────────────────────────────────────────────────────
// Convenience hire for the Pressman Employee. NOT auto-called from
// daemon boot — Pressman is founder opt-in via `cc-cli hire --role
// pressman` (which auto-loads the operational manual). This export
// is for tests + the future bacteria-scaling integration.
export {
  hirePressman,
  buildPressmanRules,
} from './pressman.js';
export type {
  HirePressmanOpts,
  HirePressmanResult,
} from './pressman.js';

// ─── pressman-runtime ────────────────────────────────────────────────
// Wake dispatch + reactive watcher + Pulse-fallback sweep. Wired into
// daemon.ts at start. Pressman session walks patrol/clearing on each
// wake; the runtime decides only WHEN to wake.
export {
  dispatchPressman,
  ClearanceSubmissionWatcher,
  clearinghouseSweep,
  clearinghouseBootRecover,
  CLEARINGHOUSE_SWEEP_INTERVAL_MS,
} from './pressman-runtime.js';

// ─── editor-workflow ─────────────────────────────────────────────────
// Stateless step primitives for the Editor lane. Editor session
// composes these via cc-cli editor subcommands per the
// patrol/code-review blueprint. Lane state lives on the task chit
// (editorReviewRound / capHit / requested / reviewerClaim /
// branchUnderReview) since Editor runs PRE-submission.
export {
  isEditorAwareCorp,
  setEditorReviewRequested,
  pickNextReview,
  acquireEditorWorktree,
  loadReviewContext,
  fileReviewComment,
  approveReview,
  rejectReview,
  bypassReview,
  releaseReview,
} from './editor-workflow.js';
export type {
  PickedReview,
  ReviewContext,
  ApproveReviewResult,
  RejectReviewResult,
  BypassReviewResult,
  PickNextReviewOpts,
  AcquireEditorWorktreeOpts,
  LoadReviewContextOpts,
  FileReviewCommentOpts,
  FileReviewCommentResult,
  ApproveReviewOpts,
  RejectReviewOpts,
  BypassReviewOpts,
  ReleaseReviewOpts,
  SetEditorReviewRequestedOpts,
} from './editor-workflow.js';
