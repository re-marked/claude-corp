/**
 * Editor diff helpers (Project 1.12).
 *
 * Editor agents read raw `git diff` output via their own session
 * tools — what this module provides is the metadata layer:
 *
 *   - File list with status + line counts (computeReviewableDiff).
 *   - Filter logic identifying which files SHOULDN'T be reviewed
 *     (lockfiles, generated artifacts, binaries).
 *   - Size-guard rejection so a 50KB-file PR doesn't blow Editor's
 *     context window.
 *   - Comment-position validation so Editor's review-comment chits
 *     attach to lines that actually exist in the diff.
 *
 * ### Why filter
 *
 * A typical PR includes:
 *   - Source code (review THIS).
 *   - Lockfile updates (don't review — they're machine-generated).
 *   - Generated bundles in dist/ (don't review).
 *   - Test snapshots (review only if the underlying test changed).
 *
 * Without filtering, Editor wastes tokens (and worse: writes
 * spurious comments on lockfile lines). Filter list is conservative
 * — false positives just mean a file goes unreviewed; the cascading
 * audit gate still catches issues at runtime.
 *
 * ### Size guard
 *
 * Editor's context budget is finite. A PR touching 200 files at
 * 5000+ added lines blows past what an Editor can usefully read.
 * Such PRs should split before review, not get rubber-stamped or
 * partially-reviewed. The guard refuses the review with a clean
 * "split this PR" message routed to author.
 *
 * Default limits:
 *   - maxFiles: 100
 *   - maxLines: 5000 (additions + deletions)
 *
 * Caller can override per-corp via Editor role config.
 */

import { failure, ok, err, type FailureRecord, type Result } from './failure-taxonomy.js';
import type { GitOps } from './git-ops.js';

// ─── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_MAX_FILES = 100;
export const DEFAULT_MAX_LINES = 5000;

// ─── Filter rules ────────────────────────────────────────────────────

interface FilterRule {
  test: (path: string) => boolean;
  reason: string;
}

/**
 * Patterns to filter from review. Order matters — most specific
 * first (binary > generated > lockfile > snapshot). Filtering is
 * conservative: when in doubt, allow through (false negative is
 * "Editor wastes some tokens"; false positive is "Editor never
 * sees the change at all" — strictly worse).
 */
const FILTER_RULES: FilterRule[] = [
  // Binary file extensions — Editor can't usefully review.
  {
    test: (p) => /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp3|mp4|wav|pdf|zip|tar\.gz|tgz|so|dll|dylib|exe)$/i.test(p),
    reason: 'binary file (extension)',
  },
  // Compiled / minified artifacts.
  {
    test: (p) => /\.(min\.js|min\.css|js\.map|css\.map)$/i.test(p),
    reason: 'minified or sourcemap (build artifact)',
  },
  // Lockfiles.
  {
    test: (p) => /(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|Pipfile\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/i.test(p),
    reason: 'lockfile (machine-generated)',
  },
  // Generated dirs — match anywhere in the path.
  {
    test: (p) => /(^|\/)(dist|build|target|out|node_modules|\.next|\.nuxt|\.svelte-kit|coverage|\.turbo|\.cache)\//i.test(p),
    reason: 'generated artifact directory',
  },
  // Test snapshots — review-worthy only when the underlying test
  // changed. Editor can't tell from snapshot alone; safer to
  // filter and rely on the test diff carrying the intent.
  {
    test: (p) => /__snapshots__\/.*\.snap$/i.test(p),
    reason: 'test snapshot (review the test, not the snapshot)',
  },
];

/**
 * Pure: should this file path be filtered from Editor review?
 * Returns the reason on filter, or { filtered: false } when not.
 */
export function shouldFilterFile(filePath: string): { filtered: boolean; reason?: string } {
  for (const rule of FILTER_RULES) {
    if (rule.test(filePath)) {
      return { filtered: true, reason: rule.reason };
    }
  }
  return { filtered: false };
}

// ─── Diff metadata ───────────────────────────────────────────────────

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unknown';

export interface ReviewableFile {
  readonly path: string;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
  /** When status='renamed' or 'copied', the previous path. */
  readonly oldPath?: string;
}

export interface FilteredFile {
  readonly path: string;
  readonly reason: string;
}

export interface ReviewableDiff {
  readonly files: readonly ReviewableFile[];
  readonly filteredFiles: readonly FilteredFile[];
  readonly totalAdditions: number;
  readonly totalDeletions: number;
  readonly oversized: boolean;
  readonly oversizedReason?: string;
}

// ─── computeReviewableDiff ───────────────────────────────────────────

export interface ComputeReviewableDiffOpts {
  /** Worktree to operate in. */
  worktreePath: string;
  /** The base ref for the diff. Typically the branch-from-main commit recorded on the contract. */
  baseRef: string;
  /** The PR's HEAD ref. Typically 'HEAD' or the branch name. */
  headRef: string;
  gitOps: GitOps;
  /** Override file count cap. */
  maxFiles?: number;
  /** Override total-line cap. */
  maxLines?: number;
}

/**
 * Compute the metadata for an Editor review. Doesn't return raw
 * diff content — Editor reads that via its own tooling. We provide:
 *
 *   - The file list (with status + line counts)
 *   - Which files were filtered + why
 *   - Whether the diff is oversized (Editor must reject the review)
 *
 * Strategy:
 *
 *   1. Run `git diff --numstat <base> <head>` for the file list.
 *      numstat gives `<additions>\t<deletions>\t<path>` per line.
 *   2. Run `git diff --name-status <base> <head>` for status codes.
 *   3. Merge: file by file, attach status to numstat row.
 *   4. Apply filters: split into reviewable + filtered.
 *   5. Size-check: if reviewable.length > maxFiles OR sum of
 *      reviewable additions+deletions > maxLines, set oversized.
 */
export async function computeReviewableDiff(opts: ComputeReviewableDiffOpts): Promise<Result<ReviewableDiff>> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

  // Use git directly via the gitOps interface. We don't have a
  // dedicated `numstat` method; we invoke git via diffStats which
  // gives shortstat, then a parallel name-status query. To stay
  // within the GitOps surface without expanding it, we'll use
  // diffStats for totals and accept that per-file additions/
  // deletions need a follow-up call. v1 implementation: use
  // git directly here, scoped to this module.
  //
  // (This is the one place a primitives module shells out outside
  // GitOps — cleaner than expanding the interface for a single
  // editor-side use case. If a second consumer needs numstat
  // later, hoist into GitOps then.)
  const numstatResult = await runGitNumstat(opts);
  if (!numstatResult.ok) return err(numstatResult.failure);

  const statusResult = await runGitNameStatus(opts);
  if (!statusResult.ok) return err(statusResult.failure);

  const statusByPath = new Map(statusResult.value.map((e) => [e.path, e]));

  const reviewable: ReviewableFile[] = [];
  const filteredFiles: FilteredFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const ns of numstatResult.value) {
    const filterResult = shouldFilterFile(ns.path);
    if (filterResult.filtered) {
      filteredFiles.push({ path: ns.path, reason: filterResult.reason ?? 'unknown' });
      continue;
    }
    const status = statusByPath.get(ns.path);
    reviewable.push({
      path: ns.path,
      status: status?.status ?? 'unknown',
      additions: ns.additions,
      deletions: ns.deletions,
      ...(status?.oldPath ? { oldPath: status.oldPath } : {}),
    });
    totalAdditions += ns.additions;
    totalDeletions += ns.deletions;
  }

  let oversized = false;
  let oversizedReason: string | undefined;
  if (reviewable.length > maxFiles) {
    oversized = true;
    oversizedReason = `${reviewable.length} reviewable files exceeds limit ${maxFiles}. Split this PR before requesting review.`;
  } else if (totalAdditions + totalDeletions > maxLines) {
    oversized = true;
    oversizedReason = `${totalAdditions + totalDeletions} added+deleted lines exceeds limit ${maxLines}. Split this PR before requesting review.`;
  }

  return ok({
    files: reviewable,
    filteredFiles,
    totalAdditions,
    totalDeletions,
    oversized,
    ...(oversizedReason ? { oversizedReason } : {}),
  });
}

// ─── Comment-position validation ─────────────────────────────────────

export interface ValidateCommentPositionOpts {
  /** Path the comment targets (relative to repo root). */
  filePath: string;
  /** 1-indexed line in the new (HEAD) file. */
  lineStart: number;
  /** 1-indexed inclusive end line (often = lineStart). */
  lineEnd: number;
  /** Reviewable diff metadata for the PR. The file must be in `files` (not filtered). */
  diff: ReviewableDiff;
}

export type CommentValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Pure: validate that an Editor's review-comment targets a
 * file actually in the reviewable diff. Doesn't check line-by-line
 * presence — that requires raw diff parsing. v1 catches the
 * common errors (file filtered / not in diff / range inverted).
 *
 * Editor's session can do per-line validation via `git blame -L`
 * if needed; this is the cheap pre-validation that catches typos.
 */
export function validateCommentPosition(opts: ValidateCommentPositionOpts): CommentValidationResult {
  if (opts.lineEnd < opts.lineStart) {
    return { valid: false, reason: `lineEnd (${opts.lineEnd}) < lineStart (${opts.lineStart})` };
  }
  const filtered = opts.diff.filteredFiles.find((f) => f.path === opts.filePath);
  if (filtered) {
    return { valid: false, reason: `file '${opts.filePath}' is filtered from review (${filtered.reason})` };
  }
  const file = opts.diff.files.find((f) => f.path === opts.filePath);
  if (!file) {
    return { valid: false, reason: `file '${opts.filePath}' is not in the reviewable diff (not changed by this PR)` };
  }
  return { valid: true };
}

// ─── Internal: git numstat / name-status runners ─────────────────────

interface NumstatRow {
  additions: number;
  deletions: number;
  path: string;
}

interface NameStatusEntry {
  status: FileStatus;
  path: string;
  oldPath?: string;
}

async function runGitNumstat(opts: ComputeReviewableDiffOpts): Promise<Result<NumstatRow[]>> {
  // Use a passthrough via GitOps' `diffStats` won't give us per-file
  // data. Implement a small inline runner. Mirrors realGitOps's
  // discipline: bounded timeout, structured capture.
  const { execa } = await import('execa');
  let result: Awaited<ReturnType<typeof execa>>;
  try {
    result = await execa('git', ['diff', '--numstat', `${opts.baseRef}..${opts.headRef}`], {
      cwd: opts.worktreePath,
      timeout: 60_000,
      reject: false,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (cause) {
    return err(failure(
      'unknown',
      `git diff --numstat: spawn failed`,
      cause instanceof Error ? cause.stack ?? cause.message : String(cause),
    ));
  }
  if (result.exitCode !== 0) {
    return err(failure(
      'unknown',
      `git diff --numstat: non-zero exit ${result.exitCode}`,
      `${result.stdout}\n${result.stderr}`,
    ));
  }
  return ok(parseNumstatOutput(stringify(result.stdout)));
}

async function runGitNameStatus(opts: ComputeReviewableDiffOpts): Promise<Result<NameStatusEntry[]>> {
  const { execa } = await import('execa');
  let result: Awaited<ReturnType<typeof execa>>;
  try {
    result = await execa('git', ['diff', '--name-status', `${opts.baseRef}..${opts.headRef}`], {
      cwd: opts.worktreePath,
      timeout: 60_000,
      reject: false,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (cause) {
    return err(failure(
      'unknown',
      `git diff --name-status: spawn failed`,
      cause instanceof Error ? cause.stack ?? cause.message : String(cause),
    ));
  }
  if (result.exitCode !== 0) {
    return err(failure(
      'unknown',
      `git diff --name-status: non-zero exit ${result.exitCode}`,
      `${result.stdout}\n${result.stderr}`,
    ));
  }
  return ok(parseNameStatusOutput(stringify(result.stdout)));
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

/**
 * Parse `git diff --numstat` output. Each line:
 *   `<additions>\t<deletions>\t<path>`
 * Binary files appear as `-\t-\t<path>` — we treat as 0/0 and let
 * the filter rules drop them.
 */
export function parseNumstatOutput(stdout: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const adds = parts[0] === '-' ? 0 : parseInt(parts[0]!, 10);
    const dels = parts[1] === '-' ? 0 : parseInt(parts[1]!, 10);
    const path = parts.slice(2).join('\t');
    if (path.length === 0) continue;
    rows.push({
      additions: Number.isFinite(adds) ? adds : 0,
      deletions: Number.isFinite(dels) ? dels : 0,
      path,
    });
  }
  return rows;
}

/**
 * Parse `git diff --name-status` output. Each line:
 *   `<status>\t<path>` or for renames `R<score>\t<oldPath>\t<newPath>`.
 */
export function parseNameStatusOutput(stdout: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const code = parts[0]!;
    const status = mapStatusCode(code);
    if (code.startsWith('R') || code.startsWith('C')) {
      // Renamed/copied: parts[1] = old, parts[2] = new.
      if (parts.length >= 3) {
        entries.push({ status, path: parts[2]!, oldPath: parts[1]! });
      }
    } else {
      entries.push({ status, path: parts[1]! });
    }
  }
  return entries;
}

function mapStatusCode(code: string): FileStatus {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'unknown';
  }
}
