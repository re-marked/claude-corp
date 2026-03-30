import { watch, type FSWatcher, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type TaskStatus,
  type Member,
  readTask,
  updateTask,
  taskPath,
  listTasks,
  readConfig,
  MEMBERS_JSON,
} from '@claudecorp/shared';
import { writeTaskEvent, logTaskAssignment, dispatchTaskToDm, dispatchBlockerToDm, dispatchCompletionToCeo, dispatchToHander } from './task-events.js';
import type { Daemon } from './daemon.js';
import { log } from './logger.js';

export class TaskWatcher {
  private daemon: Daemon;
  private watcher: FSWatcher | null = null;
  private taskCache = new Map<string, { status: TaskStatus; assignedTo: string | null }>();
  private recentApiCreates = new Set<string>(); // Suppress duplicates from API + fs.watch
  private processing = new Set<string>(); // Prevent fs.watch double-fire

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
    if (this.processing.has(filePath)) return;
    this.processing.add(filePath);
    setTimeout(() => this.processing.delete(filePath), 500); // Debounce 500ms

    try {
      const { task } = readTask(filePath);
      const cached = this.taskCache.get(filePath);

      if (!cached) {
        // New task file
        this.taskCache.set(filePath, { status: task.status, assignedTo: task.assignedTo });
        if (this.recentApiCreates.has(filePath)) {
          // API already posted the event + DM dispatch — skip
          this.recentApiCreates.delete(filePath);
          return;
        }
        // Agent-created task (written directly to tasks/) — agent set assignedTo intentionally = implicit hand
        writeTaskEvent(this.daemon.corpRoot, `"${task.title}" created (priority: ${task.priority})`);
        if (task.assignedTo) {
          logTaskAssignment(this.daemon.corpRoot, task.assignedTo, task.title);
          dispatchTaskToDm(this.daemon, task.assignedTo, task.title, task.id);
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

        // When task is BLOCKED, notify the creator AND hander
        if (task.status === 'blocked') {
          try {
            const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
            const assignee = members.find(m => m.id === task.assignedTo);
            const assigneeName = assignee?.displayName ?? 'an agent';

            // Notify creator (supervisor)
            if (task.createdBy) {
              dispatchBlockerToDm(this.daemon, task.createdBy, assigneeName, task.title);
            }

            // Notify hander (sponsor) if different from creator
            const handedBy = (task as any).handedBy;
            if (handedBy && handedBy !== task.createdBy) {
              dispatchToHander(this.daemon, handedBy, task.title, 'blocked', assigneeName);
            }
          } catch {
            // Non-fatal
          }
        }

        // When task completes or fails, notify CEO via DM + handle dependencies
        if (task.status === 'completed' || task.status === 'failed') {
          try {
            const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
            const assignee = members.find(m => m.id === task.assignedTo);
            const assigneeName = assignee?.displayName ?? 'an agent';

            // Notify CEO via DM
            dispatchCompletionToCeo(this.daemon, task.title, task.status, assigneeName);

            // Notify the hander (sponsor) — they delegated this work and care about the outcome
            const handedBy = (task as any).handedBy;
            if (handedBy) {
              // Don't double-notify if hander IS the CEO (already notified above)
              const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
              if (handedBy !== ceo?.id) {
                dispatchToHander(this.daemon, handedBy, task.title, task.status, assigneeName);
              }
            }
          } catch {
            // Non-fatal
          }

          // Dependency enforcement: sibling tasks with same parentTaskId
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
                logTaskAssignment(this.daemon.corpRoot, sibling.task.assignedTo!, sibling.task.title);
                dispatchTaskToDm(this.daemon, sibling.task.assignedTo!, sibling.task.title, sibling.task.id);
                log(`[task-watcher] Dependency resolved: dispatching "${sibling.task.title}" to ${sibling.task.assignedTo} (sibling "${task.title}" completed)`);
              }
            } catch {
              // Non-fatal
            }
          }

          // blockedBy resolution: find tasks blocked by this one
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
                  // Auto-unblock: update status from blocked → assigned, then hand immediately
                  try {
                    const downstreamPath = taskPath(this.daemon.corpRoot, downstream.task.id);
                    updateTask(downstreamPath, { status: 'assigned' });
                  } catch {}

                  logTaskAssignment(this.daemon.corpRoot, downstream.task.assignedTo!, downstream.task.title);
                  dispatchTaskToDm(this.daemon, downstream.task.assignedTo!, downstream.task.title, downstream.task.id);
                  writeTaskEvent(
                    this.daemon.corpRoot,
                    `"${downstream.task.title}" UNBLOCKED — all dependencies resolved ("${task.title}" completed) — auto-handed to assignee`,
                  );
                  log(`[task-watcher] Auto-unblock: "${downstream.task.title}" unblocked + auto-handed (dependency "${task.title}" completed)`);
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
