import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChit } from '../packages/shared/src/chits.js';

/**
 * Project 2.5 Phase 2 — cc-cli review-spawn CLI shell coverage.
 *
 * Mocks getCorpRoot + the DaemonClient.say path. Covers arg parsing,
 * chit-resolution failures, prompt assembly, and the say-dispatch
 * wiring. The actual prompt-content correctness is unit-tested in
 * review-verdict.test.ts's buildReviewPrompt block.
 */

let tmpCorpRoot: string;
const sayCalls: Array<{ slug: string; message: string }> = [];

vi.mock('../packages/cli/src/client.js', () => ({
  getCorpRoot: vi.fn(async () => tmpCorpRoot),
  getClient: vi.fn(() => ({
    say: vi.fn(async (slug: string, message: string) => {
      sayCalls.push({ slug, message });
      return { ok: true, from: slug, response: 'review chit written' };
    }),
  })),
}));

const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code ?? 0})`);
}) as never);

const { cmdReviewSpawn } = await import('../packages/cli/src/commands/review-spawn.js');

function writeMembers(corpRoot: string, members: Array<{ id: string; displayName: string; rank: string }>): void {
  const full = members.map((m) => ({
    ...m,
    status: 'active',
    type: 'agent',
    scope: 'corp',
    scopeId: '',
    agentDir: `agents/${m.id}/`,
    port: null,
    spawnedBy: 'mark',
    createdAt: new Date().toISOString(),
  }));
  writeFileSync(join(corpRoot, 'members.json'), JSON.stringify(full), 'utf-8');
}

function setupContractWithCompletedSibling(): { taskId: string; contractId: string; siblingId: string } {
  const sibling = createChit(tmpCorpRoot, {
    type: 'task',
    scope: 'corp',
    status: 'active',
    createdBy: 'coder',
    fields: {
      task: {
        title: 'first step',
        priority: 'normal',
        workflowStatus: 'completed',
        output: 'cache invalidation: invalidate by tenant before write',
      },
    } as never,
  });
  const task = createChit(tmpCorpRoot, {
    type: 'task',
    scope: 'corp',
    status: 'active',
    createdBy: 'coder',
    fields: {
      task: {
        title: 'second step',
        priority: 'normal',
        workflowStatus: 'under_review',
        output: 'wired cache invalidation per tenant',
      },
    } as never,
  });
  const contract = createChit(tmpCorpRoot, {
    type: 'contract',
    scope: 'corp',
    status: 'active',
    createdBy: 'coder',
    fields: {
      contract: {
        title: 'demo contract',
        goal: 'ship the cache fix',
        taskIds: [sibling.id, task.id],
        priority: 'normal',
        blueprintId: 'chit-bp-demo',
      },
    },
  });
  return { taskId: task.id, contractId: contract.id, siblingId: sibling.id };
}

describe('cmdReviewSpawn — CLI shell coverage', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpCorpRoot = join(tmpdir(), `cli-rev-spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpCorpRoot, { recursive: true });
    sayCalls.length = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    try { rmSync(tmpCorpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockClear();
  });

  function errOut(): string {
    return errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  }

  it('exits 1 when --task is missing', async () => {
    writeMembers(tmpCorpRoot, [{ id: 'coder', displayName: 'Coder', rank: 'worker' }]);
    await expect(cmdReviewSpawn(['--from', 'coder'])).rejects.toThrow(/process\.exit\(1\)/);
    expect(errOut()).toMatch(/--task.*required/);
  });

  it('exits 1 when --from is missing', async () => {
    writeMembers(tmpCorpRoot, [{ id: 'coder', displayName: 'Coder', rank: 'worker' }]);
    await expect(
      cmdReviewSpawn(['--task', 'chit-t-deadbeef']),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(errOut()).toMatch(/--from.*required/);
  });

  it('exits 1 when --task is malformed', async () => {
    writeMembers(tmpCorpRoot, [{ id: 'coder', displayName: 'Coder', rank: 'worker' }]);
    await expect(
      cmdReviewSpawn(['--task', 'not-a-chit-id', '--from', 'coder']),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(errOut()).toMatch(/not a valid chit id format/);
  });

  it('exits 1 when task chit does not resolve', async () => {
    writeMembers(tmpCorpRoot, [{ id: 'coder', displayName: 'Coder', rank: 'worker' }]);
    await expect(
      cmdReviewSpawn(['--task', 'chit-t-deadbeef', '--from', 'coder']),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(errOut()).toMatch(/task chit not found/);
  });

  it('exits 1 when task is not part of any contract', async () => {
    writeMembers(tmpCorpRoot, [{ id: 'coder', displayName: 'Coder', rank: 'worker' }]);
    const orphan = createChit(tmpCorpRoot, {
      type: 'task',
      scope: 'corp',
      status: 'active',
      createdBy: 'coder',
      fields: {
        task: { title: 'orphan', priority: 'normal', workflowStatus: 'under_review' },
      } as never,
    });
    await expect(
      cmdReviewSpawn(['--task', orphan.id, '--from', 'coder']),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(errOut()).toMatch(/not part of any contract/);
  });

  it('happy path: dispatches prompt to daemon.say with the reviewer slug + a review-mode prompt', async () => {
    writeMembers(tmpCorpRoot, [{ id: 'coder', displayName: 'Coder', rank: 'worker' }]);
    const { taskId } = setupContractWithCompletedSibling();

    await cmdReviewSpawn(['--task', taskId, '--from', 'coder']);

    expect(sayCalls).toHaveLength(1);
    expect(sayCalls[0]!.slug).toBe('coder');
    // Prompt mentions the verdicts + the task + the prior step's output
    // (proves contract resolution + prior-output assembly works).
    expect(sayCalls[0]!.message).toContain('**accept**');
    expect(sayCalls[0]!.message).toContain('**redo**');
    expect(sayCalls[0]!.message).toContain('**flag**');
    expect(sayCalls[0]!.message).toContain(taskId);
    expect(sayCalls[0]!.message).toContain('cache invalidation: invalidate by tenant');
  });

  it('--json mode emits structured output to stdout', async () => {
    writeMembers(tmpCorpRoot, [{ id: 'coder', displayName: 'Coder', rank: 'worker' }]);
    const { taskId, contractId } = setupContractWithCompletedSibling();

    await cmdReviewSpawn(['--task', taskId, '--from', 'coder', '--json']);

    const out = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.taskId).toBe(taskId);
    expect(parsed.contractId).toBe(contractId);
    expect(parsed.reviewerSlug).toBe('coder');
    expect(parsed.promptLength).toBeGreaterThan(100);
  });

  it('falls back to slug when reviewer is not in members.json', async () => {
    // No members.json entries at all — display-name resolution
    // returns the slug verbatim. Lets the operator dispatch even when
    // members.json hasn't been refreshed.
    writeMembers(tmpCorpRoot, []);
    const { taskId } = setupContractWithCompletedSibling();

    await cmdReviewSpawn(['--task', taskId, '--from', 'coder']);

    expect(sayCalls).toHaveLength(1);
    // Prompt header names the reviewer — falls back to slug since
    // members.json has no displayName.
    expect(sayCalls[0]!.message).toMatch(/You are coder\./);
  });
});
