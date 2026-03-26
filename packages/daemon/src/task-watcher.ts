import { watch, type FSWatcher, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type TaskStatus,
  type Member,
  type Channel,
  type ChannelMessage,
  readTask,
  listTasks,
  readConfig,
  appendMessage,
  generateId,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { writeTaskEvent, notifyTaskAssignment, notifyTaskBlocker } from './task-events.js';
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
        // New task file
        this.taskCache.set(filePath, { status: task.status, assignedTo: task.assignedTo });
        if (this.recentApiCreates.has(filePath)) {
          // API already posted the event + @mention — skip
          this.recentApiCreates.delete(filePath);
          return;
        }
        // Agent-created task (written directly to tasks/) — post event AND @mention
        writeTaskEvent(this.daemon.corpRoot, `"${task.title}" created (priority: ${task.priority})`);
        if (task.assignedTo) {
          notifyTaskAssignment(this.daemon.corpRoot, task.assignedTo, task.title);
        }
        this.daemon.heartbeat.refreshAll();
        return;
      }

      // Check for status change
      if (task.status !== cached.status) {
        writeTaskEvent(
          this.daemon.corpRoot,
          `"${task.title}" → ${task.status}`,
        );

        // When task is BLOCKED, notify the creator (supervisor) so they can help
        if (task.status === 'blocked' && task.createdBy) {
          try {
            const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
            const assignee = members.find(m => m.id === task.assignedTo);
            const assigneeName = assignee?.displayName ?? 'an agent';
            notifyTaskBlocker(this.daemon.corpRoot, task.createdBy, assigneeName, task.title);
          } catch {
            // Non-fatal
          }
        }

        // When task completes or fails, notify the CEO in #tasks
        if (task.status === 'completed' || task.status === 'failed') {
          try {
            const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
            const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
            if (ceo) {
              const channels = readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
              const taskChannel = channels.find(c =>
                c.name.includes('tasks') || c.name.includes('job-board') || c.name.includes('operations'),
              );
              if (taskChannel) {
                const assignee = members.find(m => m.id === task.assignedTo);
                const assigneeName = assignee?.displayName ?? 'an agent';
                const notifyMsg: ChannelMessage = {
                  id: generateId(),
                  channelId: taskChannel.id,
                  senderId: 'system',
                  threadId: null,
                  content: `@${ceo.displayName} Task "${task.title}" has been marked as ${task.status} by ${assigneeName}. Go to your DM with the Founder and report what was done.`,
                  kind: 'text',
                  mentions: [ceo.id],
                  metadata: null,
                  depth: 0,
                  originId: '',
                  timestamp: new Date().toISOString(),
                };
                notifyMsg.originId = notifyMsg.id;
                appendMessage(join(this.daemon.corpRoot, taskChannel.path, MESSAGES_JSONL), notifyMsg);
              }
            }
          } catch {
            // Non-fatal — notification is best-effort
          }

          // Dependency enforcement: when a task completes, check for sibling tasks
          // (same parentTaskId) that are 'assigned' and waiting. Notify their assignees
          // so they know their dependency is resolved and they can start.
          if (task.status === 'completed' && task.parentTaskId) {
            try {
              const allTasks = listTasks(this.daemon.corpRoot);
              const waitingSiblings = allTasks.filter(t =>
                t.task.parentTaskId === task.parentTaskId &&
                t.task.id !== task.id &&
                t.task.status === 'assigned' &&
                t.task.assignedTo,
              );
              for (const sibling of waitingSiblings) {
                notifyTaskAssignment(
                  this.daemon.corpRoot,
                  sibling.task.assignedTo!,
                  sibling.task.title,
                );
                log(`[task-watcher] Dependency resolved: notifying ${sibling.task.assignedTo} that "${sibling.task.title}" can start (sibling "${task.title}" completed)`);
              }
            } catch {
              // Non-fatal
            }
          }

          // blockedBy resolution: when a task completes, find tasks that have
          // this task's ID in their blockedBy array. If ALL their blockers are
          // now completed, notify the assignee that they're unblocked.
          if (task.status === 'completed') {
            try {
              const allTasks = listTasks(this.daemon.corpRoot);
              const blocked = allTasks.filter(t =>
                t.task.blockedBy?.includes(task.id) &&
                t.task.status !== 'completed' &&
                t.task.status !== 'cancelled' &&
                t.task.assignedTo,
              );
              for (const downstream of blocked) {
                // Check if ALL blockers are now completed
                const allBlockersResolved = (downstream.task.blockedBy ?? []).every(blockerId => {
                  const blocker = allTasks.find(t => t.task.id === blockerId);
                  return blocker?.task.status === 'completed';
                });
                if (allBlockersResolved) {
                  notifyTaskAssignment(
                    this.daemon.corpRoot,
                    downstream.task.assignedTo!,
                    downstream.task.title,
                  );
                  writeTaskEvent(
                    this.daemon.corpRoot,
                    `"${downstream.task.title}" unblocked — all dependencies resolved (${task.title} completed)`,
                  );
                  log(`[task-watcher] blockedBy resolved: "${downstream.task.title}" unblocked by "${task.title}" completing`);
                }
              }
            } catch {
              // Non-fatal
            }
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
