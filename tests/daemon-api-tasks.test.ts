import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';

import { createApi } from '../packages/daemon/src/api.js';

/**
 * Regression test for POST /tasks/create silently dropping body fields.
 * The bug: api.ts manually listed body.<field> extractions to build
 * CreateTaskOpts, but missed projectId / blockedBy / acceptanceCriteria.
 * Same class as the /agents/hire harness drop fixed in PR #96.
 *
 * Uses real createTask + filesystem rather than mocking, since
 * @claudecorp/shared resolves via workspace symlinks that aren't visible
 * to a vi.mock() target from the tests/ directory.
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
   * The created task is written to `<corpRoot>/tasks/<id>.md` as a
   * markdown file with YAML frontmatter. Read the first (and only)
   * task file back and return parsed frontmatter fields as a simple
   * string-keyed object.
   */
  function readOnlyTaskFrontmatter(): Record<string, string | string[] | undefined> {
    const files = readdirSync(join(corpRoot, 'tasks')).filter(f => f.endsWith('.md'));
    expect(files, 'exactly one task markdown file should exist').toHaveLength(1);
    const raw = readFileSync(join(corpRoot, 'tasks', files[0]!), 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match, 'task file should have YAML frontmatter').toBeTruthy();
    const fm: Record<string, string | string[]> = {};
    let currentListKey: string | null = null;
    for (const line of match![1]!.split('\n')) {
      if (line.startsWith('  - ') && currentListKey) {
        (fm[currentListKey] as string[]).push(line.slice(4).replace(/^['"]|['"]$/g, ''));
        continue;
      }
      currentListKey = null;
      const kv = line.match(/^([a-zA-Z]+): ?(.*)$/);
      if (!kv) continue;
      const [, key, value] = kv;
      if (value === '') {
        fm[key!] = [];
        currentListKey = key!;
      } else {
        fm[key!] = value!.replace(/^['"]|['"]$/g, '');
      }
    }
    return fm;
  }

  it('persists acceptanceCriteria from body into the task file', async () => {
    const res = await postCreate({
      title: 'Ship the feature',
      createdBy: 'mark',
      acceptanceCriteria: ['tests pass', 'docs updated'],
    });
    expect(res.status).toBe(200);

    const fm = readOnlyTaskFrontmatter();
    expect(fm.acceptanceCriteria).toEqual(['tests pass', 'docs updated']);
  });

  it('persists projectId from body into the task file', async () => {
    await postCreate({
      title: 'Project work',
      createdBy: 'mark',
      projectId: 'proj-alpha',
    });

    const fm = readOnlyTaskFrontmatter();
    expect(fm.projectId).toBe('proj-alpha');
  });

  it('persists blockedBy from body into the task file', async () => {
    await postCreate({
      title: 'Dependent work',
      createdBy: 'mark',
      blockedBy: ['cool-bay', 'warm-tide'],
    });

    const fm = readOnlyTaskFrontmatter();
    expect(fm.blockedBy).toEqual(['cool-bay', 'warm-tide']);
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

    const fm = readOnlyTaskFrontmatter();
    expect(fm.projectId).toBe('proj-1');
    expect(fm.parentTaskId).toBe('task-parent');
    expect(fm.blockedBy).toEqual(['task-a']);
    expect(fm.acceptanceCriteria).toEqual(['acceptable']);
    expect(fm.dueAt).toBe('2026-05-01T00:00:00.000Z');
    expect(fm.priority).toBe('high');
  });

  it('rejects when title or createdBy missing', async () => {
    const res1 = await postCreate({ createdBy: 'mark' });
    expect(res1.status).toBe(400);

    const res2 = await postCreate({ title: 'No creator' });
    expect(res2.status).toBe(400);

    const files = readdirSync(join(corpRoot, 'tasks')).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(0);
  });
});
