import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChit } from '../packages/shared/src/chits.js';

/**
 * Integration tests for `cc-cli wtf` — the 0.7.1 C3b I/O layer.
 * Reads tmpdir corp fixture; verifies CORP.md written + system-reminder
 * block emitted with correct shape.
 *
 * Follows the cli-refresh.test.ts pattern: mock getCorpRoot to point at
 * tmpdir; mock process.exit to throw so error paths are catchable; spy
 * on process.stdout/stderr writes to collect output.
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

const { cmdWtf, formatAge, inferKind } = await import('../packages/cli/src/commands/wtf.js');

interface FixtureMember {
  id: string;
  displayName: string;
  rank: string;
  agentDir: string;
  harness?: string;
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
    agentDir: m.agentDir,
  }));
  writeFileSync(join(corpRoot, 'members.json'), JSON.stringify(full), 'utf-8');
}

function createAgentWorkspace(corpRoot: string, slug: string): string {
  const dir = join(corpRoot, 'agents', slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('cmdWtf', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpCorpRoot = join(tmpdir(), `wtf-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpCorpRoot, { recursive: true });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    try { rmSync(tmpCorpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockClear();
  });

  function stdoutText(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  function stderrText(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  describe('argument errors', () => {
    it('exits 1 with usage text when --agent is missing', async () => {
      writeMembers(tmpCorpRoot, []);
      await expect(cmdWtf({ hook: false, json: false })).rejects.toThrow(/process\.exit\(1\)/);
      expect(stderrText()).toMatch(/Usage: cc-cli wtf --agent/);
    });
  });

  describe('member resolution errors', () => {
    it('emits system-reminder + exits 1 when member not found', async () => {
      writeMembers(tmpCorpRoot, []);
      await expect(cmdWtf({ agent: 'ghost', hook: false, json: false })).rejects.toThrow(/process\.exit\(1\)/);
      const out = stdoutText();
      expect(out).toMatch(/<system-reminder>/);
      expect(out).toMatch(/no member with id "ghost"/);
    });

    it('lists available members when some exist but slug missed', async () => {
      const dir = createAgentWorkspace(tmpCorpRoot, 'ceo');
      writeMembers(tmpCorpRoot, [{ id: 'ceo', displayName: 'CEO', rank: 'master', agentDir: dir }]);
      await expect(cmdWtf({ agent: 'typo', hook: false, json: false })).rejects.toThrow(/process\.exit\(1\)/);
      expect(stdoutText()).toMatch(/Available members:[\s\S]*ceo/);
    });
  });

  describe('Partner with minimal state (no casket, no inbox)', () => {
    beforeEach(() => {
      const dir = createAgentWorkspace(tmpCorpRoot, 'ceo');
      writeMembers(tmpCorpRoot, [{ id: 'ceo', displayName: 'CEO', rank: 'master', agentDir: dir }]);
    });

    it('emits a system-reminder block wrapping the header + CORP.md', async () => {
      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      const out = stdoutText();
      expect(out.startsWith('<system-reminder>')).toBe(true);
      expect(out.endsWith('</system-reminder>\n')).toBe(true);
    });

    it('header identifies the agent as Partner with their rank', async () => {
      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      const out = stdoutText();
      expect(out).toMatch(/You are CEO, master \(partner\)\./);
    });

    it('shows "Current task: none." when Casket is absent', async () => {
      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      expect(stdoutText()).toMatch(/Current task: none\./);
    });

    it('shows "Inbox: empty." when no inbox-items exist', async () => {
      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      expect(stdoutText()).toMatch(/Inbox: empty\./);
    });

    it('includes the Partner-specific kind section in CORP.md', async () => {
      // Post-PR #200: wtf stdout carries only the situational header;
      // the CORP.md manual body (with kind-section + ops content) is
      // written to disk via atomicWriteSync, picked up by the agent
      // through CLAUDE.md's @./CORP.md import. Assert against the
      // file, not the stdout stream.
      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      const corpMd = readFileSync(join(tmpCorpRoot, 'agents', 'ceo', 'CORP.md'), 'utf-8');
      expect(corpMd).toContain('## You are a Partner');
      expect(corpMd).not.toContain('## You are an Employee');
    });

    it('writes CORP.md to the agent workspace', async () => {
      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      const corpMdPath = join(tmpCorpRoot, 'agents', 'ceo', 'CORP.md');
      expect(existsSync(corpMdPath)).toBe(true);
      const contents = readFileSync(corpMdPath, 'utf-8');
      expect(contents).toContain('# '); // heading
      expect(contents).toContain('## The Two Non-Negotiables');
    });
  });

  describe('Employee shape', () => {
    beforeEach(() => {
      const dir = createAgentWorkspace(tmpCorpRoot, 'toast');
      writeMembers(tmpCorpRoot, [
        { id: 'toast', displayName: 'Toast', rank: 'worker', agentDir: dir },
      ]);
    });

    it('identifies as Employee (from worker rank inference)', async () => {
      // Header line (in stdout) AND CORP.md kind-section (on disk) —
      // see Partner test above for the post-#200 split rationale.
      await cmdWtf({ agent: 'toast', hook: false, json: false });
      const out = stdoutText();
      expect(out).toMatch(/You are Toast, worker \(employee\)\./);
      const corpMd = readFileSync(join(tmpCorpRoot, 'agents', 'toast', 'CORP.md'), 'utf-8');
      expect(corpMd).toContain('## You are an Employee');
      expect(corpMd).not.toContain('## You are a Partner');
    });

    it('renders handoff block from the agent\'s active handoff chit (Project 1.6)', async () => {
      // Post-1.6: wtf reads from the `handoff` chit, not WORKLOG.md
      // XML. Test fixture creates an active handoff chit directly;
      // wtf consumes it + renders the block via handoffChitToXml.
      createChit(tmpCorpRoot, {
        type: 'handoff',
        scope: 'agent:toast' as const,
        fields: {
          handoff: {
            predecessorSession: 'toast-17',
            currentStep: 'chit-t-abcdef12',
            completed: ['implemented the parser'],
            nextAction: 'continue implementation',
            openQuestion: null,
            sandboxState: null,
            notes: null,
          },
        } as never,
        createdBy: 'toast',
      });

      await cmdWtf({ agent: 'toast', hook: false, peek: true, json: false });
      const out = stdoutText();
      expect(out).toContain('Handoff from predecessor session');
      expect(out).toContain('<current-step>chit-t-abcdef12</current-step>');
      expect(out).toContain('<next-action>continue implementation</next-action>');
    });

    it('gracefully skips handoff when no active handoff chit exists (fresh slot)', async () => {
      await cmdWtf({ agent: 'toast', hook: false, peek: true, json: false });
      expect(stdoutText()).not.toMatch(/Handoff from predecessor/);
    });
  });

  describe('current task resolution via Casket', () => {
    beforeEach(() => {
      const dir = createAgentWorkspace(tmpCorpRoot, 'ceo');
      writeMembers(tmpCorpRoot, [{ id: 'ceo', displayName: 'CEO', rank: 'master', agentDir: dir }]);
    });

    it('renders current task title when Casket points at a task', async () => {
      // Create the task the Casket will point at
      const task = createChit(tmpCorpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'mark',
        fields: { task: { title: 'Ship 0.7.1 wtf command', priority: 'high' } },
      });

      // Create the Casket with current_step pointing at the task
      createChit(tmpCorpRoot, {
        type: 'casket',
        scope: 'agent:ceo',
        id: 'chit-cask-ceo',
        createdBy: 'ceo',
        fields: { casket: { currentStep: task.id } },
      });

      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      const out = stdoutText();
      expect(out).toContain(`Current task: ${task.id} — Ship 0.7.1 wtf command`);
    });

    it('falls back to "none" when Casket has null current_step', async () => {
      createChit(tmpCorpRoot, {
        type: 'casket',
        scope: 'agent:ceo',
        id: 'chit-cask-ceo',
        createdBy: 'ceo',
        fields: { casket: { currentStep: null } },
      });

      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      expect(stdoutText()).toMatch(/Current task: none\./);
    });

    it('falls back to "none" when Casket points at a task chit that no longer exists', async () => {
      // Casket references a task id that was never created (simulates
      // task closed + archived, or hand aborted mid-flight).
      createChit(tmpCorpRoot, {
        type: 'casket',
        scope: 'agent:ceo',
        id: 'chit-cask-ceo',
        createdBy: 'ceo',
        fields: { casket: { currentStep: 'chit-t-deadbeef' } },
      });

      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      // No thrown exception, degraded to "none" — the agent should still
      // get a usable system-reminder, not a crashed hook.
      const out = stdoutText();
      expect(out).toMatch(/Current task: none\./);
      expect(out.startsWith('<system-reminder>')).toBe(true);
    });
  });

  describe('failure-mode fallbacks (spec-mandated)', () => {
    // The spec's cc-cli wtf failure section mandates three fallbacks:
    //   (1) Daemon not required — covered implicitly (none of the tests
    //       run a daemon; all still pass).
    //   (2) Missing member record → visible error + exit 1 — tested above.
    //   (3) Corrupted state → degraded mode + exit 0 so session-start
    //       hooks don't fail catastrophically — tested here.

    it('emits system-reminder + exits 0 when Casket chit file is corrupted', async () => {
      const dir = createAgentWorkspace(tmpCorpRoot, 'ceo');
      writeMembers(tmpCorpRoot, [{ id: 'ceo', displayName: 'CEO', rank: 'master', agentDir: dir }]);

      // Write a malformed chit file at the expected Casket path. The
      // chit-file layout is <corpRoot>/agents/<slug>/chits/casket/<id>.md
      const casketDir = join(tmpCorpRoot, 'agents', 'ceo', 'chits', 'casket');
      mkdirSync(casketDir, { recursive: true });
      writeFileSync(
        join(casketDir, 'chit-cask-ceo.md'),
        '---\nthis is not valid yaml :::\nfields:\n  casket:\n    missing_quote: "unterminated\n---\n',
        'utf-8',
      );

      // The command should NOT throw (no process.exit(1) branch) — it
      // degrades gracefully and emits a usable system-reminder.
      await cmdWtf({ agent: 'ceo', hook: false, json: false });

      const out = stdoutText();
      expect(out.startsWith('<system-reminder>')).toBe(true);
      expect(out).toContain('You are CEO');
      // With the Casket unreadable, current task falls back to "none"
      expect(out).toMatch(/Current task: none\./);
    });

    it('works without a running daemon (reads local filesystem + chit store only)', async () => {
      // The getCorpRoot mock doesn't touch any daemon. This test
      // pins the invariant explicitly: wtf MUST work in a daemon-down
      // scenario, since disorientation can include "why is the daemon
      // not up?"
      const dir = createAgentWorkspace(tmpCorpRoot, 'ceo');
      writeMembers(tmpCorpRoot, [{ id: 'ceo', displayName: 'CEO', rank: 'master', agentDir: dir }]);

      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      // If wtf had tried to contact a daemon, it would have failed or
      // hung. Passing means the no-daemon path is clean. Post-#200
      // the stdout header is intentionally compact (~400 chars); the
      // full manual lives in CORP.md on disk. Assert on the
      // structural markers that prove the no-daemon path produced a
      // real situational header, not a stub.
      const out = stdoutText();
      expect(out).toMatch(/^<system-reminder>/);
      expect(out).toContain('You are CEO');
      expect(out).toMatch(/Sandbox: /);
      expect(out).toContain('CORP.md at:');
      expect(existsSync(join(tmpCorpRoot, 'agents', 'ceo', 'CORP.md'))).toBe(true);
    });
  });

  describe('inbox summary with tier-mixed chits', () => {
    beforeEach(() => {
      const dir = createAgentWorkspace(tmpCorpRoot, 'ceo');
      writeMembers(tmpCorpRoot, [{ id: 'ceo', displayName: 'CEO', rank: 'master', agentDir: dir }]);
    });

    it('counts + peeks tier 3 + tier 2, summarizes tier 1 as ambient', async () => {
      createChit(tmpCorpRoot, {
        type: 'inbox-item',
        scope: 'agent:ceo',
        createdBy: 'router',
        fields: {
          'inbox-item': { tier: 3, from: 'mark', subject: 'corp status?', source: 'dm' },
        },
      });
      createChit(tmpCorpRoot, {
        type: 'inbox-item',
        scope: 'agent:ceo',
        createdBy: 'router',
        fields: {
          'inbox-item': { tier: 2, from: 'herald', subject: 'digest ready', source: 'channel', sourceRef: 'general' },
        },
      });
      createChit(tmpCorpRoot, {
        type: 'inbox-item',
        scope: 'agent:ceo',
        createdBy: 'failsafe',
        fields: {
          'inbox-item': { tier: 1, from: 'failsafe', subject: 'restarted researcher', source: 'system' },
        },
      });

      await cmdWtf({ agent: 'ceo', hook: false, json: false });
      const out = stdoutText();

      expect(out).toMatch(/Inbox: 2 unresolved \(\+1 ambient auto-expiring\)\./);
      expect(out).toMatch(/\[T3\] 1 critical/);
      expect(out).toMatch(/\[T2\] 1 direct/);
      expect(out).toContain('mark — "corp status?"');
      expect(out).toContain('herald — "digest ready"');
      // Tier 1 items don't get peeked individually
      expect(out).not.toContain('restarted researcher');
    });
  });

  describe('--json output mode', () => {
    it('emits structured JSON instead of system-reminder', async () => {
      const dir = createAgentWorkspace(tmpCorpRoot, 'ceo');
      writeMembers(tmpCorpRoot, [{ id: 'ceo', displayName: 'CEO', rank: 'master', agentDir: dir }]);
      await cmdWtf({ agent: 'ceo', hook: false, json: true });
      const out = stdoutText();
      // Should not be wrapped in system-reminder when --json
      expect(out.startsWith('<system-reminder>')).toBe(false);
      const parsed = JSON.parse(out);
      expect(parsed).toHaveProperty('header');
      expect(parsed).toHaveProperty('corpMd');
      expect(parsed).toHaveProperty('corpMdPath');
      expect(parsed.corpMdPath.endsWith('CORP.md')).toBe(true);
    });
  });
});

describe('inferKind', () => {
  it('returns partner for master/owner/leader', () => {
    expect(inferKind('master')).toBe('partner');
    expect(inferKind('owner')).toBe('partner');
    expect(inferKind('leader')).toBe('partner');
  });

  it('returns employee for worker/subagent', () => {
    expect(inferKind('worker')).toBe('employee');
    expect(inferKind('subagent')).toBe('employee');
  });

  it('treats unknown ranks as partner (safer default — keeps soul-file paths)', () => {
    expect(inferKind('something-new')).toBe('partner');
  });
});

describe('formatAge', () => {
  const now = new Date('2026-04-22T12:00:00.000Z');

  it('returns "just now" for <=1s', () => {
    expect(formatAge('2026-04-22T11:59:59.500Z', now)).toBe('just now');
    expect(formatAge('2026-04-22T12:00:00.000Z', now)).toBe('just now');
  });

  it('returns seconds for <60s', () => {
    expect(formatAge('2026-04-22T11:59:30.000Z', now)).toBe('30s ago');
  });

  it('returns minutes for <60m', () => {
    expect(formatAge('2026-04-22T11:40:00.000Z', now)).toBe('20m ago');
  });

  it('returns hours for <24h', () => {
    expect(formatAge('2026-04-22T09:00:00.000Z', now)).toBe('3h ago');
  });

  it('returns days for >=24h', () => {
    expect(formatAge('2026-04-20T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('returns "just now" for future timestamps (clock skew fallback)', () => {
    expect(formatAge('2026-04-22T12:00:05.000Z', now)).toBe('just now');
  });

  it('returns "unknown age" for malformed timestamps', () => {
    expect(formatAge('not-a-date', now)).toBe('unknown age');
  });
});
