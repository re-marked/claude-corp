/**
 * Low-level git operations for the Clearinghouse (Project 1.12).
 *
 * Each exported function wraps exactly one git invocation, with:
 *   - Bounded timeouts (no operation can hang forever)
 *   - Structured stdout/stderr capture
 *   - Result<T> return shape (no thrown exceptions for expected
 *     failure modes; only programmer errors throw)
 *   - Failure-category classification via failure-taxonomy.ts
 *
 * The orchestrators in rebase.ts / merge.ts / worktree-pool.ts
 * compose these into multi-step workflows. Pressman's session-side
 * code calls the orchestrators (via cc-cli surfaces in PR 3), not
 * these primitives directly.
 *
 * ### Why an interface
 *
 * Tests need to exercise the orchestrators without spinning up real
 * git. The `GitOps` interface decouples shape from implementation:
 * `realGitOps` shells out via execa; tests pass a mock returning
 * scripted Results. Same shape both sides — orchestrators can't
 * tell the difference.
 *
 * ### Subprocess discipline
 *
 * - Every spawn carries a `timeout` (default 60s, configurable per
 *   call). Hung git processes get SIGKILL.
 * - stderr is captured, not pumped to the daemon's stderr (we
 *   surface it in the FailureRecord instead).
 * - Exit codes drive the failure taxonomy. Non-zero with structured
 *   stderr (e.g. "fatal: not a git repository") classifies cleanly;
 *   non-zero with garbage stderr falls through to 'unknown'.
 *
 * ### Cross-platform
 *
 * Path separators normalized via Node's `path` module (no manual
 * slashes). Worktree paths stored as absolute. Mark develops on
 * Windows; the test suite must pass there too.
 */

import { execa, ExecaError, type Options as ExecaOptions } from 'execa';
import { join, isAbsolute } from 'node:path';
import {
  failure,
  ok,
  err,
  hasErrnoCode,
  categorizeErrno,
  type FailureRecord,
  type Result,
} from './failure-taxonomy.js';

// ─── Config defaults ─────────────────────────────────────────────────

/** Default timeout for any single git invocation (60s). Override per-call when needed. */
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** Slower operations (fetch, push, large rebase) get a longer fence. */
export const SLOW_GIT_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Shape definitions ───────────────────────────────────────────────

export interface DiffStats {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface RebaseOutcome {
  /** Final state of the rebase attempt. */
  readonly state:
    | 'clean' // rebase landed cleanly, working tree clean
    | 'conflict' // rebase stopped at a conflict
    | 'aborted' // we aborted mid-rebase due to error
    | 'fatal'; // git failed in a way we can't recover from
  /** Conflict files (paths relative to worktree root) when state='conflict'. */
  readonly conflictedFiles?: readonly string[];
  /** Diff stats after the rebase attempt — used for the sanity check (200-files-on-2-line-PR). */
  readonly diffStats?: DiffStats;
}

export interface MergeOutcome {
  readonly state: 'merged' | 'conflict' | 'rejected' | 'fatal';
  readonly mergeCommitSha?: string;
  readonly conflictedFiles?: readonly string[];
}

export interface PushOutcome {
  readonly state: 'pushed' | 'rejected-race' | 'rejected-hook' | 'fatal';
  /** stderr from origin's hooks when state='rejected-hook'. */
  readonly hookOutput?: string;
}

// ─── GitOps interface ────────────────────────────────────────────────

export interface GitOps {
  /** Fetch a specific branch (or all branches) from origin. */
  fetchOrigin(opts?: { branch?: string; cwd?: string; timeoutMs?: number }): Promise<Result<void>>;

  /** Add a new worktree. Caller manages cleanup via worktreeRemove. */
  worktreeAdd(branch: string, path: string, opts?: { detach?: boolean; cwd?: string }): Promise<Result<void>>;

  /** Remove a worktree (--force when it's modified). */
  worktreeRemove(path: string, opts?: { force?: boolean; cwd?: string }): Promise<Result<void>>;

  /** List current worktrees (for orphan cleanup). */
  worktreeList(opts?: { cwd?: string }): Promise<Result<readonly WorktreeEntry[]>>;

  /** Run a rebase in the given worktree against the named base. */
  rebase(worktreePath: string, baseBranch: string, opts?: { timeoutMs?: number }): Promise<Result<RebaseOutcome>>;

  /** Abort an in-progress rebase. Idempotent: safe when no rebase in progress. */
  rebaseAbort(worktreePath: string): Promise<Result<void>>;

  /** Continue a paused rebase after conflicts were resolved + staged. */
  rebaseContinue(worktreePath: string): Promise<Result<RebaseOutcome>>;

  /** Stage all changes in the worktree (git add -A). */
  stageAll(worktreePath: string): Promise<Result<void>>;

  /** Push a branch to origin. Detects race / hook rejection separately. */
  push(branch: string, opts: { worktreePath: string; force?: boolean; timeoutMs?: number }): Promise<Result<PushOutcome>>;

  /** Get the current HEAD sha of the worktree (or a named ref). */
  currentSha(worktreePath: string, ref?: string): Promise<Result<string>>;

  /** Get diff stats between two refs. */
  diffStats(worktreePath: string, base: string, head: string): Promise<Result<DiffStats>>;

  /** List files currently in conflict (after a paused rebase/merge). */
  listConflictedFiles(worktreePath: string): Promise<Result<readonly string[]>>;

  /** Check whether a branch exists locally or on origin. */
  branchExists(name: string, opts: { remote: boolean; cwd?: string }): Promise<Result<boolean>>;

  /** Check whether the working tree has uncommitted changes. */
  isClean(worktreePath: string): Promise<Result<boolean>>;

  /**
   * Hard-reset the worktree to a ref (default HEAD). Discards
   * tracked modifications. Used by the worktree pool's release
   * path to clear leftover state before the next acquire.
   */
  resetHard(worktreePath: string, ref?: string): Promise<Result<void>>;

  /**
   * Remove untracked + ignored files via `git clean -fdx`. The pool
   * pairs this with resetHard to fully reset a released worktree
   * — without it, leftover artifacts (test outputs, generated
   * files, dot-dirs created during a prior session) leak across
   * holders and break worktree isolation guarantees (Codex P1
   * catch on PR #192).
   */
  cleanWorkdir(worktreePath: string): Promise<Result<void>>;
}

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string;
  readonly branch: string | null; // null when detached
  readonly bare: boolean;
}

// ─── Real implementation ─────────────────────────────────────────────

/**
 * Real GitOps backed by spawning the local `git` binary via execa.
 * Tests substitute a mock matching this interface.
 */
export const realGitOps: GitOps = {
  async fetchOrigin(opts) {
    const args = ['fetch', 'origin'];
    if (opts?.branch) args.push(opts.branch);
    const result = await runGit(args, {
      cwd: opts?.cwd,
      timeoutMs: opts?.timeoutMs ?? SLOW_GIT_TIMEOUT_MS,
      operationLabel: `fetch origin${opts?.branch ? ` ${opts.branch}` : ''}`,
    });
    if (!result.ok) return err(result.failure);
    return ok(undefined);
  },

  async worktreeAdd(branch, path, opts) {
    const args = ['worktree', 'add'];
    if (opts?.detach) args.push('--detach');
    args.push(path, branch);
    const result = await runGit(args, {
      cwd: opts?.cwd,
      operationLabel: `worktree add ${path} ${branch}`,
    });
    if (!result.ok) return err(result.failure);
    return ok(undefined);
  },

  async worktreeRemove(path, opts) {
    const args = ['worktree', 'remove'];
    if (opts?.force) args.push('--force');
    args.push(path);
    const result = await runGit(args, {
      cwd: opts?.cwd,
      operationLabel: `worktree remove ${path}`,
    });
    if (!result.ok) return err(result.failure);
    return ok(undefined);
  },

  async worktreeList(opts) {
    const result = await runGit(['worktree', 'list', '--porcelain'], {
      cwd: opts?.cwd,
      operationLabel: 'worktree list',
    });
    if (!result.ok) return err(result.failure);
    return ok(parseWorktreeListPorcelain(result.value.stdout));
  },

  async rebase(worktreePath, baseBranch, opts) {
    const result = await runGit(['rebase', baseBranch], {
      cwd: worktreePath,
      timeoutMs: opts?.timeoutMs ?? SLOW_GIT_TIMEOUT_MS,
      operationLabel: `rebase ${baseBranch}`,
      // Don't fail-on-nonzero — rebase exits non-zero on conflict,
      // and we want to classify rather than throw.
      reject: false,
    });
    return classifyRebaseResult(worktreePath, result);
  },

  async rebaseAbort(worktreePath) {
    // Idempotent: if no rebase in progress, git returns non-zero
    // with a benign message. Treat that as success.
    const result = await runGit(['rebase', '--abort'], {
      cwd: worktreePath,
      operationLabel: 'rebase --abort',
      reject: false,
    });
    if (!result.ok) {
      // Hard error (e.g. ENOENT for git binary).
      return err(result.failure);
    }
    // Non-zero exit with "no rebase in progress" message → benign.
    return ok(undefined);
  },

  async rebaseContinue(worktreePath) {
    const result = await runGit(['rebase', '--continue'], {
      cwd: worktreePath,
      timeoutMs: SLOW_GIT_TIMEOUT_MS,
      operationLabel: 'rebase --continue',
      reject: false,
      // git rebase --continue expects an editor for commit messages
      // when run interactively; setting GIT_EDITOR=true makes it
      // accept the existing messages without prompting.
      env: { GIT_EDITOR: 'true' },
    });
    return classifyRebaseResult(worktreePath, result);
  },

  async stageAll(worktreePath) {
    const result = await runGit(['add', '-A'], {
      cwd: worktreePath,
      operationLabel: 'add -A',
    });
    if (!result.ok) return err(result.failure);
    return ok(undefined);
  },

  async push(branch, opts) {
    const args = ['push'];
    if (opts.force) args.push('--force-with-lease');
    args.push('origin', branch);
    const result = await runGit(args, {
      cwd: opts.worktreePath,
      timeoutMs: opts.timeoutMs ?? SLOW_GIT_TIMEOUT_MS,
      operationLabel: `push origin ${branch}`,
      reject: false,
    });
    return classifyPushResult(result);
  },

  async currentSha(worktreePath, ref = 'HEAD') {
    const result = await runGit(['rev-parse', ref], {
      cwd: worktreePath,
      operationLabel: `rev-parse ${ref}`,
    });
    if (!result.ok) return err(result.failure);
    const sha = result.value.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return err(failure(
        'unknown',
        `git rev-parse returned a value that doesn't look like a sha`,
        `expected 40-char hex; got: ${JSON.stringify(sha.slice(0, 80))}`,
      ));
    }
    return ok(sha);
  },

  async diffStats(worktreePath, base, head) {
    const result = await runGit(['diff', '--shortstat', `${base}..${head}`], {
      cwd: worktreePath,
      operationLabel: `diff --shortstat ${base}..${head}`,
    });
    if (!result.ok) return err(result.failure);
    return ok(parseShortstat(result.value.stdout));
  },

  async listConflictedFiles(worktreePath) {
    const result = await runGit(['diff', '--name-only', '--diff-filter=U'], {
      cwd: worktreePath,
      operationLabel: 'diff --name-only --diff-filter=U',
    });
    if (!result.ok) return err(result.failure);
    const files = result.value.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return ok(files);
  },

  async branchExists(name, opts) {
    const args = opts.remote
      ? ['ls-remote', '--exit-code', '--heads', 'origin', name]
      : ['rev-parse', '--verify', `refs/heads/${name}`];
    const result = await runGit(args, {
      cwd: opts.cwd,
      operationLabel: `branchExists${opts.remote ? ' (remote)' : ''} ${name}`,
      reject: false,
    });
    if (!result.ok) return err(result.failure);
    return ok(result.value.exitCode === 0);
  },

  async isClean(worktreePath) {
    const result = await runGit(['status', '--porcelain'], {
      cwd: worktreePath,
      operationLabel: 'status --porcelain',
    });
    if (!result.ok) return err(result.failure);
    return ok(result.value.stdout.trim().length === 0);
  },

  async resetHard(worktreePath, ref = 'HEAD') {
    const result = await runGit(['reset', '--hard', ref], {
      cwd: worktreePath,
      operationLabel: `reset --hard ${ref}`,
    });
    if (!result.ok) return err(result.failure);
    return ok(undefined);
  },

  async cleanWorkdir(worktreePath) {
    // -f force, -d directories, -x untracked + ignored. Aggressive
    // by design — the pool only calls this between holders, when
    // we genuinely want a pristine surface.
    const result = await runGit(['clean', '-fdx'], {
      cwd: worktreePath,
      operationLabel: 'clean -fdx',
    });
    if (!result.ok) return err(result.failure);
    return ok(undefined);
  },
};

// ─── Internal: git invocation runner ─────────────────────────────────

interface GitRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface RunGitOpts {
  cwd?: string;
  timeoutMs?: number;
  /** Default true. Set false to allow non-zero exits without throwing — we'll classify in the caller. */
  reject?: boolean;
  /** Extra env vars (merged with process.env). */
  env?: Record<string, string>;
  /** Used in failure summaries for human readability. */
  operationLabel: string;
}

/**
 * Spawn `git <args>` with bounded timeout, structured capture, and
 * failure classification. Reject=false means we don't throw on
 * non-zero — caller classifies via result.exitCode + stderr.
 */
async function runGit(args: readonly string[], opts: RunGitOpts): Promise<Result<GitRunResult>> {
  const execaOpts: ExecaOptions = {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    reject: false, // we always handle non-zero ourselves
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: 'utf8',
    stdio: 'pipe',
  };

  let result: Awaited<ReturnType<typeof execa>>;
  try {
    result = await execa('git', [...args], execaOpts);
  } catch (cause) {
    // Spawn-level failure (binary missing, disk full, etc).
    if (hasErrnoCode(cause, 'ENOENT')) {
      return err(failure(
        'tool-missing',
        `git binary not found on PATH. Install git and retry.`,
        cause instanceof Error ? cause.stack ?? cause.message : String(cause),
      ));
    }
    const errnoCategory = categorizeErrno((cause as { code?: string }).code);
    if (errnoCategory) {
      return err(failure(
        errnoCategory,
        `git ${opts.operationLabel}: ${errnoCategory.replace(/-/g, ' ')}`,
        cause instanceof Error ? cause.stack ?? cause.message : String(cause),
      ));
    }
    return err(failure(
      'unknown',
      `git ${opts.operationLabel}: spawn failed`,
      cause instanceof Error ? cause.stack ?? cause.message : String(cause),
    ));
  }

  // Timeout — execa flags via .timedOut. Surface as timeout category.
  if (result.timedOut) {
    return err(failure(
      'network-timeout',
      `git ${opts.operationLabel}: exceeded ${opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms timeout`,
      `git ${args.join(' ')} (cwd=${opts.cwd ?? 'process.cwd'}); stdout=${truncate(stringify(result.stdout))}; stderr=${truncate(stringify(result.stderr))}`,
    ));
  }

  // If caller wants reject-on-nonzero (the common case), check now.
  if ((opts.reject ?? true) && result.exitCode !== 0) {
    return err(classifyNonZeroExit(args, opts, result));
  }

  return ok({
    stdout: stringify(result.stdout),
    stderr: stringify(result.stderr),
    exitCode: result.exitCode ?? -1,
  });
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

function truncate(s: string, max = 1000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

/**
 * Classify a non-zero git exit when the caller wanted us to throw.
 * Returns a FailureRecord; callers wrap with their own context.
 */
function classifyNonZeroExit(
  args: readonly string[],
  opts: RunGitOpts,
  result: Awaited<ReturnType<typeof execa>>,
): FailureRecord {
  const stderr = stringify(result.stderr);
  const stdout = stringify(result.stdout);

  // Common stderr patterns we recognize.
  if (/not a git repository/i.test(stderr)) {
    return failure(
      'unknown',
      `git ${opts.operationLabel}: not a git repository at ${opts.cwd ?? 'cwd'}`,
      stderr,
    );
  }
  if (/Couldn't find remote ref|fatal: '.+' is not a commit|fatal: invalid reference/i.test(stderr)) {
    return failure(
      'branch-deleted',
      `git ${opts.operationLabel}: branch or ref not found on origin`,
      stderr,
    );
  }
  if (/Could not resolve host|Connection refused|Operation timed out/i.test(stderr)) {
    return failure(
      'network-timeout',
      `git ${opts.operationLabel}: network failure`,
      stderr,
    );
  }
  if (/No space left on device/i.test(stderr)) {
    return failure(
      'disk-full',
      `git ${opts.operationLabel}: disk full`,
      stderr,
    );
  }
  return failure(
    'unknown',
    `git ${opts.operationLabel}: exited ${result.exitCode}`,
    `args: ${args.join(' ')}\nstdout: ${truncate(stdout)}\nstderr: ${truncate(stderr)}`,
  );
}

// ─── Rebase result classifier ────────────────────────────────────────

async function classifyRebaseResult(
  worktreePath: string,
  result: Result<GitRunResult>,
): Promise<Result<RebaseOutcome>> {
  if (!result.ok) return err(result.failure);
  const { stdout, stderr, exitCode } = result.value;

  if (exitCode === 0) {
    // Clean rebase. Diff stats vs origin/main let the caller do
    // the sanity check; we don't fetch them here unless asked.
    return ok({ state: 'clean' });
  }

  // Non-zero exit. Common pattern: "CONFLICT (content): Merge
  // conflict in <file>" in stdout, "Resolve all conflicts manually"
  // in stderr/stdout.
  const combined = `${stdout}\n${stderr}`;

  if (/CONFLICT/i.test(combined) || /could not apply/i.test(combined)) {
    // Conflict — list files via a follow-up call.
    const conflictedResult = await realGitOps.listConflictedFiles(worktreePath);
    const files = conflictedResult.ok ? conflictedResult.value : [];
    return ok({ state: 'conflict', conflictedFiles: files });
  }

  if (/disk full|No space left on device/i.test(combined)) {
    return err(failure('disk-full', 'rebase: disk full', combined));
  }

  if (/network|Could not resolve host/i.test(combined)) {
    return err(failure('network-timeout', 'rebase: network failure', combined));
  }

  // Unknown failure mode — abort to leave the worktree in a clean
  // state, then report as fatal. Caller can retry.
  await realGitOps.rebaseAbort(worktreePath).catch(() => undefined);
  return ok({ state: 'fatal' });
}

// ─── Push result classifier ──────────────────────────────────────────

function classifyPushResult(result: Result<GitRunResult>): Result<PushOutcome> {
  if (!result.ok) return err(result.failure);
  const { stdout, stderr, exitCode } = result.value;
  if (exitCode === 0) {
    return ok({ state: 'pushed' });
  }
  const combined = `${stdout}\n${stderr}`;
  // Race condition — origin moved.
  if (/non-fast-forward|fetch first|stale info/i.test(combined)) {
    return ok({ state: 'rejected-race' });
  }
  // Hook rejection — origin's pre-receive or push hook ran and refused.
  if (/remote rejected|pre-receive hook|update hook|! \[remote rejected\]/i.test(combined)) {
    return ok({ state: 'rejected-hook', hookOutput: combined });
  }
  // Network / disk / unknown — surface as fatal with classification.
  if (/Could not resolve host|Connection refused|Operation timed out/i.test(combined)) {
    return err(failure('network-timeout', 'push: network failure', combined));
  }
  if (/No space left on device/i.test(combined)) {
    return err(failure('disk-full', 'push: disk full', combined));
  }
  return ok({ state: 'fatal' });
}

// ─── Output parsers (pure) ───────────────────────────────────────────

/**
 * Parse `git diff --shortstat` output of the form:
 *   " 3 files changed, 42 insertions(+), 7 deletions(-)"
 * Tolerates missing insertions or deletions sections (one-sided
 * change), returns zeros for fields not present.
 */
export function parseShortstat(stdout: string): DiffStats {
  const text = stdout.trim();
  if (text.length === 0) return { filesChanged: 0, insertions: 0, deletions: 0 };
  const filesMatch = /(\d+)\s+files?\s+changed/.exec(text);
  const insertMatch = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const deleteMatch = /(\d+)\s+deletions?\(-\)/.exec(text);
  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1]!, 10) : 0,
    insertions: insertMatch ? parseInt(insertMatch[1]!, 10) : 0,
    deletions: deleteMatch ? parseInt(deleteMatch[1]!, 10) : 0,
  };
}

/**
 * Parse `git worktree list --porcelain` output. Each worktree is a
 * blank-line-separated stanza of `key value` lines. Bare flag is
 * present-as-bool.
 */
export function parseWorktreeListPorcelain(stdout: string): WorktreeEntry[] {
  const stanzas = stdout.split(/\r?\n\r?\n/).filter((s) => s.trim().length > 0);
  const entries: WorktreeEntry[] = [];
  for (const stanza of stanzas) {
    const map: Record<string, string> = {};
    let bare = false;
    for (const line of stanza.split(/\r?\n/)) {
      if (line === 'bare') {
        bare = true;
        continue;
      }
      const space = line.indexOf(' ');
      if (space > 0) {
        map[line.slice(0, space)] = line.slice(space + 1);
      }
    }
    if (!map.worktree) continue;
    entries.push({
      path: map.worktree,
      head: map.HEAD ?? '',
      branch: map.branch ?? null,
      bare,
    });
  }
  return entries;
}

// ─── Path helpers ────────────────────────────────────────────────────

/** Normalize a worktree path for cross-platform consistency. */
export function normalizeWorktreePath(corpRoot: string, relativeOrAbsolute: string): string {
  return isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : join(corpRoot, relativeOrAbsolute);
}
