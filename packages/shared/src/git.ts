import { simpleGit, type SimpleGit, type DefaultLogFields } from 'simple-git';
import { join } from 'node:path';

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface MergeResult {
  success: boolean;
  conflicts: string[];
  summary: string;
}

export interface CorpGit {
  raw: SimpleGit;
  init(): Promise<void>;
  commitAll(message: string): Promise<void>;
  log(n?: number): Promise<{ hash: string; message: string; date: string }[]>;
  diff(): Promise<string>;
  status(): Promise<{ modified: string[]; created: string[]; deleted: string[] }>;
  // Worktree operations
  createWorktree(agentSlug: string): Promise<string>;
  removeWorktree(agentSlug: string): Promise<void>;
  mergeWorktree(agentSlug: string): Promise<MergeResult>;
  resetWorktree(agentSlug: string): Promise<void>;
  listWorktrees(): Promise<WorktreeInfo[]>;
}

export function corpGit(corpPath: string): CorpGit {
  const git = simpleGit(corpPath);

  return {
    raw: git,

    async init() {
      await git.init();
      await git.addConfig('user.name', 'Claude Corp');
      await git.addConfig('user.email', 'claudecorp@local');
    },

    async commitAll(message: string) {
      await git.add('.');
      await git.commit(message);
    },

    async log(n = 20) {
      const result = await git.log({ maxCount: n });
      return result.all.map((entry: DefaultLogFields) => ({
        hash: entry.hash,
        message: entry.message,
        date: entry.date,
      }));
    },

    async diff() {
      return git.diff();
    },

    async status() {
      const result = await git.status();
      return {
        modified: result.modified,
        created: result.created,
        deleted: result.deleted,
      };
    },

    async createWorktree(agentSlug: string): Promise<string> {
      const wtPath = join(corpPath, 'wt', agentSlug).replace(/\\/g, '/');
      const branch = `wt/${agentSlug}`;
      await git.raw(['worktree', 'add', wtPath, '-b', branch]);
      return wtPath;
    },

    async removeWorktree(agentSlug: string): Promise<void> {
      const wtPath = join(corpPath, 'wt', agentSlug).replace(/\\/g, '/');
      try {
        await git.raw(['worktree', 'remove', wtPath, '--force']);
      } catch {
        // May already be removed
      }
      try {
        await git.raw(['branch', '-D', `wt/${agentSlug}`]);
      } catch {
        // Branch may not exist
      }
    },

    async mergeWorktree(agentSlug: string): Promise<MergeResult> {
      const branch = `wt/${agentSlug}`;
      try {
        // Make sure we're on main
        await git.checkout('main');
        const result = await git.merge([branch]);
        return {
          success: true,
          conflicts: [],
          summary: `Merged ${branch}: ${result.insertions} insertions, ${result.deletions} deletions across ${Object.keys(result.files).length} file(s)`,
        };
      } catch (err: any) {
        // Check for merge conflicts
        const status = await git.status();
        if (status.conflicted.length > 0) {
          return {
            success: false,
            conflicts: status.conflicted,
            summary: `Merge conflict in ${status.conflicted.length} file(s): ${status.conflicted.join(', ')}`,
          };
        }
        return {
          success: false,
          conflicts: [],
          summary: `Merge failed: ${err?.message ?? String(err)}`,
        };
      }
    },

    async resetWorktree(agentSlug: string): Promise<void> {
      const wtPath = join(corpPath, 'wt', agentSlug).replace(/\\/g, '/');
      const branch = `wt/${agentSlug}`;
      // Remove old worktree + branch, recreate from updated main
      try { await git.raw(['worktree', 'remove', wtPath, '--force']); } catch {}
      try { await git.raw(['branch', '-D', branch]); } catch {}
      await git.raw(['worktree', 'add', wtPath, '-b', branch]);
    },

    async listWorktrees(): Promise<WorktreeInfo[]> {
      const output = await git.raw(['worktree', 'list', '--porcelain']);
      const worktrees: WorktreeInfo[] = [];
      let current: Partial<WorktreeInfo> = {};

      for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
          current.path = line.slice('worktree '.length).trim();
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice('branch '.length).replace('refs/heads/', '').trim();
        } else if (line.trim() === '' && current.path) {
          worktrees.push({ path: current.path, branch: current.branch ?? 'HEAD' });
          current = {};
        }
      }
      if (current.path) {
        worktrees.push({ path: current.path, branch: current.branch ?? 'HEAD' });
      }

      return worktrees;
    },
  };
}
