import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  migrateTasksToChits,
  taskToChit,
} from '../packages/shared/src/migrations/migrate-tasks.js';
import { chitPath, readChit } from '../packages/shared/src/chits.js';
import { findTaskById } from '../packages/shared/src/tasks.js';
import type { Task } from '../packages/shared/src/types/task.js';
import { stringify as stringifyFrontmatter } from '../packages/shared/src/parsers/frontmatter.js';

function writeTaskFile(corpRoot: string, task: Task, body = ''): string {
  const tasksDir = join(corpRoot, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const path = join(tasksDir, `${task.id}.md`);
  writeFileSync(
    path,
    stringifyFrontmatter(task as unknown as Record<string, unknown>, body),
    'utf-8',
  );
  return path;
}

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-abc123',
    title: 'sample task',
    status: 'pending',
    priority: 'normal',
    assignedTo: null,
    createdBy: 'ceo',
    projectId: null,
    parentTaskId: null,
    blockedBy: null,
    handedBy: null,
    handedAt: null,
    teamId: null,
    acceptanceCriteria: null,
    dueAt: null,
    loopId: null,
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('taskToChit — pure mapping', () => {
  it('maps minimal task to chit with default field shape', () => {
    const chit = taskToChit(sampleTask());
    expect(chit.id).toBe('task-abc123');
    expect(chit.type).toBe('task');
    expect(chit.status).toBe('draft'); // pending → draft
    expect(chit.ephemeral).toBe(false);
    expect(chit.createdBy).toBe('ceo');
    expect(chit.references).toEqual([]);
    expect(chit.dependsOn).toEqual([]);
    expect(chit.tags).toEqual([]);
    expect(chit.fields.task.title).toBe('sample task');
    expect(chit.fields.task.priority).toBe('normal');
    expect(chit.fields.task.workflowStatus).toBe('pending');
  });

  it('maps every TaskStatus to the right coarse + fine pair', () => {
    const mappings = [
      ['pending', 'draft', 'pending'],
      ['assigned', 'draft', 'assigned'],
      ['in_progress', 'active', 'in_progress'],
      ['blocked', 'active', 'blocked'],
      ['completed', 'completed', 'completed'],
      ['failed', 'failed', 'failed'],
      ['cancelled', 'closed', 'cancelled'],
    ] as const;

    for (const [old, coarse, fine] of mappings) {
      const chit = taskToChit(sampleTask({ status: old }));
      expect(chit.status, `${old} → chit.status`).toBe(coarse);
      expect(chit.fields.task.workflowStatus, `${old} → workflowStatus`).toBe(fine);
    }
  });

  it('maps blockedBy → chit.dependsOn', () => {
    const chit = taskToChit(sampleTask({ blockedBy: ['task-abc001', 'task-abc002'] }));
    expect(chit.dependsOn).toEqual(['task-abc001', 'task-abc002']);
  });

  it('maps parentTaskId → chit.references', () => {
    const chit = taskToChit(sampleTask({ parentTaskId: 'task-parent' }));
    expect(chit.references).toEqual(['task-parent']);
  });

  it('preserves projectId and teamId as legacy fields', () => {
    const chit = taskToChit(sampleTask({ projectId: 'proj-xyz', teamId: 'team-abc' }));
    expect(chit.fields.task.projectId).toBe('proj-xyz');
    expect(chit.fields.task.teamId).toBe('team-abc');
  });

  it('preserves handedBy/handedAt timestamps', () => {
    const chit = taskToChit(
      sampleTask({ handedBy: 'engineering-lead', handedAt: '2026-04-21T12:00:00.000Z' }),
    );
    expect(chit.fields.task.handedBy).toBe('engineering-lead');
    expect(chit.fields.task.handedAt).toBe('2026-04-21T12:00:00.000Z');
  });

  it('preserves dueAt, loopId, acceptanceCriteria', () => {
    const chit = taskToChit(
      sampleTask({
        dueAt: '2026-04-28T00:00:00.000Z',
        loopId: 'task-loop01',
        acceptanceCriteria: ['tests pass', 'PR merged'],
      }),
    );
    expect(chit.fields.task.dueAt).toBe('2026-04-28T00:00:00.000Z');
    expect(chit.fields.task.loopId).toBe('task-loop01');
    expect(chit.fields.task.acceptanceCriteria).toEqual(['tests pass', 'PR merged']);
  });
});

describe('migrateTasksToChits — file migration', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'migrate-tasks-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('returns empty result when no tasks directory exists', () => {
    const result = migrateTasksToChits(corpRoot);
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('migrates a single task, writes chit, deletes source', () => {
    const task = sampleTask();
    const sourcePath = writeTaskFile(corpRoot, task, 'task body content');

    const result = migrateTasksToChits(corpRoot);
    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);

    expect(existsSync(sourcePath)).toBe(false);
    const targetPath = chitPath(corpRoot, 'corp', 'task', task.id);
    expect(existsSync(targetPath)).toBe(true);
  });

  it('preserves task body content in the migrated chit', () => {
    const task = sampleTask();
    writeTaskFile(corpRoot, task, 'important body content');

    migrateTasksToChits(corpRoot);

    const { body } = readChit(corpRoot, 'corp', 'task', task.id);
    expect(body.trim()).toBe('important body content');
  });

  it('migrates multiple tasks in one call', () => {
    writeTaskFile(corpRoot, sampleTask({ id: 'task-one' }));
    writeTaskFile(corpRoot, sampleTask({ id: 'task-two', title: 'second' }));
    writeTaskFile(corpRoot, sampleTask({ id: 'task-three', title: 'third' }));

    const result = migrateTasksToChits(corpRoot);
    expect(result.migrated).toBe(3);
    expect(existsSync(chitPath(corpRoot, 'corp', 'task', 'task-one'))).toBe(true);
    expect(existsSync(chitPath(corpRoot, 'corp', 'task', 'task-two'))).toBe(true);
    expect(existsSync(chitPath(corpRoot, 'corp', 'task', 'task-three'))).toBe(true);
  });

  it('is idempotent — re-running skips already-migrated tasks', () => {
    const task = sampleTask();
    writeTaskFile(corpRoot, task);

    const first = migrateTasksToChits(corpRoot);
    expect(first.migrated).toBe(1);

    // Re-create the source task (simulating a partial migration that
    // left the source alongside a newly-created chit)
    writeTaskFile(corpRoot, task);

    const second = migrateTasksToChits(corpRoot);
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('overwrites when opts.overwrite is true', () => {
    const task = sampleTask();
    writeTaskFile(corpRoot, task);

    migrateTasksToChits(corpRoot);
    writeTaskFile(corpRoot, task);

    const result = migrateTasksToChits(corpRoot, { overwrite: true });
    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('dry-run returns planned paths without writing or deleting', () => {
    const task = sampleTask();
    const sourcePath = writeTaskFile(corpRoot, task);

    const result = migrateTasksToChits(corpRoot, { dryRun: true });
    expect(result.migrated).toBe(0);
    expect(result.planned).toHaveLength(1);
    expect(result.planned[0].sourcePath).toBe(sourcePath);
    expect(result.planned[0].targetPath).toBe(chitPath(corpRoot, 'corp', 'task', task.id));

    // Source file still there; no chit written
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(chitPath(corpRoot, 'corp', 'task', task.id))).toBe(false);
  });

  it('continues through errors — one bad task does not stop the batch', () => {
    // A task with missing id
    const badTaskPath = join(corpRoot, 'tasks', 'bogus-task.md');
    mkdirSync(join(corpRoot, 'tasks'), { recursive: true });
    writeFileSync(badTaskPath, '---\n---\nno frontmatter meaningful', 'utf-8');

    // A good task
    writeTaskFile(corpRoot, sampleTask({ id: 'task-good' }));

    const result = migrateTasksToChits(corpRoot);
    expect(result.migrated).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].sourcePath).toBe(badTaskPath);
  });

  it('migrates project-scoped tasks to project-scoped chits', () => {
    const projectsDir = join(corpRoot, 'projects', 'fire-project', 'tasks');
    mkdirSync(projectsDir, { recursive: true });
    const task = sampleTask({ id: 'task-proj1', title: 'project task', projectId: 'fire-project' });
    writeFileSync(
      join(projectsDir, `${task.id}.md`),
      stringifyFrontmatter(task as unknown as Record<string, unknown>, 'project body'),
      'utf-8',
    );

    const result = migrateTasksToChits(corpRoot);
    expect(result.migrated).toBe(1);
    expect(result.errors).toEqual([]);

    // Source gone
    expect(existsSync(join(projectsDir, `${task.id}.md`))).toBe(false);
    // Chit at project-scoped location
    const chitTargetPath = join(corpRoot, 'projects', 'fire-project', 'chits', 'task', `${task.id}.md`);
    expect(existsSync(chitTargetPath)).toBe(true);
  });

  it('migrates corp + multiple project scopes in one call', () => {
    // Corp-level task
    writeTaskFile(corpRoot, sampleTask({ id: 'corp-task' }));

    // Two projects, each with tasks
    for (const project of ['alpha', 'beta']) {
      const dir = join(corpRoot, 'projects', project, 'tasks');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${project}-task.md`),
        stringifyFrontmatter(
          sampleTask({ id: `${project}-task`, title: `${project} task` }) as unknown as Record<string, unknown>,
          '',
        ),
        'utf-8',
      );
    }

    const result = migrateTasksToChits(corpRoot);
    expect(result.migrated).toBe(3); // 1 corp + 2 project-scoped

    // Each at the right location
    expect(existsSync(chitPath(corpRoot, 'corp', 'task', 'corp-task'))).toBe(true);
    expect(existsSync(chitPath(corpRoot, 'project:alpha', 'task', 'alpha-task'))).toBe(true);
    expect(existsSync(chitPath(corpRoot, 'project:beta', 'task', 'beta-task'))).toBe(true);
  });

  it('dry-run lists planned paths across corp + project scopes', () => {
    writeTaskFile(corpRoot, sampleTask({ id: 'corp-t' }));
    const projDir = join(corpRoot, 'projects', 'foo', 'tasks');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'proj-t.md'),
      stringifyFrontmatter(sampleTask({ id: 'proj-t' }) as unknown as Record<string, unknown>, ''),
      'utf-8',
    );

    const result = migrateTasksToChits(corpRoot, { dryRun: true });
    expect(result.migrated).toBe(0);
    expect(result.planned).toHaveLength(2);
    // Target paths reflect correct scopes
    const targetPaths = result.planned.map((p) => p.targetPath);
    expect(targetPaths.some((p) => p.includes(join('projects', 'foo', 'chits', 'task')))).toBe(true);
    expect(targetPaths.some((p) => !p.includes(join('projects', 'foo'))) && targetPaths.some((p) => p.includes(join('chits', 'task')))).toBe(true);
  });

  it('migrated chit passes chit-types validation (round-trip integrity)', () => {
    const task = sampleTask({
      id: 'task-roundtrip',
      status: 'in_progress',
      priority: 'high',
      assignedTo: 'backend-engineer',
      acceptanceCriteria: ['test passes'],
      blockedBy: ['task-dep1'],
      parentTaskId: 'task-parent',
    });
    writeTaskFile(corpRoot, task);

    migrateTasksToChits(corpRoot);

    // readChit parses + validates. If the migrated file is valid, this
    // returns cleanly. If not, it throws.
    const { chit } = readChit(corpRoot, 'corp', 'task', task.id);
    expect(chit.type).toBe('task');
    expect(chit.status).toBe('active');
    expect(chit.dependsOn).toEqual(['task-dep1']);
    expect(chit.references).toEqual(['task-parent']);
    expect(chit.fields.task.workflowStatus).toBe('in_progress');
    expect(chit.fields.task.assignee).toBe('backend-engineer');
  });
});

describe('findTaskById — scope-agnostic task lookup', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'find-task-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('finds a corp-scoped task after migration', () => {
    writeTaskFile(corpRoot, sampleTask({ id: 'corp-task-find' }), 'body here');
    migrateTasksToChits(corpRoot);

    const found = findTaskById(corpRoot, 'corp-task-find');
    expect(found).not.toBeNull();
    expect(found!.task.id).toBe('corp-task-find');
    expect(found!.body.trim()).toBe('body here');
  });

  it('finds a project-scoped task after migration', () => {
    const projDir = join(corpRoot, 'projects', 'fire', 'tasks');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'proj-task.md'),
      stringifyFrontmatter(sampleTask({ id: 'proj-task' }) as unknown as Record<string, unknown>, 'scoped body'),
      'utf-8',
    );

    migrateTasksToChits(corpRoot);

    const found = findTaskById(corpRoot, 'proj-task');
    expect(found).not.toBeNull();
    expect(found!.task.id).toBe('proj-task');
    expect(found!.path).toContain(join('projects', 'fire', 'chits', 'task'));
  });

  it('returns null for nonexistent task id', () => {
    expect(findTaskById(corpRoot, 'ghost-task')).toBeNull();
  });

  it('returns null when id resolves to a chit of different type', () => {
    // Create a non-task chit with a word-pair id
    const raw = `---
id: casket-someagent
type: casket
status: active
ephemeral: false
createdBy: daemon
createdAt: '2026-04-20T00:00:00.000Z'
updatedAt: '2026-04-20T00:00:00.000Z'
references: []
dependsOn: []
tags: []
fields:
  casket:
    currentStep: null
---
`;
    const path = chitPath(corpRoot, 'agent:someagent', 'casket', 'casket-someagent');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, raw, 'utf-8');

    // findTaskById should reject non-task chit types
    expect(findTaskById(corpRoot, 'casket-someagent')).toBeNull();
  });
});
