import { watch, type FSWatcher, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type TaskStatus, readTask } from '@agentcorp/shared';
import { writeTaskEvent } from './task-events.js';
import type { Daemon } from './daemon.js';

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

    console.log(`[task-watcher] Watching tasks/ (${this.taskCache.size} tasks cached)`);
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
