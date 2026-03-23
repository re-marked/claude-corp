import { corpGit, type CorpGit } from '@claudecorp/shared';
import { log, logError } from './logger.js';

const SNAPSHOT_INTERVAL_MS = 5_000; // Snapshot every 5 seconds

export class GitManager {
  private git: CorpGit;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private pendingAuthor: string | null = null;
  private committing = false;

  constructor(corpRoot: string) {
    this.git = corpGit(corpRoot);
  }

  /** Signal that an agent just acted. The next snapshot will include their name. */
  markDirty(agentName: string): void {
    this.pendingAuthor = agentName;
  }

  /** Start the 5-second snapshot timer. */
  start(): void {
    this.snapshotInterval = setInterval(() => {
      this.tryCommit();
    }, SNAPSHOT_INTERVAL_MS);
  }

  /** Stop the snapshot timer and flush any pending commit. */
  async stop(): Promise<void> {
    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    await this.tryCommit();
  }

  /** Get the git log (for /time-machine and /rewind). */
  async getLog(count = 20): Promise<{ hash: string; message: string; date: string }[]> {
    try {
      return await this.git.log(count);
    } catch {
      return [];
    }
  }

  /** Show what changed in a specific commit (for /time-machine detail view). */
  async showCommit(hash: string): Promise<string> {
    try {
      return await this.git.raw.raw(['show', '--stat', '--format=%H %s (%ar)', hash]);
    } catch {
      return 'Could not read commit';
    }
  }

  /** Revert a specific commit (for /rewind). */
  async revertCommit(hash: string): Promise<string> {
    try {
      await this.git.raw.raw(['revert', '--no-edit', hash]);
      return `Reverted commit ${hash.substring(0, 7)}`;
    } catch (err) {
      return `Revert failed: ${err}`;
    }
  }

  private async tryCommit(): Promise<void> {
    if (this.committing) return;
    this.committing = true;

    try {
      const status = await this.git.status();
      const changedFiles = [
        ...status.modified,
        ...status.created,
        ...status.deleted,
      ];

      if (changedFiles.length === 0) {
        this.pendingAuthor = null;
        return;
      }

      const author = this.pendingAuthor ?? 'system';
      const summary = this.summarizeChanges(changedFiles);
      const message = `${author}: ${summary}`;

      await this.git.commitAll(message);
      log(`[git] ${message} (${changedFiles.length} files)`);

      this.pendingAuthor = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('nothing to commit')) return;

      // Auto-repair broken HEAD reference
      if (msg.includes('reference broken') || msg.includes('unable to resolve reference')) {
        log('[git] Broken HEAD detected — repairing...');
        try {
          await this.git.raw.raw(['checkout', '--orphan', 'repair-branch']);
          await this.git.raw.raw(['checkout', '-B', 'main']);
          await this.git.commitAll('repair: auto-fix broken HEAD reference');
          log('[git] HEAD repaired successfully');
        } catch (repairErr) {
          logError(`[git] HEAD repair failed: ${repairErr}`);
        }
        return;
      }

      logError(`[git] Commit failed: ${msg}`);
    } finally {
      this.committing = false;
    }
  }

  private summarizeChanges(files: string[]): string {
    if (files.length === 1) {
      return `update ${files[0]}`;
    }

    const messages = files.filter((f) => f.includes('messages.jsonl'));
    const tasks = files.filter((f) => f.includes('tasks/'));
    const agents = files.filter((f) => f.includes('agents/'));
    const other = files.filter(
      (f) => !f.includes('messages.jsonl') && !f.includes('tasks/') && !f.includes('agents/'),
    );

    const parts: string[] = [];
    if (messages.length > 0) parts.push(`${messages.length} channel(s)`);
    if (tasks.length > 0) parts.push(`${tasks.length} task(s)`);
    if (agents.length > 0) parts.push(`${agents.length} agent file(s)`);
    if (other.length > 0) parts.push(`${other.length} other`);

    return parts.length > 0 ? `update ${parts.join(', ')}` : `update ${files.length} files`;
  }
}
