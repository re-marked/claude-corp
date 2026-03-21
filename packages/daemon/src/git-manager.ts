import { corpGit, type CorpGit } from '@claudecorp/shared';
import { log, logError } from './logger.js';

const DEBOUNCE_MS = 10_000; // Wait 10s of quiet before committing
const JANITOR_INTERVAL_MS = 60_000; // Safety net: check every 60s

export class GitManager {
  private git: CorpGit;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private janitorInterval: ReturnType<typeof setInterval> | null = null;
  private pendingAuthor: string | null = null;
  private committing = false;

  constructor(corpRoot: string) {
    this.git = corpGit(corpRoot);
  }

  /** Signal that an agent just acted. Debounces, then commits. */
  markDirty(agentName: string): void {
    this.pendingAuthor = agentName;

    // Reset debounce timer
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.tryCommit();
    }, DEBOUNCE_MS);
  }

  /** Start the periodic janitor (safety net for missed commits). */
  start(): void {
    this.janitorInterval = setInterval(() => {
      this.tryCommit();
    }, JANITOR_INTERVAL_MS);
  }

  /** Stop the janitor and flush any pending commit. */
  async stop(): Promise<void> {
    if (this.janitorInterval) clearInterval(this.janitorInterval);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    await this.tryCommit();
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

    // Group by type
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
