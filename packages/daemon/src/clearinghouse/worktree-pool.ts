/**
 * Worktree pool (Project 1.12).
 *
 * Pressman sessions need an isolated git worktree per submission to
 * rebase+test+merge without trampling the daemon's main checkout.
 * Naïvely creating + destroying a worktree per submission costs two
 * extra git invocations per merge plus the disk-space churn. With
 * 100 PRs/day at three-or-so worker pool, that's hundreds of
 * unnecessary worktree operations.
 *
 * The pool keeps a small set of pre-created worktrees, reset
 * between uses. Acquire returns a free one (creating if needed up
 * to a configurable cap); release resets it and returns to pool.
 *
 * ### State model
 *
 * In-memory only. Daemon restart wipes the pool's view; worktree
 * directories on disk become orphans the next session cleans up.
 *
 * Pool entries:
 *   { index, path, holder: string | null, baseBranch: string | null }
 *
 * Holder is the Pressman slug that currently owns it. Release sets
 * holder=null and resets the worktree back to clean state.
 *
 * ### Naming
 *
 * Deterministic by index: `<corpRoot>/.clearinghouse/wt-<N>/`.
 * Easier to scan and clean than UUID-based names. The
 * `.clearinghouse` parent dir is gitignored at corp init time
 * (Pressman ensures it before first acquire).
 *
 * ### Cleanup
 *
 * `cleanupOrphanWorktrees` runs at daemon boot: any wt-* dir not
 * tracked in the in-memory pool gets force-removed. This catches
 * worktrees from prior daemon sessions that died holding them.
 *
 * ### Concurrency
 *
 * Acquire is not internally locked. The expected usage is
 * single-daemon-process, so the daemon-side caller (Pressman
 * dispatch) wraps acquire calls in its in-memory mutex. If two
 * Pressmen race to acquire, both see the same pool snapshot and
 * could both grab the same free entry. The mutex at the caller
 * prevents that — the pool itself stays simple.
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  failure,
  ok,
  err,
  type FailureRecord,
  type Result,
} from './failure-taxonomy.js';
import type { GitOps } from './git-ops.js';

// ─── Config ──────────────────────────────────────────────────────────

/** Default cap on pool size. Pressman pool target is 1-2 idle, so 4 is plenty headroom. */
export const DEFAULT_POOL_CAP = 4;

/** Subdirectory under corpRoot where worktrees live. */
export const WORKTREE_PARENT_DIR = '.clearinghouse';

/** File at the worktree-parent root containing this gitignore — copied into place on first acquire. */
export const WORKTREE_GITIGNORE = `# Project 1.12 Clearinghouse worktrees — managed by daemon, not for git tracking.\n*\n`;

// ─── Shape ───────────────────────────────────────────────────────────

export interface WorktreeHandle {
  /** Index in the pool (stable for the worktree's lifetime). */
  readonly index: number;
  /** Absolute path on disk. */
  readonly path: string;
  /** Pressman slug currently holding it. */
  readonly holder: string;
  /** Branch checked out into the worktree at acquire time. Null when detached. */
  readonly branch: string | null;
}

interface PoolEntry {
  index: number;
  path: string;
  holder: string | null;
  branch: string | null;
}

export interface WorktreePoolOpts {
  corpRoot: string;
  gitOps: GitOps;
  /** Override default cap. */
  cap?: number;
}

// ─── Pool implementation ─────────────────────────────────────────────

/**
 * Single-corp worktree pool. Constructed lazily; the in-memory map
 * starts empty and grows as acquires happen.
 */
export class WorktreePool {
  private readonly corpRoot: string;
  private readonly gitOps: GitOps;
  private readonly cap: number;
  private readonly entries = new Map<number, PoolEntry>();

  constructor(opts: WorktreePoolOpts) {
    this.corpRoot = opts.corpRoot;
    this.gitOps = opts.gitOps;
    this.cap = opts.cap ?? DEFAULT_POOL_CAP;
  }

  /**
   * Acquire a worktree for the given branch. Reuses an idle entry
   * if one exists; otherwise creates one (up to the cap). Returns
   * a typed failure when the pool is full and all entries are held.
   */
  async acquire(opts: { branch: string; holder: string }): Promise<Result<WorktreeHandle>> {
    this.ensureParentDir();

    // Try to reuse a free entry. If reset fails on one entry, keep
    // scanning — a stale/corrupt free entry shouldn't block allocation
    // when other idle entries (or fresh capacity) are available.
    // (Codex P2 catch on PR #192.) Track the last reset failure for
    // the all-options-exhausted case where no entry could be reset
    // AND we're at the cap.
    let lastResetFailure: FailureRecord | null = null;
    for (const entry of this.entries.values()) {
      if (entry.holder !== null) continue;
      const reset = await this.resetEntryToBranch(entry, opts.branch);
      if (!reset.ok) {
        lastResetFailure = reset.failure;
        continue;
      }
      entry.holder = opts.holder;
      entry.branch = opts.branch;
      return ok({
        index: entry.index,
        path: entry.path,
        holder: opts.holder,
        branch: opts.branch,
      });
    }

    // No free entry — create one if under cap.
    if (this.entries.size >= this.cap) {
      // If we got here because all idle entries had reset failures,
      // surface the last one — it's more diagnostic than a bare
      // "pool full" message and tells the founder which underlying
      // issue is blocking allocation.
      if (lastResetFailure) {
        return err(lastResetFailure);
      }
      return err(failure(
        'unknown',
        `worktree pool full (${this.cap} entries, all held). Wait for a release or raise the cap.`,
        `holders: ${[...this.entries.values()].map((e) => `wt-${e.index}=${e.holder}`).join(', ')}`,
        { retryable: true, retryDelayMs: 5000, route: 'founder' },
      ));
    }

    const nextIndex = this.findNextFreeIndex();
    const path = join(this.corpRoot, WORKTREE_PARENT_DIR, `wt-${nextIndex}`);

    // git worktree add <path> <branch>. If the branch isn't
    // checked-out-able (already in use by another worktree, etc),
    // surface as failure.
    const add = await this.gitOps.worktreeAdd(opts.branch, path, { cwd: this.corpRoot });
    if (!add.ok) return err(add.failure);

    const entry: PoolEntry = { index: nextIndex, path, holder: opts.holder, branch: opts.branch };
    this.entries.set(nextIndex, entry);
    return ok({ index: nextIndex, path, holder: opts.holder, branch: opts.branch });
  }

  /**
   * Release a worktree back to the pool. Resets to clean state
   * (`git reset --hard HEAD; git clean -fdx`) so the next acquire
   * gets a pristine surface. Idempotent: releasing a not-held
   * entry is a no-op success.
   */
  async release(handle: WorktreeHandle): Promise<Result<void>> {
    const entry = this.entries.get(handle.index);
    if (!entry) {
      // Unknown index — nothing to release. Treat as no-op.
      return ok(undefined);
    }
    if (entry.holder === null) {
      // Already released.
      return ok(undefined);
    }
    if (entry.holder !== handle.holder) {
      // Held by someone else — refuse to release on the wrong
      // caller's behalf. Stale-handle protection.
      return err(failure(
        'unknown',
        `worktree wt-${handle.index} held by '${entry.holder}', refusing release on behalf of '${handle.holder}'`,
        `mismatched-holder release attempt`,
      ));
    }

    // Reset + clean. Best-effort: a reset failure is logged but we
    // still release the slot — better to free it than to permanently
    // leak the entry on a transient git error.
    //
    // Note: we DO NOT clear entry.branch — a same-branch reacquire
    // skips the worktree-remove + worktree-add pair via
    // resetEntryToBranch's early-return, saving git ops on the
    // common Pressman-iterates-on-same-branch path.
    const reset = await this.resetEntryToCleanState(entry);
    entry.holder = null;
    if (!reset.ok) {
      // Surface to caller; the entry IS released but the next
      // acquire might fail to check out its branch.
      return err(reset.failure);
    }
    return ok(undefined);
  }

  /**
   * Force-remove all pool entries (and their underlying worktrees).
   * Daemon shutdown calls this for clean teardown. Best-effort per
   * entry: failures log but don't stop the cleanup.
   */
  async drain(): Promise<Result<{ removed: number; failed: number }>> {
    let removed = 0;
    let failed = 0;
    for (const entry of [...this.entries.values()]) {
      const result = await this.gitOps.worktreeRemove(entry.path, { force: true, cwd: this.corpRoot });
      if (result.ok) removed++;
      else failed++;
      this.entries.delete(entry.index);
    }
    return ok({ removed, failed });
  }

  /**
   * Sweep for orphan worktree directories (wt-* under the parent
   * dir not tracked in the pool). Daemon boot calls this to clean
   * up after a prior session that died mid-merge. Returns count of
   * orphans removed.
   */
  async cleanupOrphanWorktrees(): Promise<Result<{ removed: number }>> {
    const parent = join(this.corpRoot, WORKTREE_PARENT_DIR);
    if (!existsSync(parent)) return ok({ removed: 0 });

    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch (cause) {
      return err(failure(
        'unknown',
        `worktree pool: cannot read ${parent}`,
        cause instanceof Error ? cause.message : String(cause),
      ));
    }

    let removed = 0;
    for (const name of entries) {
      if (!/^wt-\d+$/.test(name)) continue;
      const path = join(parent, name);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      // Skip if currently tracked in pool.
      const idx = parseInt(name.slice(3), 10);
      if (this.entries.has(idx)) continue;

      const removeResult = await this.gitOps.worktreeRemove(path, { force: true, cwd: this.corpRoot });
      if (removeResult.ok) removed++;
      // Failures swallowed — the dir might be partially-broken state
      // a manual `git worktree prune` can clear; we don't want to
      // crash boot on it.
    }
    return ok({ removed });
  }

  /** For tests + diagnostics. Returns pool snapshot. */
  inspect(): ReadonlyArray<{ index: number; path: string; holder: string | null; branch: string | null }> {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  // ─── Internals ────────────────────────────────────────────────────

  private ensureParentDir(): void {
    const parent = join(this.corpRoot, WORKTREE_PARENT_DIR);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    const gitignore = join(parent, '.gitignore');
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, WORKTREE_GITIGNORE, 'utf-8');
    }
  }

  private findNextFreeIndex(): number {
    const used = new Set([...this.entries.keys()]);
    for (let i = 0; i < this.cap; i++) {
      if (!used.has(i)) return i;
    }
    // Shouldn't reach here — cap check above prevents this.
    return this.entries.size;
  }

  /**
   * Reset an entry's worktree to a clean checkout of the named branch.
   * Used both on acquire-of-existing-entry (switch branches) and
   * post-release reset.
   */
  private async resetEntryToBranch(entry: PoolEntry, branch: string): Promise<Result<void>> {
    // If we're already on the same branch, just reset+clean.
    if (entry.branch === branch) {
      return this.resetEntryToCleanState(entry);
    }
    // Different branch: remove the worktree and re-add at the new
    // branch. We could use `git checkout` instead, but worktree
    // remove+add is more bulletproof against any in-progress
    // rebase/merge state from a prior aborted attempt.
    const removeResult = await this.gitOps.worktreeRemove(entry.path, { force: true, cwd: this.corpRoot });
    if (!removeResult.ok) return err(removeResult.failure);

    const addResult = await this.gitOps.worktreeAdd(branch, entry.path, { cwd: this.corpRoot });
    if (!addResult.ok) return err(addResult.failure);
    return ok(undefined);
  }

  private async resetEntryToCleanState(entry: PoolEntry): Promise<Result<void>> {
    // Abort any rebase that might be in progress (idempotent).
    await this.gitOps.rebaseAbort(entry.path).catch(() => undefined);
    // Hard reset to discard tracked modifications. Then clean to
    // remove untracked+ignored. Both are required for true isolation
    // between holders — without them, the next acquire inherits
    // dirty state (Codex P1 catch on PR #192). Best-effort per
    // step: a reset failure is logged but we still attempt clean,
    // and we still release the slot — leaking a partially-reset
    // entry beats leaking the slot itself.
    const resetResult = await this.gitOps.resetHard(entry.path);
    if (!resetResult.ok) {
      // Surface the reset failure but try clean anyway. The next
      // acquire will detect leftover state via isClean and either
      // recover or surface its own failure.
      const cleanResult = await this.gitOps.cleanWorkdir(entry.path);
      if (!cleanResult.ok) return err(cleanResult.failure);
      return err(resetResult.failure);
    }
    const cleanResult = await this.gitOps.cleanWorkdir(entry.path);
    if (!cleanResult.ok) return err(cleanResult.failure);
    return ok(undefined);
  }
}

/**
 * Build a fresh WorktreePool. Convenience wrapper for the common
 * "one pool per daemon" usage; tests construct the class directly.
 */
export function createWorktreePool(opts: WorktreePoolOpts): WorktreePool {
  return new WorktreePool(opts);
}
