import { describe, it, expect } from 'vitest';
import { runAudit } from '../packages/shared/src/audit/engine.js';
import type {
  AuditInput,
  RecentActivity,
} from '../packages/shared/src/audit/types.js';
import type { Chit } from '../packages/shared/src/types/chit.js';

/**
 * Decision-tree coverage for the 0.7.3 audit engine. One test per
 * branch — the tree is short enough that exhaustive branch coverage
 * is tractable, and drift in ordering (e.g. accidentally putting the
 * evidence gate before the anti-loop check) would be a silent and
 * nasty regression.
 *
 * Engine is pure. Tests use canned AuditInput values; no I/O.
 */

function emptyActivity(): RecentActivity {
  return { toolCalls: [], touchedFiles: [], assistantText: [] };
}

function taskChit(overrides: Partial<Chit<'task'>> = {}): Chit<'task'> {
  return {
    id: 'chit-t-abc12345',
    type: 'task',
    status: 'active',
    ephemeral: false,
    createdBy: 'founder',
    createdAt: '2026-04-22T10:00:00Z',
    updatedAt: '2026-04-22T10:00:00Z',
    references: [],
    dependsOn: [],
    tags: [],
    fields: {
      task: {
        title: 'Ship the audit gate',
        priority: 'high',
        assignee: 'ceo',
        acceptanceCriteria: null,
      },
    },
    ...overrides,
  } as Chit<'task'>;
}

function tier3Inbox(id: string, from = 'mark', subject = 'check this'): Chit<'inbox-item'> {
  return {
    id,
    type: 'inbox-item',
    status: 'active',
    ephemeral: true,
    createdBy: 'system',
    createdAt: '2026-04-22T10:00:00Z',
    updatedAt: '2026-04-22T10:00:00Z',
    references: [],
    dependsOn: [],
    tags: [],
    fields: {
      'inbox-item': {
        tier: 3,
        from,
        subject,
        source: 'dm',
      },
    },
  } as Chit<'inbox-item'>;
}

function baseInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    stopHookActive: false,
    currentTask: null,
    openTier3Inbox: [],
    recent: emptyActivity(),
    event: 'Stop',
    kind: 'employee',
    agentDisplayName: 'Toast',
    ...overrides,
  };
}

describe('runAudit — decision tree', () => {
  it('(1) stopHookActive=true short-circuits to approve regardless of task state', () => {
    // Compose an input that would otherwise block hard (tier-3 inbox
    // present) to prove the anti-loop flag takes precedence.
    const decision = runAudit(
      baseInput({
        stopHookActive: true,
        currentTask: taskChit(),
        openTier3Inbox: [tier3Inbox('chit-i-loop')],
      }),
    );
    expect(decision).toEqual({ decision: 'approve' });
  });

  it('(2) currentTask=undefined (substrate gap) → approve fail-open', () => {
    const decision = runAudit(baseInput({ currentTask: undefined }));
    expect(decision).toEqual({ decision: 'approve' });
  });

  it('(3) currentTask=null + no inbox → approve (idle, nothing to gate)', () => {
    const decision = runAudit(baseInput({ currentTask: null }));
    expect(decision).toEqual({ decision: 'approve' });
  });

  it('(4) openTier3Inbox.length > 0 → block (hard gate, even on idle agent)', () => {
    const decision = runAudit(
      baseInput({
        currentTask: null,
        openTier3Inbox: [
          tier3Inbox('chit-i-founder-dm', 'mark', 'please review'),
        ],
      }),
    );
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Unresolved Tier 3 inbox items');
    expect(decision.reason).toContain('chit-i-founder-dm');
    expect(decision.reason).toContain('mark');
  });

  it('(5a) task with missing evidence (no build/tests/git-status) → block', () => {
    const decision = runAudit(
      baseInput({
        currentTask: taskChit({
          fields: {
            task: {
              title: 'Ship feature',
              priority: 'high',
              assignee: 'toast',
              acceptanceCriteria: ['builds clean', 'tests pass'],
            },
          },
        }),
        recent: emptyActivity(),
      }),
    );
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/run `pnpm build`/);
    expect(decision.reason).toMatch(/run the relevant vitest tests/);
  });

  it('(5b) task with unverified specific criterion → block, criterion surfaced', () => {
    const decision = runAudit(
      baseInput({
        currentTask: taskChit({
          fields: {
            task: {
              title: 'Write foo',
              priority: 'normal',
              assignee: 'toast',
              acceptanceCriteria: ['tests pass'],
            },
          },
        }),
        recent: {
          // build + git-status ran, but tests did NOT → criterion unverified
          toolCalls: [
            { name: 'Bash', input: { command: 'pnpm build' } },
            { name: 'Bash', input: { command: 'git status' } },
          ],
          touchedFiles: [],
          assistantText: [],
        },
      }),
    );
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('tests pass');
    expect(decision.reason).toContain('[ ] tests pass');
  });

  it('(6) all universal gates satisfied + no inbox + no criteria → approve', () => {
    const decision = runAudit(
      baseInput({
        currentTask: taskChit({
          fields: {
            task: {
              title: 'Small fix',
              priority: 'low',
              assignee: 'toast',
              acceptanceCriteria: null,
            },
          },
        }),
        recent: {
          toolCalls: [
            { name: 'Bash', input: { command: 'pnpm build' } },
            { name: 'Bash', input: { command: 'pnpm test' } },
            { name: 'Bash', input: { command: 'git status' } },
          ],
          touchedFiles: [],
          assistantText: [],
        },
      }),
    );
    expect(decision).toEqual({ decision: 'approve' });
  });
});

describe('runAudit — prompt kind/event branches', () => {
  it('PreCompact + Partner says "compact your context" and suggests /compact', () => {
    const decision = runAudit(
      baseInput({
        event: 'PreCompact',
        kind: 'partner',
        openTier3Inbox: [tier3Inbox('chit-i-x')],
      }),
    );
    expect(decision.reason).toContain('compact your context');
    expect(decision.reason).toContain('try `/compact` again');
  });

  it('Stop + Employee says "hand off this session" and suggests cc-cli done', () => {
    const decision = runAudit(
      baseInput({
        event: 'Stop',
        kind: 'employee',
        openTier3Inbox: [tier3Inbox('chit-i-x')],
      }),
    );
    expect(decision.reason).toContain('hand off this session');
    expect(decision.reason).toContain('run `cc-cli done` again');
  });

  it('Stop + Partner says "end this session" (not hand-off)', () => {
    const decision = runAudit(
      baseInput({
        event: 'Stop',
        kind: 'partner',
        openTier3Inbox: [tier3Inbox('chit-i-x')],
      }),
    );
    expect(decision.reason).toContain('end this session');
    expect(decision.reason).not.toContain('hand off');
  });
});
