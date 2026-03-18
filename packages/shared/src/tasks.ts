import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, TaskStatus, TaskPriority } from './types/task.js';
import { parse as parseFrontmatter, stringify as stringifyFrontmatter } from './parsers/frontmatter.js';
import { generateId } from './id.js';

export interface CreateTaskOpts {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignedTo?: string | null;
  createdBy: string;
  projectId?: string | null;
  parentTaskId?: string | null;
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

/** Create a task file in {corpRoot}/tasks/{id}.md */
export function createTask(corpRoot: string, opts: CreateTaskOpts): Task {
  const tasksDir = join(corpRoot, 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  const id = generateId();
  const now = new Date().toISOString();

  const task: Task = {
    id,
    title: opts.title,
    status: opts.assignedTo ? 'assigned' : 'pending',
    priority: opts.priority ?? 'normal',
    assignedTo: opts.assignedTo ?? null,
    createdBy: opts.createdBy,
    projectId: opts.projectId ?? null,
    parentTaskId: opts.parentTaskId ?? null,
    teamId: null,
    dueAt: opts.dueAt ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const body = opts.description
    ? `${opts.description}\n\n## Progress Notes\n`
    : `## Progress Notes\n`;

  const content = stringifyFrontmatter(task as unknown as Record<string, unknown>, body);
  writeFileSync(join(tasksDir, `${id}.md`), content, 'utf-8');

  return task;
}

/** Read a task from its file path */
export function readTask(filePath: string): { task: Task; body: string } {
  const raw = readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter<Task>(raw);
  return { task: meta, body };
}

/** Update task frontmatter fields */
export function updateTask(filePath: string, updates: Partial<Task>): Task {
  const raw = readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter<Task>(raw);

  const updated: Task = {
    ...meta,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const content = stringifyFrontmatter(updated as unknown as Record<string, unknown>, body);
  writeFileSync(filePath, content, 'utf-8');

  return updated;
}

/** List all tasks in {corpRoot}/tasks/, optionally filtered */
export function listTasks(corpRoot: string, filter?: TaskFilter): TaskWithBody[] {
  const tasksDir = join(corpRoot, 'tasks');
  if (!existsSync(tasksDir)) return [];

  const files = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
  const results: TaskWithBody[] = [];

  for (const file of files) {
    const filePath = join(tasksDir, file);
    try {
      const { task, body } = readTask(filePath);

      if (filter) {
        if (filter.status && task.status !== filter.status) continue;
        if (filter.assignedTo && task.assignedTo !== filter.assignedTo) continue;
        if (filter.priority && task.priority !== filter.priority) continue;
        if (filter.projectId && task.projectId !== filter.projectId) continue;
        if (filter.createdBy && task.createdBy !== filter.createdBy) continue;
      }

      results.push({ task, body, path: filePath });
    } catch {
      // Skip malformed task files
    }
  }

  return results;
}

/** Get the file path for a task by ID */
export function taskPath(corpRoot: string, taskId: string): string {
  return join(corpRoot, 'tasks', `${taskId}.md`);
}
