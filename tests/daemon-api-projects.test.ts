import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApi } from '../packages/daemon/src/api.js';

/**
 * Regression test for the third instance of the "HTTP body field
 * silently dropped" bug pattern (see PRs #96 for /agents/hire harness
 * and #97 for /tasks/create projectId/blockedBy/acceptanceCriteria).
 * POST /projects/create was dropping body.displayName from its hand-
 * listed extraction, so the underlying CreateProjectOpts.displayName
 * was always undefined — projects fell back to the slugified name for
 * their human-readable name.
 *
 * Uses real createProject against a tmp corp (same approach as
 * daemon-api-tasks.test.ts) since @claudecorp/shared isn't mock-able
 * from the tests/ directory.
 */

describe('POST /projects/create body field threading', () => {
  let server: Server;
  let port: number;
  let corpRoot: string;

  beforeEach(async () => {
    corpRoot = join(tmpdir(), `corp-projects-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(corpRoot, { recursive: true });
    mkdirSync(join(corpRoot, 'projects'), { recursive: true });
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
    writeFileSync(join(corpRoot, 'channels.json'), '[]', 'utf-8');
    writeFileSync(join(corpRoot, 'projects.json'), '[]', 'utf-8');

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
    return fetch(`http://127.0.0.1:${port}/projects/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function readOnlyProject(): Record<string, unknown> {
    const raw = readFileSync(join(corpRoot, 'projects.json'), 'utf-8');
    const projects = JSON.parse(raw) as Record<string, unknown>[];
    expect(projects).toHaveLength(1);
    return projects[0]!;
  }

  it('persists body.displayName into the project', async () => {
    const res = await postCreate({
      name: 'claude-corp',
      displayName: 'Claude Corp',
      type: 'codebase',
      createdBy: 'mark',
    });
    expect(res.status).toBe(200);

    const project = readOnlyProject();
    expect(project.name).toBe('claude-corp');
    expect(project.displayName).toBe('Claude Corp');
  });

  it('falls back to slugified name when displayName omitted', async () => {
    await postCreate({ name: 'my-app', type: 'codebase', createdBy: 'mark' });

    const project = readOnlyProject();
    expect(project.displayName).toBe('my-app');
  });

  it('threads all optional fields alongside displayName', async () => {
    await postCreate({
      name: 'alpha',
      displayName: 'Alpha Project',
      type: 'codebase',
      path: '/some/repo/path',
      lead: 'mark',
      description: 'The initial push',
      createdBy: 'mark',
    });

    const project = readOnlyProject();
    expect(project.displayName).toBe('Alpha Project');
    expect(project.path).toBe('/some/repo/path');
    expect(project.lead).toBe('mark');
    expect(project.description).toBe('The initial push');
  });

  it('rejects when required fields missing', async () => {
    const res1 = await postCreate({ type: 'codebase', createdBy: 'mark' });
    expect(res1.status).toBe(400);

    const res2 = await postCreate({ name: 'x', createdBy: 'mark' });
    expect(res2.status).toBe(400);

    const res3 = await postCreate({ name: 'x', type: 'codebase' });
    expect(res3.status).toBe(400);

    const files = readdirSync(corpRoot).filter(f => f === 'projects.json');
    const projects = JSON.parse(readFileSync(join(corpRoot, files[0]!), 'utf-8'));
    expect(projects).toEqual([]);
  });
});
