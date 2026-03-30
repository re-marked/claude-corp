import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskPriority } from '@claudecorp/shared';
import { log, logError } from './logger.js';

interface ChannelInbox {
  channelName: string;
  total: number;
  mentions: number;
  mentionedBy: string[]; // display names of who mentioned this agent
}

interface AgentInbox {
  channels: Map<string, ChannelInbox>;
  ccSayCount: number;
}

/** A task queued for an agent to work on when they become idle. */
export interface QueuedTask {
  taskId: string;
  taskTitle: string;
  taskPriority: TaskPriority;
  assigneeId: string;
  timestamp: string;
  blockedBy: string[] | null;
}

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * InboxManager — tracks unread messages + priority task queue per agent.
 * Agents check their inbox on heartbeat (idle) or busy→idle transition.
 * Task queue feeds ONE task at a time, highest priority first.
 */
const INBOX_STATE_FILE = 'inbox-state.json';
const PERSIST_DEBOUNCE_MS = 2_000; // Batch writes every 2 seconds

export class InboxManager {
  private inboxes = new Map<string, AgentInbox>();
  private taskQueues = new Map<string, QueuedTask[]>();
  private corpRoot: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  /** Set corp root to enable persistence. Call after daemon knows the corp path. */
  setCorpRoot(corpRoot: string): void {
    this.corpRoot = corpRoot;
    this.restore();
  }

  /** Restore inbox state from disk (called on daemon startup). */
  private restore(): void {
    if (!this.corpRoot) return;
    const filePath = join(this.corpRoot, INBOX_STATE_FILE);
    if (!existsSync(filePath)) return;

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));

      // Restore inboxes
      if (raw.inboxes) {
        for (const [agentId, inbox] of Object.entries(raw.inboxes as Record<string, any>)) {
          const channels = new Map<string, ChannelInbox>();
          if (inbox.channels) {
            for (const [chId, ch] of Object.entries(inbox.channels as Record<string, any>)) {
              channels.set(chId, ch as ChannelInbox);
            }
          }
          this.inboxes.set(agentId, { channels, ccSayCount: inbox.ccSayCount ?? 0 });
        }
      }

      // Restore task queues
      if (raw.taskQueues) {
        for (const [agentId, queue] of Object.entries(raw.taskQueues as Record<string, any>)) {
          this.taskQueues.set(agentId, queue as QueuedTask[]);
        }
      }

      const inboxCount = this.inboxes.size;
      const queueCount = [...this.taskQueues.values()].reduce((sum, q) => sum + q.length, 0);
      if (inboxCount > 0 || queueCount > 0) {
        log(`[inbox] Restored: ${inboxCount} agent inboxes, ${queueCount} queued tasks`);
      }
    } catch (err) {
      logError(`[inbox] Failed to restore inbox state: ${err}`);
    }
  }

  /** Persist inbox state to disk (debounced). */
  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return; // Already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.dirty) return;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Write inbox state to disk immediately. */
  private persistNow(): void {
    if (!this.corpRoot) return;
    this.dirty = false;

    try {
      // Serialize Maps to plain objects
      const inboxes: Record<string, any> = {};
      for (const [agentId, inbox] of this.inboxes) {
        const channels: Record<string, ChannelInbox> = {};
        for (const [chId, ch] of inbox.channels) {
          channels[chId] = ch;
        }
        inboxes[agentId] = { channels, ccSayCount: inbox.ccSayCount };
      }

      const taskQueues: Record<string, QueuedTask[]> = {};
      for (const [agentId, queue] of this.taskQueues) {
        if (queue.length > 0) taskQueues[agentId] = queue;
      }

      writeFileSync(
        join(this.corpRoot, INBOX_STATE_FILE),
        JSON.stringify({ inboxes, taskQueues, savedAt: new Date().toISOString() }, null, 2),
        'utf-8',
      );
    } catch (err) {
      logError(`[inbox] Failed to persist inbox state: ${err}`);
    }
  }

  /** Flush pending writes (call on daemon shutdown). */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) this.persistNow();
  }

  // --- Message Inbox ---

  /** Record a new message in a channel for an agent */
  recordMessage(channelId: string, channelName: string, agentId: string, isMention: boolean, mentionedByName?: string): void {
    let inbox = this.inboxes.get(agentId);
    if (!inbox) {
      inbox = { channels: new Map(), ccSayCount: 0 };
      this.inboxes.set(agentId, inbox);
    }

    let ch = inbox.channels.get(channelId);
    if (!ch) {
      ch = { channelName, total: 0, mentions: 0, mentionedBy: [] };
      inbox.channels.set(channelId, ch);
    }

    ch.total++;
    if (isMention) {
      ch.mentions++;
      if (mentionedByName && !ch.mentionedBy.includes(mentionedByName)) {
        ch.mentionedBy.push(mentionedByName);
      }
    }
    this.schedulePersist();
  }

  /** Record a cc say exchange */
  recordCcSay(agentId: string): void {
    let inbox = this.inboxes.get(agentId);
    if (!inbox) {
      inbox = { channels: new Map(), ccSayCount: 0 };
      this.inboxes.set(agentId, inbox);
    }
    inbox.ccSayCount++;
    this.schedulePersist();
  }

  /** Build a human-readable inbox summary for an agent */
  getSummary(agentId: string): string {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) return '';

    const lines: string[] = [];

    // Sort: channels with mentions first
    const channels = [...inbox.channels.entries()].sort((a, b) => b[1].mentions - a[1].mentions);

    for (const [, ch] of channels) {
      let line = `- #${ch.channelName}: ${ch.total} new message${ch.total === 1 ? '' : 's'}`;
      if (ch.mentions > 0) {
        const from = ch.mentionedBy.length > 0 ? ` from @${ch.mentionedBy.join(', @')}` : '';
        line += ` (${ch.mentions} mention${ch.mentions === 1 ? '' : 's'}${from})`;
      }
      lines.push(line);
    }

    if (inbox.ccSayCount > 0) {
      lines.push(`- inbox.jsonl: ${inbox.ccSayCount} direct message${inbox.ccSayCount === 1 ? '' : 's'}`);
    }

    if (lines.length === 0) return '';

    return `Inbox update:\n${lines.join('\n')}\n\nRead what matters, respond where needed. Reply HEARTBEAT_OK if nothing requires action.`;
  }

  /** Read-only inbox snapshot for Casket file generation (does NOT clear). */
  getInboxSnapshot(agentId: string): string {
    return this.getSummary(agentId);
  }

  /** Clear message inbox for an agent (after they've checked it) */
  clear(agentId: string): void {
    this.inboxes.delete(agentId);
    this.schedulePersist();
  }

  /** Check if agent has any unread message items */
  hasUnread(agentId: string): boolean {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) return false;
    if (inbox.ccSayCount > 0) return true;
    for (const [, ch] of inbox.channels) {
      if (ch.total > 0) return true;
    }
    return false;
  }

  /** Get total unread message count for an agent */
  getUnreadCount(agentId: string): number {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) return 0;
    let total = inbox.ccSayCount;
    for (const [, ch] of inbox.channels) {
      total += ch.total;
    }
    return total;
  }

  // --- Task Queue (new) ---

  /** Enqueue a task for an agent, sorted by priority. */
  enqueueTask(agentId: string, task: QueuedTask): void {
    let queue = this.taskQueues.get(agentId);
    if (!queue) {
      queue = [];
      this.taskQueues.set(agentId, queue);
    }

    // Don't duplicate
    if (queue.some(t => t.taskId === task.taskId)) return;

    // Insert in priority order (lower number = higher priority)
    const taskOrder = PRIORITY_ORDER[task.taskPriority] ?? 2;
    let insertIdx = queue.length;
    for (let i = 0; i < queue.length; i++) {
      const existingOrder = PRIORITY_ORDER[queue[i]!.taskPriority] ?? 2;
      if (taskOrder < existingOrder) {
        insertIdx = i;
        break;
      }
    }
    queue.splice(insertIdx, 0, task);
    this.schedulePersist();
    log(`[inbox] Queued task "${task.taskTitle}" (${task.taskPriority}) for agent ${agentId} — ${queue.length} in queue`);
  }

  /**
   * Dequeue the next task for an agent (highest priority, non-blocked).
   * Pass completedTaskIds to skip blocked tasks.
   */
  dequeueNext(agentId: string, completedTaskIds?: Set<string>): QueuedTask | null {
    const queue = this.taskQueues.get(agentId);
    if (!queue || queue.length === 0) return null;

    for (let i = 0; i < queue.length; i++) {
      const task = queue[i]!;

      // Check if blocked
      if (task.blockedBy && task.blockedBy.length > 0 && completedTaskIds) {
        const allResolved = task.blockedBy.every(id => completedTaskIds.has(id));
        if (!allResolved) continue; // Still blocked, skip
      }

      // Found a non-blocked task — remove and return
      queue.splice(i, 1);
      if (queue.length === 0) this.taskQueues.delete(agentId);
      this.schedulePersist();
      log(`[inbox] Dequeued task "${task.taskTitle}" for agent ${agentId} — ${queue.length} remaining`);
      return task;
    }

    return null; // All tasks are blocked
  }

  /** Peek at next task without removing it. */
  peekNext(agentId: string): QueuedTask | null {
    const queue = this.taskQueues.get(agentId);
    return queue?.[0] ?? null;
  }

  /** Check if agent has queued tasks. */
  hasQueuedTasks(agentId: string): boolean {
    const queue = this.taskQueues.get(agentId);
    return !!queue && queue.length > 0;
  }

  /** Get count of queued tasks. */
  getQueuedTaskCount(agentId: string): number {
    return this.taskQueues.get(agentId)?.length ?? 0;
  }
}
