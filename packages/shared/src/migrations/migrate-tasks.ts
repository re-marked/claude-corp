/**
 * Migration: convert pre-chits Task files to Chit files of type=task.
 *
 * The pre-chits format lives at `<corpRoot>/tasks/<id>.md` — flat, no
 * scope encoding. After migration, the same task lives at
 * `<corpRoot>/chits/task/<id>.md` under the Chit schema with the
 * full field-mapping preserved (no data loss):
 *
 *   Task field            → Chit representation
 *   --------------------- → ----------------------------
 *   id                    → chit.id (preserved verbatim)
 *   status (old enum)     → chit.status (coarse) + fields.task.workflowStatus (fine)
 *   priority              → fields.task.priority
 *   title                 → fields.task.title
 *   assignedTo            → fields.task.assignee
 *   acceptanceCriteria    → fields.task.acceptanceCriteria
 *   dueAt                 → fields.task.dueAt
 *   loopId                → fields.task.loopId
 *   handedBy              → fields.task.handedBy
 *   handedAt              → fields.task.handedAt
 *   projectId             → fields.task.projectId (legacy link)
 *   teamId                → fields.task.teamId (legacy link)
 *   parentTaskId          → chit.references (loose pointer)
 *   blockedBy             → chit.dependsOn (hard edges, chain semantics)
 *   createdBy/createdAt/updatedAt → chit common fields verbatim
 *
 * Idempotent: if a chit already exists at the target path, the source
 * task is skipped (not overwritten) unless `overwrite: true` is passed.
 * Sources are deleted only after the target chit is confirmed on disk,
 * so a half-migration leaves a valid state (source-only or target-only,
 * never corrupted/orphan).
 *
 * Designed to be invoked once per corp via `cc-cli migrate tasks`.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, TaskStatus } from '../types/task.js';
import type { Chit, ChitStatus, TaskFields, TaskWorkflowStatus } from '../types/chit.js';
import { atomicWriteSync } from '../atomic-write.js';
import {
  parse as parseFrontmatter,
  stringify as stringifyFrontmatter,
} from '../parsers/frontmatter.js';
import { chitPath } from '../chits.js';

export interface TaskMigrationResult {
  /** Count of tasks successfully migrated to chits. */
  migrated: number;
  /** Count of tasks skipped (chit already exists at target; idempotency). */
  skipped: number;
  /** Per-task errors collected during migration; never crashes the whole run. */
  errors: Array<{ sourcePath: string; error: string }>;
  /** For dry-run reporting: the planned target paths without writing them. */
  planned: Array<{ sourcePath: string; targetPath: string }>;
}

export interface TaskMigrationOpts {
  /** Don't write chits or delete sources — just report what would happen. */
  dryRun?: boolean;
  /** If a chit already exists at the target path, overwrite it. Default false (skip). */
  overwrite?: boolean;
}

/**
 * Map the pre-chits TaskStatus enum to the chit layer's coarse
 * status + the task-specific workflowStatus. Lossless round-trip for
 * every value in the old enum.
 */
function mapStatus(old: TaskStatus): { chitStatus: ChitStatus; workflowStatus: TaskWorkflowStatus } {
  // Legacy TaskStatus (7 values) → 1.3 TaskWorkflowStatus (10 values).
  // The new enum has strictly more distinctions, so the mapping is
  // conservative: the legacy "assigned" becomes "queued" (not yet
  // dispatched — the daemon's delivery cycle will flip to "dispatched"
  // on the first real dispatch attempt for migrated tasks).
  switch (old) {
    case 'pending':
      return { chitStatus: 'draft', workflowStatus: 'draft' };
    case 'assigned':
      return { chitStatus: 'draft', workflowStatus: 'queued' };
    case 'in_progress':
      return { chitStatus: 'active', workflowStatus: 'in_progress' };
    case 'blocked':
      return { chitStatus: 'active', workflowStatus: 'blocked' };
    case 'completed':
      return { chitStatus: 'completed', workflowStatus: 'completed' };
    case 'failed':
      return { chitStatus: 'failed', workflowStatus: 'failed' };
    case 'cancelled':
      return { chitStatus: 'closed', workflowStatus: 'cancelled' };
    default:
      // Unknown status — fallback to draft to preserve chit validity.
      return { chitStatus: 'draft', workflowStatus: 'draft' };
  }
}

/**
 * Convert a Task object (with its body) into a Chit of type=task. Pure
 * function — no I/O. Every field has a home in the new shape.
 */
export function taskToChit(task: Task): Chit<'task'> {
  const { chitStatus, workflowStatus } = mapStatus(task.status);

  const fields: TaskFields = {
    title: task.title,
    priority: task.priority,
    assignee: task.assignedTo ?? null,
    acceptanceCriteria: task.acceptanceCriteria ?? null,
    complexity: task.complexity ?? null,
    dueAt: task.dueAt ?? null,
    loopId: task.loopId ?? null,
    handedBy: task.handedBy ?? null,
    handedAt: task.handedAt ?? null,
    projectId: task.projectId ?? null,
    teamId: task.teamId ?? null,
    workflowStatus,
  };

  const references = task.parentTaskId ? [task.parentTaskId] : [];
  const dependsOn = task.blockedBy ?? [];

  return {
    id: task.id,
    type: 'task',
    status: chitStatus,
    ephemeral: false,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    references,
    dependsOn,
    tags: [],
    fields: { task: fields },
  } as Chit<'task'>;
}

/**
 * Walk the corp and migrate every pre-chits Task file to a Chit.
 *
 * Two source locations covered:
 *   1. `<corpRoot>/tasks/<id>.md` (corp-flat, common case) →
 *      `<corpRoot>/chits/task/<id>.md`
 *   2. `<corpRoot>/projects/<name>/tasks/<id>.md` (project-scoped,
 *      created when a contract's tasks live inside a project) →
 *      `<corpRoot>/projects/<name>/chits/task/<id>.md`
 *
 * Scope encoding: corp-flat tasks migrate to corp scope. Project-scoped
 * tasks migrate to `project:<name>` scope so their filesystem location
 * still matches the chit primitive's scope semantics. Contract-watcher,
 * contracts.ts, and heartbeat — all of which previously manually scanned
 * project-scoped task paths — now find these via findTaskById /
 * listTasks which query across all scopes.
 *
 * Returns a structured result so callers (cc-cli migrate tasks, test
 * fixtures) can report success/skipped/errors without parsing stderr.
 */
export function migrateTasksToChits(
  corpRoot: string,
  opts: TaskMigrationOpts = {},
): TaskMigrationResult {
  const result: TaskMigrationResult = {
    migrated: 0,
    skipped: 0,
    errors: [],
    planned: [],
  };

  // Phase 1 — corp-flat <corpRoot>/tasks/
  migrateTasksAtDir(corpRoot, join(corpRoot, 'tasks'), 'corp', opts, result);

  // Phase 2 — project-scoped <corpRoot>/projects/<name>/tasks/
  const projectsDir = join(corpRoot, 'projects');
  if (existsSync(projectsDir)) {
    for (const projEntry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projEntry.isDirectory()) continue;
      const projectName = projEntry.name;
      const projTasksDir = join(projectsDir, projectName, 'tasks');
      migrateTasksAtDir(corpRoot, projTasksDir, `project:${projectName}`, opts, result);
    }
  }

  return result;
}

/**
 * Inner helper: walk a single tasks/ directory, convert each Task to
 * a Chit at the given scope. Mutates `result` so the outer caller can
 * aggregate across multiple scope dirs.
 */
function migrateTasksAtDir(
  corpRoot: string,
  tasksDir: string,
  scope: 'corp' | `project:${string}` | `agent:${string}` | `team:${string}`,
  opts: TaskMigrationOpts,
  result: TaskMigrationResult,
): void {
  if (!existsSync(tasksDir)) return;

  const files = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    const sourcePath = join(tasksDir, file);
    try {
      const raw = readFileSync(sourcePath, 'utf-8');
      const { meta, body } = parseFrontmatter<Task>(raw);

      if (!meta.id) {
        result.errors.push({ sourcePath, error: 'task has no id' });
        continue;
      }

      const chit = taskToChit(meta);
      const targetPath = chitPath(corpRoot, scope, 'task', chit.id);

      if (existsSync(targetPath) && !opts.overwrite) {
        // Idempotent skip — already migrated.
        result.skipped++;
        continue;
      }

      result.planned.push({ sourcePath, targetPath });

      if (opts.dryRun) {
        continue;
      }

      const content = stringifyFrontmatter(chit as unknown as Record<string, unknown>, body);
      atomicWriteSync(targetPath, content);
      rmSync(sourcePath);

      result.migrated++;
    } catch (err) {
      result.errors.push({ sourcePath, error: (err as Error).message });
    }
  }
}
