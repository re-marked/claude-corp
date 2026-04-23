import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  peekLatestHandoffChit,
  consumeHandoffChit,
  createChit,
  findChitById,
  queryChits,
  buildWtfOutput,
  atomicWriteSync,
  promotePendingHandoff,
} from '../packages/shared/src/index.js';

/**
 * End-to-end coverage for Project 1.6's handoff-chit round-trip:
 * peek / consume primitives, wtf integration, and the full done →
 * audit-approve → wtf-consume flow. Integration-style with real
 * tmpdir corpora; no mocks.
 */

describe('peekLatestHandoffChit + consumeHandoffChit', () => {
  let corpRoot: string;
  const AGENT = 'toast';

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'handoff-flow-test-'));
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
  });
  afterEach(() => rmSync(corpRoot, { recursive: true, force: true }));

  function createActiveHandoff(overrides: Record<string, unknown> = {}) {
    return createChit(corpRoot, {
      type: 'handoff',
      scope: `agent:${AGENT}` as const,
      fields: {
        handoff: {
          predecessorSession: 'toast-17',
          currentStep: 'chit-t-abc12345',
          completed: ['did stuff'],
          nextAction: 'do more stuff',
          openQuestion: null,
          sandboxState: null,
          notes: null,
          ...overrides,
        },
      } as never,
      createdBy: AGENT,
    });
  }

  it('peek returns null when no active handoff exists', () => {
    expect(peekLatestHandoffChit(corpRoot, AGENT)).toBeNull();
  });

  it('peek returns the chit + does not mutate it', () => {
    const created = createActiveHandoff();
    const peeked = peekLatestHandoffChit(corpRoot, AGENT);
    expect(peeked?.id).toBe(created.id);
    expect(peeked?.status).toBe('active');

    // Still active after peek — can peek again + get same chit.
    const reread = findChitById(corpRoot, created.id);
    expect(reread?.chit.status).toBe('active');
  });

  it('peek returns the latest when multiple actives exist (createdAt desc)', async () => {
    const first = createActiveHandoff({ predecessorSession: 'first' });
    // Brief wait so the second's createdAt is strictly later.
    await new Promise((r) => setTimeout(r, 5));
    const second = createActiveHandoff({ predecessorSession: 'second' });
    void first;

    const peeked = peekLatestHandoffChit(corpRoot, AGENT);
    expect(peeked?.id).toBe(second.id);
  });

  it('consume returns the chit AND flips its status to closed', () => {
    const created = createActiveHandoff();
    const consumed = consumeHandoffChit(corpRoot, AGENT, AGENT);
    expect(consumed?.id).toBe(created.id);

    // Post-consume: status closed.
    const reread = findChitById(corpRoot, created.id);
    expect(reread?.chit.status).toBe('closed');
  });

  it('consume returns null when no active handoff exists', () => {
    expect(consumeHandoffChit(corpRoot, AGENT, AGENT)).toBeNull();
  });

  it('consume is idempotent — second call on the same agent returns null after first closed', () => {
    createActiveHandoff();
    const first = consumeHandoffChit(corpRoot, AGENT, AGENT);
    expect(first).not.toBeNull();

    // Second call finds no active handoff — already consumed.
    const second = consumeHandoffChit(corpRoot, AGENT, AGENT);
    expect(second).toBeNull();
  });

  it('peek skips closed handoffs (status filter on active only)', () => {
    const created = createActiveHandoff();
    consumeHandoffChit(corpRoot, AGENT, AGENT);
    // Chit still exists at status=closed, but peek only returns active.
    const peeked = peekLatestHandoffChit(corpRoot, AGENT);
    expect(peeked).toBeNull();
    // Sanity — the chit is still on disk, just closed.
    const reread = findChitById(corpRoot, created.id);
    expect(reread?.chit.status).toBe('closed');
  });
});

describe('buildWtfOutput — handoff chit integration', () => {
  let corpRoot: string;
  let workspace: string;
  const AGENT = 'toast';

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'wtf-handoff-test-'));
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
    workspace = join(corpRoot, 'agents', AGENT);
    mkdirSync(workspace, { recursive: true });
  });
  afterEach(() => rmSync(corpRoot, { recursive: true, force: true }));

  function createActiveHandoff() {
    return createChit(corpRoot, {
      type: 'handoff',
      scope: `agent:${AGENT}` as const,
      fields: {
        handoff: {
          predecessorSession: 'toast-17',
          currentStep: 'chit-t-abc12345',
          completed: ['shipped tests'],
          nextAction: 'merge the PR',
          openQuestion: 'should we bump the tier?',
          sandboxState: null,
          notes: null,
        },
      } as never,
      createdBy: AGENT,
    });
  }

  function runWtf(opts: { consumeHandoff: boolean; kind?: 'employee' | 'partner' }) {
    return buildWtfOutput({
      corpRoot,
      corpName: 'test-corp',
      agentSlug: AGENT,
      displayName: 'Toast',
      rank: 'worker',
      workspacePath: workspace,
      generatedAt: '2026-04-23T14:00:00.000Z',
      now: new Date('2026-04-23T14:00:00.000Z'),
      kind: opts.kind ?? 'employee',
      consumeHandoff: opts.consumeHandoff,
    });
  }

  it('Employee with active handoff + consumeHandoff=true → header carries handoff block, chit closed', () => {
    const chit = createActiveHandoff();
    const { header } = runWtf({ consumeHandoff: true });

    expect(header).toContain('Handoff from predecessor session');
    expect(header).toContain('<predecessor-session>toast-17</predecessor-session>');
    expect(header).toContain('<next-action>merge the PR</next-action>');

    // Chit is now closed.
    const reread = findChitById(corpRoot, chit.id);
    expect(reread?.chit.status).toBe('closed');
  });

  it('Employee with active handoff + consumeHandoff=false → header carries handoff, chit stays active', () => {
    const chit = createActiveHandoff();
    const { header } = runWtf({ consumeHandoff: false });
    expect(header).toContain('Handoff from predecessor session');

    const reread = findChitById(corpRoot, chit.id);
    expect(reread?.chit.status).toBe('active');
  });

  it('Employee with no active handoff → header has no handoff block', () => {
    const { header } = runWtf({ consumeHandoff: true });
    expect(header).not.toContain('Handoff from predecessor session');
  });

  it('Partner (kind=partner) never gets handoff block regardless of chit existence', () => {
    createActiveHandoff();
    const { header } = runWtf({ consumeHandoff: true, kind: 'partner' });
    // wtf-header's kind === 'employee' gate blocks the block entirely.
    expect(header).not.toContain('Handoff from predecessor session');
  });

  it('Two consecutive wtf calls with consume=true: first has handoff, second has none', () => {
    createActiveHandoff();
    const first = runWtf({ consumeHandoff: true });
    expect(first.header).toContain('Handoff from predecessor session');

    const second = runWtf({ consumeHandoff: true });
    expect(second.header).not.toContain('Handoff from predecessor session');
  });
});

describe('end-to-end: done → audit-approve → wtf-consume', () => {
  let corpRoot: string;
  let workspace: string;
  const AGENT = 'toast';

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'e2e-handoff-test-'));
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
    workspace = join(corpRoot, 'agents', AGENT);
    mkdirSync(workspace, { recursive: true });
  });
  afterEach(() => rmSync(corpRoot, { recursive: true, force: true }));

  it('full round-trip: audit-approve writes chit, next wtf consumes + renders, subsequent wtf no-op', () => {
    // Simulate cc-cli done: write a pending-handoff payload.
    atomicWriteSync(
      join(workspace, '.pending-handoff.json'),
      JSON.stringify({
        predecessorSession: 'toast-42',
        completed: ['migrated the chits'],
        nextAction: 'review Mark feedback',
        openQuestion: null,
        sandboxState: null,
        notes: null,
        createdAt: '2026-04-23T13:00:00.000Z',
        createdBy: AGENT,
      }),
    );

    // audit-approve promotes: creates handoff chit + does NOT write WORKLOG.md.
    const promotion = promotePendingHandoff(corpRoot, AGENT, workspace);
    expect(promotion.promoted).toBe(true);
    expect(promotion.handoffChitId).toBeDefined();
    expect(promotion.worklogPath).toBeNull(); // 1.6: no WORKLOG write
    // Verify WORKLOG.md really wasn't created by the audit path.
    expect(existsSync(join(workspace, 'WORKLOG.md'))).toBe(false);

    // Verify handoff chit is active post-promotion.
    const chit = findChitById(corpRoot, promotion.handoffChitId!);
    expect(chit?.chit.status).toBe('active');

    // Next session: cc-cli wtf default-consumes the handoff.
    const wtf1 = buildWtfOutput({
      corpRoot,
      corpName: 'test-corp',
      agentSlug: AGENT,
      displayName: 'Toast',
      rank: 'worker',
      workspacePath: workspace,
      generatedAt: '2026-04-23T14:00:00.000Z',
      now: new Date('2026-04-23T14:00:00.000Z'),
      kind: 'employee',
      consumeHandoff: true,
    });
    expect(wtf1.header).toContain('Handoff from predecessor session');
    expect(wtf1.header).toContain('toast-42');

    // Chit closed.
    const rereadAfterConsume = findChitById(corpRoot, promotion.handoffChitId!);
    expect(rereadAfterConsume?.chit.status).toBe('closed');

    // Mid-session wtf: no handoff block (already consumed).
    const wtf2 = buildWtfOutput({
      corpRoot,
      corpName: 'test-corp',
      agentSlug: AGENT,
      displayName: 'Toast',
      rank: 'worker',
      workspacePath: workspace,
      generatedAt: '2026-04-23T14:30:00.000Z',
      now: new Date('2026-04-23T14:30:00.000Z'),
      kind: 'employee',
      consumeHandoff: true,
    });
    expect(wtf2.header).not.toContain('Handoff from predecessor session');
  });

  it('WORKLOG.md written by the AGENT is NOT clobbered by audit-approve', () => {
    // Pre-1.6 audit-approve full-overwrote WORKLOG.md. Verify the
    // 1.6 change preserves agent-written content.
    const worklogPath = join(workspace, 'WORKLOG.md');
    writeFileSync(worklogPath, '# My work log\n\n- Started task ABC\n- Hit problem X\n', 'utf-8');

    atomicWriteSync(
      join(workspace, '.pending-handoff.json'),
      JSON.stringify({
        predecessorSession: 'toast-1',
        completed: ['did thing'],
        nextAction: 'do next thing',
        openQuestion: null,
        sandboxState: null,
        notes: null,
        createdAt: '2026-04-23T13:00:00.000Z',
        createdBy: AGENT,
      }),
    );

    promotePendingHandoff(corpRoot, AGENT, workspace);

    const preservedContent = readFileSync(worklogPath, 'utf-8');
    expect(preservedContent).toContain('# My work log');
    expect(preservedContent).toContain('Started task ABC');
    expect(preservedContent).toContain('Hit problem X');
    // Content NOT replaced by an <handoff> XML block.
    expect(preservedContent).not.toContain('<handoff>');
  });
});
