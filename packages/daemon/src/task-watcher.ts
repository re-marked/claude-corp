import { watch, type FSWatcher, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type TaskStatus,
  type Member,
  readTask,
  listTasks,
  readConfig,
  MEMBERS_JSON,
  advanceChain,
  applyChainAdvance,
  findChitById,
  type TaskFields,
} from '@claudecorp/shared';
import { writeTaskEvent, logTaskAssignment, dispatchTaskToDm, dispatchBlockerToDm, dispatchCompletionToCeo, dispatchToHander } from './task-events.js';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

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
    // Post-0.3 migration: tasks live as chits at <corpRoot>/chits/task/.
    // Watching the old <corpRoot>/tasks/ location would miss every new
    // task + status transition + blocker event.
    const tasksDir = join(this.daemon.corpRoot, 'chits', 'task');
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
    setTimeout(() => this.processing.delete(filePath), 4000); // Debounce 4s (Windows fs.watch fires 3-5 times per change)

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
        this.daemon.analytics.trackTaskCreated();
        writeTaskEvent(this.daemon.corpRoot, `[TASK] "${task.title}" created (priority: ${task.priority})`);
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
          `[TASK] "${task.title}" → ${task.status}`,
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

        // When task completes or fails, track analytics + notify CEO + handle dependencies
        if (task.status === 'completed' || task.status === 'failed') {
          // Analytics tracking
          if (task.status === 'completed' && task.assignedTo) {
            this.daemon.analytics.trackTaskCompleted(task.assignedTo);
          } else if (task.status === 'failed' && task.assignedTo) {
            this.daemon.analytics.trackTaskFailed(task.assignedTo);
          }

          // Bidirectional lifecycle: task complete → auto-stop linked loop
          if (task.loopId) {
            try {
              this.daemon.loops.complete(task.loopId);
              log(`[task-watcher] Loop ${task.loopId} auto-completed (task "${task.title}" finished)`);
            } catch {
              // Loop may already be stopped or deleted — non-fatal
            }
          }

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

          // Chain walker cascade — Project 1.3 + 1.4. On terminal
          // close (completed / failed / cancelled), advanceChain
          // computes DependentDelta[] for every dependent of this
          // task; applyChainAdvance transitions each dependent's
          // workflowStatus via the state machine AND re-dispatches
          // unblocked tasks (Casket write + inbox). Replaces the
          // pre-1.4 ad-hoc blockedBy resolver that read the legacy
          // Task wrapper status field — chit-layer walker is now the
          // single source of truth.
          //
          // The daemon-layer adds DM dispatch here (to wake the
          // agent's session) that the shared applyChainAdvance can't
          // do — it stays harness-agnostic. Session wake lives at
          // the daemon boundary, chain semantics in shared.
          if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
            try {
              const advance = advanceChain(this.daemon.corpRoot, task.id);
              const results = applyChainAdvance(this.daemon.corpRoot, advance, 'system');
              for (const r of results) {
                if (!r.transition.applied) {
                  // transition-rejected is the idempotent re-fire
                  // case (already unblocked, stacking block). Log
                  // only genuine substrate gaps.
                  if (r.transition.skippedReason && r.transition.skippedReason !== 'transition-rejected') {
                    log(`[chain] skipped ${r.delta.chitId}: ${r.transition.skippedReason} — ${r.transition.detail ?? ''}`);
                  }
                  continue;
                }
                log(`[chain] ${r.delta.trigger} ${r.delta.chitId}: ${r.transition.fromState} → ${r.transition.toState}`);

                // Unblocked + re-dispatched → wake the agent's session.
                if (
                  r.delta.trigger === 'unblock' &&
                  r.redispatch?.targetSlug &&
                  r.redispatch.casketWritten
                ) {
                  try {
                    const hit = findChitById(this.daemon.corpRoot, r.delta.chitId);
                    if (hit && hit.chit.type === 'task') {
                      const title = (hit.chit.fields as { task: TaskFields }).task.title;
                      logTaskAssignment(this.daemon.corpRoot, r.redispatch.targetSlug, title);
                      dispatchTaskToDm(this.daemon, r.redispatch.targetSlug, title, r.delta.chitId);
                      writeTaskEvent(
                        this.daemon.corpRoot,
                        `[TASK] "${title}" UNBLOCKED — dependency "${task.title}" ${task.status} — re-dispatched to ${r.redispatch.targetSlug}`,
                      );
                    }
                  } catch {
                    // DM dispatch failure is non-fatal — the Casket
                    // write IS the delivery; wake is observability.
                  }
                }
              }
            } catch (err) {
              logError(`[task-watcher] chain advance failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }

      // Check for assignment change
      if (task.assignedTo !== cached.assignedTo && task.assignedTo) {
        writeTaskEvent(
          this.daemon.corpRoot,
          `[TASK] "${task.title}" assigned to ${task.assignedTo}`,
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
