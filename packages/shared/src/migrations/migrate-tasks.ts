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
  switch (old) {
    case 'pending':
      return { chitStatus: 'draft', workflowStatus: 'pending' };
    case 'assigned':
      return { chitStatus: 'draft', workflowStatus: 'assigned' };
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
      // Unknown status — fallback to draft/pending to preserve the chit's validity.
      return { chitStatus: 'draft', workflowStatus: 'pending' };
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
 * Walk `<corpRoot>/tasks/` and migrate every Task file to a Chit at
 * `<corpRoot>/chits/task/<id>.md`. Corp-scoped migration — the existing
 * task layout is flat under corpRoot, so tasks land at corp scope with
 * projectId/teamId preserved as fields for cross-reference.
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

  const tasksDir = join(corpRoot, 'tasks');
  if (!existsSync(tasksDir)) return result;

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
      const targetPath = chitPath(corpRoot, 'corp', 'task', chit.id);

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

  return result;
}
