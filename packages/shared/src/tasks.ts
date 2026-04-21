/**
 * tasks.ts — thin compatibility wrapper over the chit primitive.
 *
 * Post-0.3-migration, tasks live as Chits of type=task under the chit
 * substrate. This module preserves the pre-chits external API
 * (createTask, readTask, updateTask, listTasks, taskPath) so the 13+
 * call sites across daemon/tui/cli don't need cascade updates. Every
 * function in here is a thin wrapper that:
 *
 *   1. Converts caller-side Task shape to chit shape via taskToChit
 *   2. Calls the chit primitive (createChit/readChit/updateChit/queryChits)
 *   3. Converts chit shape back to Task shape via chitToTask
 *
 * The old-format Task files (<corpRoot>/tasks/<id>.md) are migrated by
 * packages/shared/src/migrations/migrate-tasks.ts; this module only
 * deals with the post-migration layout (<corpRoot>/chits/task/<id>.md).
 *
 * Backward-compat path handling: taskPath returns the NEW chit-based
 * path, but readTask/updateTask accept either the old or new path
 * format — they extract the id from the filename and look up the
 * chit via findChitById, so callers that cached old paths still work.
 */

import { basename, dirname } from 'node:path';
import type { Task, TaskStatus, TaskPriority } from './types/task.js';
import type { Chit, ChitStatus, TaskFields } from './types/chit.js';
import {
  createChit,
  readChit,
  updateChit,
  queryChits,
  findChitById,
  chitPath,
} from './chits.js';
import { taskId } from './id.js';
import { taskToChit } from './migrations/migrate-tasks.js';

export interface CreateTaskOpts {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignedTo?: string | null;
  createdBy: string;
  projectId?: string | null;
  parentTaskId?: string | null;
  blockedBy?: string[] | null;
  acceptanceCriteria?: string[];
  dueAt?: string | null;
}

export interface TaskFilter {
  status?: TaskStatus;
  assignedTo?: string;
  projectId?: string;
  priority?: TaskPriority;
  createdBy?: string;
}

export interface TaskWithBody {
  task: Task;
  body: string;
  path: string;
}

// ─── Chit → Task reverse mapping ────────────────────────────────────

/**
 * Convert a Chit of type=task back into the caller-facing Task shape.
 * Fine-grained workflowStatus (preserved through migration or set by
 * createTask) is the primary source for Task.status; falls back to
 * deriving from chit.status + assignee when workflowStatus is missing.
 */
function chitToTask(chit: Chit<'task'>): Task {
  const fields = chit.fields.task;
  return {
    id: chit.id,
    title: fields.title,
    status: fields.workflowStatus ?? deriveTaskStatus(chit.status, fields.assignee ?? null),
    priority: fields.priority,
    assignedTo: fields.assignee ?? null,
    createdBy: chit.createdBy,
    projectId: fields.projectId ?? null,
    parentTaskId: chit.references[0] ?? null,
    blockedBy: chit.dependsOn.length > 0 ? [...chit.dependsOn] : null,
    handedBy: fields.handedBy ?? null,
    handedAt: fields.handedAt ?? null,
    teamId: fields.teamId ?? null,
    acceptanceCriteria: fields.acceptanceCriteria ?? null,
    dueAt: fields.dueAt ?? null,
    loopId: fields.loopId ?? null,
    createdAt: chit.createdAt,
    updatedAt: chit.updatedAt,
  };
}

function deriveTaskStatus(chitStatus: ChitStatus, assignee: string | null): TaskStatus {
  switch (chitStatus) {
    case 'draft':
      return assignee ? 'assigned' : 'pending';
    case 'active':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'rejected':
      return 'failed';
    case 'closed':
      return 'cancelled';
    default:
      return 'pending';
  }
}

// ─── Path helpers ───────────────────────────────────────────────────

/**
 * Extract corpRoot + id from a task file path. Accepts either the
 * old-format (<corpRoot>/tasks/<id>.md) or the new chit-format
 * (<corpRoot>/chits/task/<id>.md), so callers that cached pre-migration
 * paths keep working after migration.
 */
function parseTaskFilePath(filePath: string): { corpRoot: string; id: string } {
  const id = basename(filePath).replace(/\.md$/, '');
  const parentDir = dirname(filePath);
  const parentBase = basename(parentDir);

  // Case 1: <corpRoot>/tasks/<id>.md (pre-migration path)
  if (parentBase === 'tasks') {
    return { corpRoot: dirname(parentDir), id };
  }
  // Case 2: <corpRoot>/chits/task/<id>.md (post-migration path)
  if (parentBase === 'task' && basename(dirname(parentDir)) === 'chits') {
    return { corpRoot: dirname(dirname(parentDir)), id };
  }
  throw new Error(`cannot parse task file path: ${filePath}`);
}

/**
 * Filesystem path for a task by id at corp scope. Returns the chit-based
 * path since that's where tasks live post-migration. For tasks that
 * might live under project scope, use findTaskById which resolves across
 * all scopes automatically.
 */
export function taskPath(corpRoot: string, id: string): string {
  return chitPath(corpRoot, 'corp', 'task', id);
}

/**
 * Look up a task by id across every scope (corp + agents + projects +
 * teams). Returns null if no task with that id exists anywhere. Uses
 * findChitById under the hood, which handles both modern chit-format
 * ids and legacy word-pair ids via scan-fallback.
 *
 * Replaces the manual "try corp/, fall back to project/" path
 * construction that was scattered across contract-watcher, contracts.ts,
 * and heartbeat.ts. Those call sites should migrate to this helper.
 */
export function findTaskById(
  corpRoot: string,
  id: string,
): { task: Task; body: string; path: string } | null {
  const found = findChitById(corpRoot, id);
  if (!found) return null;
  if (found.chit.type !== 'task') return null;
  return {
    task: chitToTask(found.chit as Chit<'task'>),
    body: found.body,
    path: found.path,
  };
}

// ─── CRUD wrappers ──────────────────────────────────────────────────

/**
 * Create a new task. Generates a word-pair id via taskId(), constructs
 * the chit shape via taskToChit, writes through the chit primitive.
 * Returns the Task shape callers expect.
 */
export function createTask(corpRoot: string, opts: CreateTaskOpts): Task {
  const id = taskId();
  const now = new Date().toISOString();
  const initialStatus: TaskStatus = opts.assignedTo ? 'assigned' : 'pending';

  // Build the Task as the caller-returned shape first, then convert via
  // the shared taskToChit mapping to stay consistent with migration logic.
  const task: Task = {
    id,
    title: opts.title,
    status: initialStatus,
    priority: opts.priority ?? 'normal',
    assignedTo: opts.assignedTo ?? null,
    createdBy: opts.createdBy,
    projectId: opts.projectId ?? null,
    parentTaskId: opts.parentTaskId ?? null,
    blockedBy: opts.blockedBy ?? null,
    handedBy: null,
    handedAt: null,
    teamId: null,
    acceptanceCriteria: opts.acceptanceCriteria ?? null,
    dueAt: opts.dueAt ?? null,
    loopId: null,
    createdAt: now,
    updatedAt: now,
  };

  const chitShape = taskToChit(task);

  // Compose the markdown body (preserves pre-migration behavior —
  // description + acceptance-criteria checklist + progress-notes stub).
  let body = opts.description ? `${opts.description}\n\n` : '';
  if (opts.acceptanceCriteria && opts.acceptanceCriteria.length > 0) {
    body += `## Acceptance Criteria\n${opts.acceptanceCriteria
      .map((c) => `- [ ] ${c}`)
      .join('\n')}\n\n`;
  }
  body += `## Progress Notes\n`;

  const createdChit = createChit(corpRoot, {
    type: 'task',
    scope: 'corp',
    id,
    fields: { task: chitShape.fields.task },
    createdBy: task.createdBy,
    status: chitShape.status,
    ephemeral: false,
    references: chitShape.references,
    dependsOn: chitShape.dependsOn,
    tags: [],
    body,
  });

  // Return the Task shape derived from the freshly-written chit so
  // timestamps + any normalization reflect the actual persisted state.
  return chitToTask(createdChit);
}

/**
 * Read a task by filesystem path. Accepts old or new path format;
 * always routes through the chit primitive. Returns Task shape + body.
 */
export function readTask(filePath: string): { task: Task; body: string } {
  const { corpRoot, id } = parseTaskFilePath(filePath);
  const { chit, body } = readChit(corpRoot, 'corp', 'task', id);
  return { task: chitToTask(chit as Chit<'task'>), body };
}

/**
 * Update a task's frontmatter fields. Reads current chit, applies
 * Task-level update, converts back to chit shape, writes through the
 * chit primitive. Bumps updatedAt automatically. Requires at least
 * Task.createdBy on existing chit to populate updatedBy — defaults to
 * 'system' when caller doesn't attribute (preserves pre-chits API shape
 * where updateTask had no updatedBy param).
 */
export function updateTask(filePath: string, updates: Partial<Task>): Task {
  const { corpRoot, id } = parseTaskFilePath(filePath);

  const { chit: currentChit } = readChit(corpRoot, 'corp', 'task', id);
  const currentTask = chitToTask(currentChit as Chit<'task'>);
  const merged: Task = {
    ...currentTask,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  // Re-derive chit shape from merged task so every field is internally
  // consistent (status ↔ workflowStatus pair, blockedBy ↔ dependsOn, etc.).
  const mergedChit = taskToChit(merged);

  const updatedChit = updateChit(corpRoot, 'corp', 'task', id, {
    status: mergedChit.status,
    fields: { task: mergedChit.fields.task } as Partial<{ task: TaskFields }>,
    references: mergedChit.references,
    dependsOn: mergedChit.dependsOn,
    tags: currentChit.tags,
    updatedBy: 'system',
  });

  return chitToTask(updatedChit as Chit<'task'>);
}

/**
 * List tasks, optionally filtered. Walks all chits of type=task via
 * the chit query engine, converts each to Task shape, applies caller-
 * side filters in-memory. Filter semantics preserved from pre-chits
 * (single-value AND across flags).
 */
export function listTasks(corpRoot: string, filter?: TaskFilter): TaskWithBody[] {
  const { chits } = queryChits(corpRoot, { types: ['task'], limit: 0 });

  let results: TaskWithBody[] = chits.map(({ chit, body, path }) => ({
    task: chitToTask(chit as Chit<'task'>),
    body,
    path,
  }));

  if (filter) {
    results = results.filter(({ task }) => {
      if (filter.status && task.status !== filter.status) return false;
      if (filter.assignedTo && task.assignedTo !== filter.assignedTo) return false;
      if (filter.priority && task.priority !== filter.priority) return false;
      if (filter.projectId && task.projectId !== filter.projectId) return false;
      if (filter.createdBy && task.createdBy !== filter.createdBy) return false;
      return true;
    });
  }

  return results;
}
