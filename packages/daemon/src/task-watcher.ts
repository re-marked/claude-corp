import { watch, type FSWatcher, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type TaskStatus,
  type Member,
  type Channel,
  type ChannelMessage,
  readTask,
  readConfig,
  appendMessage,
  generateId,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { writeTaskEvent } from './task-events.js';
import type { Daemon } from './daemon.js';
import { log } from './logger.js';

export class TaskWatcher {
  private daemon: Daemon;
  private watcher: FSWatcher | null = null;
  private taskCache = new Map<string, { status: TaskStatus; assignedTo: string | null }>();
  private recentApiCreates = new Set<string>(); // Suppress duplicates from API + fs.watch

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    const tasksDir = join(this.daemon.corpRoot, 'tasks');
    if (!existsSync(tasksDir)) return;

    // Initialize cache with current task states
    this.loadCache(tasksDir);

    // Watch for changes
    this.watcher = watch(tasksDir, (_event, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      const filePath = join(tasksDir, filename);
      this.onTaskFileChange(filePath);
    });
    this.watcher.on('error', () => {
      // Windows EPERM — try to re-watch after a delay
      this.watcher = null;
      setTimeout(() => this.start(), 2000);
    });

    log(`[task-watcher] Watching tasks/ (${this.taskCache.size} tasks cached)`);
  }

  /** Mark a task file as already announced by the API (prevents duplicate events). */
  suppressNextCreate(filePath: string): void {
    this.recentApiCreates.add(filePath);
    // Clean up after 5 seconds in case fs.watch never fires
    setTimeout(() => this.recentApiCreates.delete(filePath), 5000);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private loadCache(tasksDir: string): void {
    try {
      const files = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        try {
          const filePath = join(tasksDir, file);
          const { task } = readTask(filePath);
          this.taskCache.set(filePath, {
            status: task.status,
            assignedTo: task.assignedTo,
          });
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Tasks dir might not exist yet
    }
  }

  private onTaskFileChange(filePath: string): void {
    if (!existsSync(filePath)) return;

    try {
      const { task } = readTask(filePath);
      const cached = this.taskCache.get(filePath);

      if (!cached) {
        // New task file — but skip if API already posted the event
        this.taskCache.set(filePath, { status: task.status, assignedTo: task.assignedTo });
        if (this.recentApiCreates.has(filePath)) {
          this.recentApiCreates.delete(filePath);
          return;
        }
        writeTaskEvent(this.daemon.corpRoot, `"${task.title}" created (priority: ${task.priority})`);
        return;
      }

      // Check for status change
      if (task.status !== cached.status) {
        writeTaskEvent(
          this.daemon.corpRoot,
          `"${task.title}" → ${task.status}`,
        );

        // When task completes or fails, notify the CEO in their DM with the Founder
        if (task.status === 'completed' || task.status === 'failed') {
          try {
            const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
            const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
            const founder = members.find(m => m.rank === 'owner');
            if (ceo && founder) {
              const channels = readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
              // Find the CEO-Founder DM channel (so CEO responds there, not in #tasks)
              const dmChannel = channels.find(c =>
                c.kind === 'direct' &&
                c.memberIds.includes(ceo.id) &&
                c.memberIds.includes(founder.id),
              );
              if (dmChannel) {
                const assignee = members.find(m => m.id === task.assignedTo);
                const assigneeName = assignee?.displayName ?? 'an agent';
                const notifyMsg: ChannelMessage = {
                  id: generateId(),
                  channelId: dmChannel.id,
                  senderId: 'system',
                  threadId: null,
                  content: `@${ceo.displayName} Task "${task.title}" has been marked as ${task.status} by ${assigneeName}. Tell the Founder what was done.`,
                  kind: 'text',
                  mentions: [ceo.id],
                  metadata: null,
                  depth: 0,
                  originId: '',
                  timestamp: new Date().toISOString(),
                };
                notifyMsg.originId = notifyMsg.id;
                appendMessage(join(this.daemon.corpRoot, dmChannel.path, MESSAGES_JSONL), notifyMsg);
              }
            }
          } catch {
            // Non-fatal — notification is best-effort
          }
        }
      }

      // Check for assignment change
      if (task.assignedTo !== cached.assignedTo && task.assignedTo) {
        writeTaskEvent(
          this.daemon.corpRoot,
          `"${task.title}" assigned to ${task.assignedTo}`,
        );
      }

      // Update cache + refresh TASKS.md files
      this.taskCache.set(filePath, { status: task.status, assignedTo: task.assignedTo });
      this.daemon.heartbeat.refreshAll();
    } catch {
      // File might be partially written, ignore
    }
  }
}
