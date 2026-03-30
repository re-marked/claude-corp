import type { TaskPriority } from '@claudecorp/shared';
import { log } from './logger.js';

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
export class InboxManager {
  private inboxes = new Map<string, AgentInbox>();
  private taskQueues = new Map<string, QueuedTask[]>();

  // --- Message Inbox (existing) ---

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
  }

  /** Record a cc say exchange */
  recordCcSay(agentId: string): void {
    let inbox = this.inboxes.get(agentId);
    if (!inbox) {
      inbox = { channels: new Map(), ccSayCount: 0 };
      this.inboxes.set(agentId, inbox);
    }
    inbox.ccSayCount++;
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
