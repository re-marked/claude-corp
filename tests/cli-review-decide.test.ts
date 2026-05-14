import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChit } from '../packages/shared/src/chits.js';

/**
 * Project 2.5 — cli-review-decide CLI plumbing coverage.
 *
 * The underlying verdict-application logic is tested at the library
 * level (review-verdict.test.ts). These tests cover the CLI shell:
 * arg parsing, founder fallback, output shape, exit codes.
 */

let tmpCorpRoot: string;
vi.mock('../packages/cli/src/client.js', () => ({
  getCorpRoot: vi.fn(async () => tmpCorpRoot),
  getMembers: vi.fn((corpRoot: string) => {
    const path = join(corpRoot, 'members.json');
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf-8'));
  }),
}));

const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code ?? 0})`);
}) as never);

const { cmdReviewDecide } = await import('../packages/cli/src/commands/review-decide.js');

interface FixtureMember {
  id: string;
  displayName: string;
  rank: string;
  agentDir: string;
}

function writeMembers(corpRoot: string, members: FixtureMember[]) {
  const full = members.map((m) => ({
    ...m,
    status: 'active',
    type: 'agent',
    scope: 'corp',
    scopeId: 'test',
    port: null,
    spawnedBy: 'mark',
    createdAt: new Date().toISOString(),
  }));
  writeFileSync(join(corpRoot, 'members.json'), JSON.stringify(full), 'utf-8');
}

/** Cast a small under_review task + an accept-verdict review chit; return ids. */
function setupAcceptCase(): { reviewId: string; taskId: string; contractId: string } {
  const task = createChit(tmpCorpRoot, {
    type: 'task',
    scope: 'corp',
    status: 'active',
    createdBy: 'coder',
    fields: {
      task: {
        title: 'demo task',
        priority: 'normal',
        workflowStatus: 'under_review',
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
        goal: 'demo goal',
        taskIds: [task.id],
        priority: 'normal',
      },
    },
  });
  const review = createChit(tmpCorpRoot, {
    type: 'review',
    scope: 'agent:coder',
    createdBy: 'coder',
    fields: {
      review: {
        verdict: 'accept',
        reasoning: 'looks good',
        taskId: task.id,
        contractId: contract.id,
        reviewerSlug: 'coder',
      },
    } as never,
  });
  return { reviewId: review.id, taskId: task.id, contractId: contract.id };
}

describe('cmdReviewDecide — CLI shell coverage', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpCorpRoot = join(tmpdir(), `cli-rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpCorpRoot, { recursive: true });
    // Spy on console.log / console.error directly — console.log
    // doesn't route through process.stdout.write in a way that
    // vi.spyOn(process.stdout, 'write') captures.
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    try { rmSync(tmpCorpRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockClear();
  });

  function consoleLogCalls(): string {
    return logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  }

  function consoleErrorCalls(): string {
    return errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  }

  it('exits 1 with usage error when --review-id is missing', async () => {
    writeMembers(tmpCorpRoot, [
      { id: 'mark', displayName: 'Mark', rank: 'owner', agentDir: 'agents/mark/' },
    ]);
    await expect(cmdReviewDecide([])).rejects.toThrow(/process\.exit\(1\)/);
    expect(consoleErrorCalls()).toMatch(/--review-id.*required/);
  });

  it('exits 1 when --review-id is not a valid chit id format', async () => {
    writeMembers(tmpCorpRoot, [
      { id: 'mark', displayName: 'Mark', rank: 'owner', agentDir: 'agents/mark/' },
    ]);
    await expect(
      cmdReviewDecide(['--review-id', 'not-a-chit-id']),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(consoleErrorCalls()).toMatch(/not a valid chit id format/);
  });

  it('exits 1 when --founder is omitted AND no rank=owner member exists', async () => {
    writeMembers(tmpCorpRoot, [
      // Only a non-owner member.
      { id: 'coder', displayName: 'Coder', rank: 'worker', agentDir: 'agents/coder/' },
    ]);
    const { reviewId } = setupAcceptCase();
    await expect(
      cmdReviewDecide(['--review-id', reviewId]),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(consoleErrorCalls()).toMatch(/--founder.*required/);
  });

  it('applies the verdict + prints human summary on the happy path (accept)', async () => {
    writeMembers(tmpCorpRoot, [
      { id: 'mark', displayName: 'Mark', rank: 'owner', agentDir: 'agents/mark/' },
      { id: 'coder', displayName: 'Coder', rank: 'worker', agentDir: 'agents/coder/' },
    ]);
    const { reviewId, taskId } = setupAcceptCase();

    await cmdReviewDecide(['--review-id', reviewId]);

    const out = consoleLogCalls();
    expect(out).toContain(`applied verdict on review ${reviewId}`);
    expect(out).toContain(`task ${taskId}`);
    expect(out).toContain('input verdict:    accept');
    expect(out).toContain('outcome verdict:  accept');
    expect(out).toContain('task transition:  (none)');
    expect(out).toContain('inbox-item:       (none)');
  });

  it('prints JSON result when --json is set', async () => {
    writeMembers(tmpCorpRoot, [
      { id: 'mark', displayName: 'Mark', rank: 'owner', agentDir: 'agents/mark/' },
    ]);
    const { reviewId, taskId } = setupAcceptCase();

    await cmdReviewDecide(['--review-id', reviewId, '--json']);
    const out = consoleLogCalls();
    const parsed = JSON.parse(out);
    expect(parsed.applied).toBe(true);
    expect(parsed.outcomeVerdict).toBe('accept');
    expect(parsed.taskId).toBe(taskId);
  });

  it('exits 2 with structured errors when applyReviewVerdict refuses', async () => {
    writeMembers(tmpCorpRoot, [
      { id: 'mark', displayName: 'Mark', rank: 'owner', agentDir: 'agents/mark/' },
    ]);
    // Use a syntactically-valid chit id that doesn't resolve to a chit.
    // (chit ids: chit-<typePrefix>-<8 hex chars>)
    await expect(
      cmdReviewDecide(['--review-id', 'chit-rev-deadbeef']),
    ).rejects.toThrow(/process\.exit\(2\)/);
    expect(consoleErrorCalls()).toMatch(/refused to apply verdict/);
    expect(consoleErrorCalls()).toMatch(/review chit not found/);
  });

  it('exits 2 in --json mode when applyReviewVerdict refuses (Codex P2)', async () => {
    // Hook/automation callers check exit code, not body. Before the
    // fix, --json + refused-apply printed `{ "applied": false }` and
    // exited 0, so consumers had to parse the body to detect failure.
    writeMembers(tmpCorpRoot, [
      { id: 'mark', displayName: 'Mark', rank: 'owner', agentDir: 'agents/mark/' },
    ]);
    await expect(
      cmdReviewDecide(['--review-id', 'chit-rev-deadbeef', '--json']),
    ).rejects.toThrow(/process\.exit\(2\)/);
    // JSON body still gets emitted so consumers can read the error
    // list — the change is the exit code, not the silent surface.
    const out = consoleLogCalls();
    const parsed = JSON.parse(out);
    expect(parsed.applied).toBe(false);
    expect(parsed.errors.join(' ')).toMatch(/review chit not found/);
  });

  it('honors an explicit --founder override (skips the registry lookup)', async () => {
    // No rank=owner registered — registry fallback would fail, but
    // --founder bypasses the fallback.
    writeMembers(tmpCorpRoot, [
      { id: 'coder', displayName: 'Coder', rank: 'worker', agentDir: 'agents/coder/' },
    ]);
    const { reviewId } = setupAcceptCase();

    await cmdReviewDecide(['--review-id', reviewId, '--founder', 'coder']);
    expect(consoleLogCalls()).toContain('applied verdict on review');
  });
});
