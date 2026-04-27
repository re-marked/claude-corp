/**
 * High-level rebase orchestrator (Project 1.12).
 *
 * Composes git-ops + worktree-pool + conflict-classifier into the
 * full Pressman rebase workflow:
 *
 *   1. Capture pre-rebase diff stats (anchor for sanity check).
 *   2. Run `git rebase <base>`.
 *   3. On clean: capture post-stats, sanity-check, return.
 *   4. On conflict:
 *        a. List conflicted files.
 *        b. Classify each via the conflict-classifier.
 *        c. If ALL files fully-trivial → apply auto-resolutions
 *           in-place, stage, continue rebase, retry from step 3.
 *        d. If ANY file substantive → abort, return needs-author.
 *   5. Post-rebase sanity check: if post-diff is wildly larger than
 *      pre-diff (e.g. 5× file count growth), abort and return
 *      sanity-failed. Catches corrupt rebases, accidental merges,
 *      stale-base scenarios where main moved into a different
 *      branch entirely.
 *
 * ### Why the sanity check matters
 *
 * Spec calls it the "200-files-on-2-line-PR" guard. A rebase that
 * suddenly touches an order of magnitude more files than the PR
 * originally did almost always means something broke in the rebase
 * — wrong base resolved, accidental cherry-pick of a long history,
 * or a script-generated file that's not actually part of the PR.
 * Better to bail and surface than to merge nonsense.
 *
 * ### What this orchestrator does NOT do
 *
 * - It does not push. Caller's merge-flow handles that.
 * - It does not run tests. Caller decides when to test post-rebase.
 * - It does not write blockers. Caller decides routing based on
 *   the typed outcome.
 *
 * ### Outcome shape
 *
 * Returns RebaseAttemptResult with one of five outcomes:
 *
 *   'clean'         — rebase landed without conflicts.
 *   'auto-resolved' — rebase hit trivial conflicts only; fixed.
 *   'needs-author'  — substantive conflicts; orchestrator aborted.
 *                     Caller routes a blocker to the author's role.
 *   'sanity-failed' — rebase succeeded but post-stats blew up.
 *                     Caller treats as needs-engineering-lead.
 *   'fatal'         — git itself failed (network, disk, etc).
 *                     Caller surfaces via the failureRecord.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  failure,
  ok,
  err,
  type FailureRecord,
  type Result,
} from './failure-taxonomy.js';
import { classifyFile, applyResolutions, type ClassifiedFile } from './conflict-classifier.js';
import { type DiffStats, type GitOps, type RebaseOutcome } from './git-ops.js';

// ─── Config ──────────────────────────────────────────────────────────

/**
 * Sanity threshold: post-rebase diff fileCount > pre × this multiplier
 * triggers sanity-failed. 5× balances caught-corruption against
 * legitimate merges (a PR that touches 3 files normally and 16 after
 * rebase is suspicious; one that touches 3 and ends at 12 is fine).
 */
export const SANITY_FILE_MULTIPLIER = 5;

/**
 * Sanity floor: a tiny PR (≤2 files pre) gets a hardcoded ceiling
 * instead of multiplying. Prevents 2 × 5 = 10 from being the cap on
 * a 2-file PR (small PRs can legitimately grow during rebase).
 */
export const SANITY_FLOOR_FILE_COUNT = 20;

/**
 * Cap on auto-resolution rounds. If after applying trivial
 * resolutions the next continue still produces conflicts, we go
 * around. This caps the loop. Three rounds covers cascading
 * trivial conflicts; deeper than that smells substantive.
 */
export const MAX_AUTO_RESOLUTION_ROUNDS = 3;

// ─── Outcome shape ───────────────────────────────────────────────────

export type RebaseAttemptOutcome =
  | 'clean'
  | 'auto-resolved'
  | 'needs-author'
  | 'sanity-failed'
  | 'fatal';

export interface RebaseAttemptResult {
  readonly outcome: RebaseAttemptOutcome;
  /** Files that ended in substantive conflict; populated when outcome='needs-author'. */
  readonly conflictedFiles?: readonly string[];
  /** Files the orchestrator auto-resolved; populated when outcome='auto-resolved'. */
  readonly autoResolvedFiles?: readonly string[];
  /** Per-block summaries of substantive conflicts — for blocker chit prose. */
  readonly conflictSummaries?: readonly ConflictSummary[];
  /** Diff stats vs the base before rebase started. */
  readonly preStats?: DiffStats;
  /** Diff stats vs the base after rebase landed. */
  readonly postStats?: DiffStats;
  /** Populated when outcome='fatal' — the underlying git failure. */
  readonly failureRecord?: FailureRecord;
  /** Number of auto-resolution rounds it took (when outcome='auto-resolved'). */
  readonly autoResolutionRounds?: number;
}

export interface ConflictSummary {
  readonly filePath: string;
  readonly substantiveBlockCount: number;
  readonly worstTriviality: ClassifiedFile['worstTriviality'];
}

// ─── The orchestrator ────────────────────────────────────────────────

export interface AttemptRebaseOpts {
  worktreePath: string;
  /** Branch to rebase onto. Typically `origin/main`. */
  baseBranch: string;
  /** The PR's branch (used to compute pre-stats vs base). */
  prBranch: string;
  gitOps: GitOps;
}

/**
 * Run the full rebase + auto-resolve + sanity-check pipeline.
 * Returns a typed outcome the caller can switch on.
 *
 * Implementation strategy:
 *
 *   - Pre-stats: diffStats(base..prBranch) — what the PR brought
 *     before rebase. Used by sanity check post-rebase.
 *
 *   - First rebase attempt. Three branches:
 *       clean      → sanity-check, return.
 *       conflict   → classify + resolve loop (up to N rounds).
 *       fatal      → return early.
 *
 *   - Resolve loop: classify all conflicted files. If all fully-
 *     trivial, splice resolutions into place, stageAll, continue
 *     rebase. Re-loop. If any substantive, abort + return.
 *
 *   - Sanity check (only on clean / auto-resolved): post-stats
 *     filesChanged > max(pre × multiplier, floor) → sanity-failed.
 */
export async function attemptRebase(opts: AttemptRebaseOpts): Promise<Result<RebaseAttemptResult>> {
  const { worktreePath, baseBranch, prBranch, gitOps } = opts;

  // 1. Pre-stats — what the PR contained before rebase.
  // Note: we use prBranch's HEAD vs base. After rebase, prBranch
  // moves; we compare pre-rebase HEAD to be safe.
  const preStatsResult = await gitOps.diffStats(worktreePath, baseBranch, 'HEAD');
  if (!preStatsResult.ok) {
    return ok({ outcome: 'fatal', failureRecord: preStatsResult.failure });
  }
  const preStats = preStatsResult.value;

  // 2-4. Rebase + resolution loop.
  const rebaseResult = await runRebaseWithResolution(opts, MAX_AUTO_RESOLUTION_ROUNDS);
  if (!rebaseResult.ok) {
    // Programmer-error level; bubble.
    return err(rebaseResult.failure);
  }
  const { state: rebaseState, autoResolvedFiles, autoResolutionRounds, conflictedFiles, conflictSummaries } = rebaseResult.value;

  if (rebaseState === 'fatal') {
    return ok({
      outcome: 'fatal',
      failureRecord: rebaseResult.value.failureRecord,
      preStats,
    });
  }

  if (rebaseState === 'needs-author') {
    return ok({
      outcome: 'needs-author',
      preStats,
      conflictedFiles,
      conflictSummaries,
    });
  }

  // 5. Sanity check (rebaseState === 'clean' or 'auto-resolved').
  const postStatsResult = await gitOps.diffStats(worktreePath, baseBranch, 'HEAD');
  if (!postStatsResult.ok) {
    return ok({ outcome: 'fatal', failureRecord: postStatsResult.failure, preStats });
  }
  const postStats = postStatsResult.value;

  const sanityCeiling = Math.max(preStats.filesChanged * SANITY_FILE_MULTIPLIER, SANITY_FLOOR_FILE_COUNT);
  if (postStats.filesChanged > sanityCeiling) {
    // Abort the (already-completed) rebase — too late, but the
    // outcome is still rejectable. Caller files a sanity-failed
    // blocker. We do NOT push.
    return ok({
      outcome: 'sanity-failed',
      preStats,
      postStats,
      failureRecord: failure(
        'rebase-sanity-check-failed',
        `Post-rebase diff touches ${postStats.filesChanged} files vs ${preStats.filesChanged} pre-rebase — exceeds ${sanityCeiling}-file ceiling. Likely cause: stale base, accidental cherry-pick, or generated-file explosion. Aborting before merge.`,
        `pre: ${preStats.filesChanged}f/+${preStats.insertions}/-${preStats.deletions}; post: ${postStats.filesChanged}f/+${postStats.insertions}/-${postStats.deletions}; ceiling: ${sanityCeiling}`,
      ),
    });
  }

  if (rebaseState === 'auto-resolved') {
    return ok({
      outcome: 'auto-resolved',
      preStats,
      postStats,
      autoResolvedFiles,
      autoResolutionRounds,
    });
  }

  // Clean.
  return ok({ outcome: 'clean', preStats, postStats });
}

// ─── Rebase + resolution inner loop ──────────────────────────────────

interface InnerRebaseResult {
  state: 'clean' | 'auto-resolved' | 'needs-author' | 'fatal';
  autoResolvedFiles?: string[];
  autoResolutionRounds?: number;
  conflictedFiles?: string[];
  conflictSummaries?: ConflictSummary[];
  failureRecord?: FailureRecord;
}

async function runRebaseWithResolution(
  opts: AttemptRebaseOpts,
  maxRounds: number,
): Promise<Result<InnerRebaseResult>> {
  const { worktreePath, baseBranch, gitOps } = opts;

  // First attempt.
  const firstAttempt = await gitOps.rebase(worktreePath, baseBranch);
  if (!firstAttempt.ok) {
    return err(firstAttempt.failure);
  }

  let outcome = firstAttempt.value;
  if (outcome.state === 'clean') {
    return ok({ state: 'clean' });
  }
  if (outcome.state === 'fatal' || outcome.state === 'aborted') {
    return ok({ state: 'fatal' });
  }

  // outcome.state === 'conflict'. Enter resolution loop.
  const allAutoResolved: string[] = [];
  let rounds = 0;
  while (rounds < maxRounds) {
    rounds++;
    const conflictedFiles = outcome.conflictedFiles ?? [];
    if (conflictedFiles.length === 0) {
      // Conflict state but no files? Treat as fatal — git is in a
      // weird mode. Abort to clean up.
      await gitOps.rebaseAbort(worktreePath).catch(() => undefined);
      return ok({ state: 'fatal' });
    }

    // Classify each conflicted file.
    const classifications: { file: string; classified: ClassifiedFile }[] = [];
    for (const file of conflictedFiles) {
      let contents: string;
      try {
        contents = readFileSync(join(worktreePath, file), 'utf-8');
      } catch (cause) {
        // Can't read the file — fatal.
        await gitOps.rebaseAbort(worktreePath).catch(() => undefined);
        return ok({
          state: 'fatal',
          failureRecord: failure(
            'unknown',
            `rebase: cannot read conflicted file ${file}`,
            cause instanceof Error ? cause.message : String(cause),
          ),
        });
      }
      classifications.push({ file, classified: classifyFile(contents, file) });
    }

    // If any file isn't fully trivial → needs author.
    const nonTrivial = classifications.filter((c) => !c.classified.fullyTrivial);
    if (nonTrivial.length > 0) {
      // Abort the rebase to leave the worktree in a clean state.
      await gitOps.rebaseAbort(worktreePath).catch(() => undefined);
      const summaries: ConflictSummary[] = nonTrivial.map((c) => ({
        filePath: c.file,
        substantiveBlockCount: c.classified.blocks.filter((b) => b.triviality === 'substantive').length,
        worstTriviality: c.classified.worstTriviality,
      }));
      return ok({
        state: 'needs-author',
        conflictedFiles: nonTrivial.map((c) => c.file),
        conflictSummaries: summaries,
      });
    }

    // All trivial — splice resolutions, stage, continue.
    const resolvedThisRound: string[] = [];
    for (const c of classifications) {
      try {
        const original = readFileSync(join(worktreePath, c.file), 'utf-8');
        const resolved = applyResolutions(original, c.classified);
        writeFileSync(join(worktreePath, c.file), resolved, 'utf-8');
        resolvedThisRound.push(c.file);
      } catch (cause) {
        // Write failed — fatal, abort.
        await gitOps.rebaseAbort(worktreePath).catch(() => undefined);
        return ok({
          state: 'fatal',
          failureRecord: failure(
            'unknown',
            `rebase: cannot write resolution for ${c.file}`,
            cause instanceof Error ? cause.message : String(cause),
          ),
        });
      }
    }
    allAutoResolved.push(...resolvedThisRound);

    const stageResult = await gitOps.stageAll(worktreePath);
    if (!stageResult.ok) {
      await gitOps.rebaseAbort(worktreePath).catch(() => undefined);
      return ok({ state: 'fatal', failureRecord: stageResult.failure });
    }

    const continueResult = await gitOps.rebaseContinue(worktreePath);
    if (!continueResult.ok) {
      return err(continueResult.failure);
    }
    outcome = continueResult.value;
    if (outcome.state === 'clean') {
      return ok({
        state: 'auto-resolved',
        autoResolvedFiles: allAutoResolved,
        autoResolutionRounds: rounds,
      });
    }
    if (outcome.state === 'fatal' || outcome.state === 'aborted') {
      return ok({ state: 'fatal' });
    }
    // Still in conflict — loop and try again.
  }

  // Exhausted rounds. Abort and treat as needs-author (cascading
  // conflicts are a sign of substantive overlap even if each round
  // looked trivial in isolation).
  await gitOps.rebaseAbort(worktreePath).catch(() => undefined);
  return ok({
    state: 'needs-author',
    conflictedFiles: outcome.conflictedFiles ?? [],
    conflictSummaries: (outcome.conflictedFiles ?? []).map((file) => ({
      filePath: file,
      substantiveBlockCount: 0,
      worstTriviality: 'whitespace-only' as const,
    })),
  });
}
