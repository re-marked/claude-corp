import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { parse as parseFrontmatter } from '../packages/shared/src/parsers/frontmatter.js';

import { createApi } from '../packages/daemon/src/api.js';

/**
 * Regression test for POST /tasks/create silently dropping body fields.
 * The bug (fixed long ago, PR #96 class): api.ts manually listed
 * body.<field> extractions to build CreateTaskOpts, but missed
 * projectId / blockedBy / acceptanceCriteria.
 *
 * Post-0.3 migration: tasks live at <corpRoot>/chits/task/<id>.md
 * under the chit schema, not <corpRoot>/tasks/<id>.md. The test still
 * verifies the full field-threading contract end-to-end through the
 * API, just against the new storage location + chit frontmatter shape
 * (task-specific fields nest under `fields.task.*`).
 */

describe('POST /tasks/create body field threading', () => {
  let server: Server;
  let port: number;
  let corpRoot: string;

  beforeEach(async () => {
    corpRoot = join(tmpdir(), `corp-tasks-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(corpRoot, { recursive: true });
    mkdirSync(join(corpRoot, 'tasks'), { recursive: true });
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
    writeFileSync(join(corpRoot, 'channels.json'), '[]', 'utf-8');

    // Stub daemon — /tasks/create handler uses daemon.corpRoot,
    // daemon.analytics.trackTaskCreated(), daemon.heartbeat.refreshAll().
    const stubDaemon = {
      corpRoot,
      analytics: { trackTaskCreated: vi.fn() },
      heartbeat: { refreshAll: vi.fn() },
    } as unknown as Parameters<typeof createApi>[0];

    server = createApi(stubDaemon);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  async function postCreate(body: Record<string, unknown>) {
    return fetch(`http://127.0.0.1:${port}/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Parse the one created chit file and return a flat view of its
   * task-relevant fields (chit common + fields.task.* merged) so
   * existing test assertions keep working against the new shape.
   *
   * Task files post-migration live at:
   *   <corpRoot>/chits/task/<id>.md
   *
   * Frontmatter shape:
   *   id, type, status, createdBy, createdAt, updatedAt,
   *   references, dependsOn, tags, fields: { task: {...} }
   */
  function readOnlyTaskFields(): Record<string, unknown> {
    const taskDir = join(corpRoot, 'chits', 'task');
    expect(existsSync(taskDir), 'chits/task/ dir should exist after create').toBe(true);
    const files = readdirSync(taskDir).filter((f) => f.endsWith('.md'));
    expect(files, 'exactly one task chit file should exist').toHaveLength(1);
    const raw = readFileSync(join(taskDir, files[0]!), 'utf-8');
    const { meta } = parseFrontmatter<Record<string, unknown>>(raw);
    const data = meta;
    const taskFields =
      (data.fields as Record<string, unknown> | undefined)?.task as Record<string, unknown> | undefined ?? {};

    // Merge common-chit fields + task-specific fields for the test assertions
    // that predate the chit migration. Translate dependsOn/references back to
    // the blockedBy/parentTaskId names the old tests used.
    return {
      ...taskFields,
      id: data.id,
      status: taskFields.workflowStatus ?? data.status,
      createdBy: data.createdBy,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      blockedBy: Array.isArray(data.dependsOn) && data.dependsOn.length > 0 ? data.dependsOn : undefined,
      parentTaskId: Array.isArray(data.references) && data.references.length > 0 ? data.references[0] : undefined,
    };
  }

  it('persists acceptanceCriteria from body into the chit file', async () => {
    const res = await postCreate({
      title: 'Ship the feature',
      createdBy: 'mark',
      acceptanceCriteria: ['tests pass', 'docs updated'],
    });
    expect(res.status).toBe(200);

    const fields = readOnlyTaskFields();
    expect(fields.acceptanceCriteria).toEqual(['tests pass', 'docs updated']);
  });

  it('persists projectId from body into the chit file', async () => {
    await postCreate({
      title: 'Project work',
      createdBy: 'mark',
      projectId: 'proj-alpha',
    });

    const fields = readOnlyTaskFields();
    expect(fields.projectId).toBe('proj-alpha');
  });

  it('persists blockedBy from body (surfaces as chit.dependsOn)', async () => {
    await postCreate({
      title: 'Dependent work',
      createdBy: 'mark',
      blockedBy: ['cool-bay', 'warm-tide'],
    });

    const fields = readOnlyTaskFields();
    expect(fields.blockedBy).toEqual(['cool-bay', 'warm-tide']);
  });

  it('persists all new fields together alongside existing ones', async () => {
    await postCreate({
      title: 'Full-featured task',
      description: 'every field set',
      priority: 'high',
      assignedTo: 'pilot',
      createdBy: 'mark',
      projectId: 'proj-1',
      parentTaskId: 'task-parent',
      blockedBy: ['task-a'],
      acceptanceCriteria: ['acceptable'],
      dueAt: '2026-05-01T00:00:00.000Z',
    });

    const fields = readOnlyTaskFields();
    expect(fields.projectId).toBe('proj-1');
    expect(fields.parentTaskId).toBe('task-parent');
    expect(fields.blockedBy).toEqual(['task-a']);
    expect(fields.acceptanceCriteria).toEqual(['acceptable']);
    expect(fields.dueAt).toBe('2026-05-01T00:00:00.000Z');
    expect(fields.priority).toBe('high');
  });

  it('rejects when title or createdBy missing', async () => {
    const res1 = await postCreate({ createdBy: 'mark' });
    expect(res1.status).toBe(400);

    const res2 = await postCreate({ title: 'No creator' });
    expect(res2.status).toBe(400);

    // No chit should have been written — check the new location too
    const chitsTaskDir = join(corpRoot, 'chits', 'task');
    const chitFiles = existsSync(chitsTaskDir)
      ? readdirSync(chitsTaskDir).filter((f) => f.endsWith('.md'))
      : [];
    expect(chitFiles).toHaveLength(0);
  });
});
