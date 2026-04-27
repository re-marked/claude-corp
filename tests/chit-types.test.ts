import { describe, it, expect } from 'vitest';
import {
  CHIT_TYPES,
  ChitValidationError,
  getChitType,
  isKnownChitType,
} from '../packages/shared/src/chit-types.js';
import type { ChitTypeId } from '../packages/shared/src/types/chit.js';

describe('getChitType', () => {
  it('returns the registry entry for a known type', () => {
    const entry = getChitType('task');
    expect(entry).toBeDefined();
    expect(entry?.id).toBe('task');
    expect(entry?.idPrefix).toBe('t');
  });

  it('returns undefined for unknown type id', () => {
    expect(getChitType('nonexistent-type')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getChitType('')).toBeUndefined();
  });
});

describe('isKnownChitType', () => {
  it('is true for every registered type', () => {
    for (const entry of CHIT_TYPES) {
      expect(isKnownChitType(entry.id)).toBe(true);
    }
  });

  it('is false for unknown strings', () => {
    expect(isKnownChitType('typo')).toBe(false);
    expect(isKnownChitType('')).toBe(false);
    expect(isKnownChitType('Task')).toBe(false); // case-sensitive
  });

  it('narrows the type when true (compile-time check)', () => {
    const candidate: string = 'task';
    if (isKnownChitType(candidate)) {
      // If the predicate narrows correctly, this assignment is valid.
      const narrowed: ChitTypeId = candidate;
      expect(narrowed).toBe('task');
    } else {
      expect.fail('isKnownChitType should have narrowed to ChitTypeId for "task"');
    }
  });
});

describe('CHIT_TYPES registry invariants', () => {
  const expectedTypeIds: readonly ChitTypeId[] = [
    'task',
    'contract',
    'observation',
    'casket',
    'handoff',
    'dispatch-context',
    'pre-brain-entry',
    'step-log',
    'inbox-item',
    // Project 1.4: Employee → Partner judgment request. Ephemeral
    // 7d TTL, destroy-if-not-promoted, active → completed|rejected|closed.
    'escalation',
    // Project 1.8: Blueprint-as-molecule. Non-ephemeral template chit
    // with origin=authored|builtin, steps DAG validated at write time,
    // draft → active → closed lifecycle. Cast produces Contract + Task
    // chits in 1.8 PR 2.
    'blueprint',
    // Project 1.9: sweeper-run records one dispatch of a sweeper
    // blueprint (kind=sweeper). Ephemeral 7d TTL, destroy-if-not-
    // promoted, active → closed|burning. Cast via
    // castSweeperFromBlueprint produces one of these per dispatch.
    'sweeper-run',
    // Project 1.9.5: kink — operational finding emitted by sweepers
    // (and future daemon-internal detectors). Distinct channel from
    // observations so soul material stays soul material. Ephemeral
    // 7d TTL, destroy-if-not-promoted; dedup per (source, subject).
    'kink',
    // Project 1.11: breaker-trip — crash-loop circuit breaker chit.
    // Non-ephemeral, corp-scope, active → closed lifecycle. Refuses
    // spawnAgent for the slug while active; founder resets via
    // `cc-cli breaker reset`.
    'breaker-trip',
    // Project 1.12: clearance-submission — one PR's journey through
    // the Clearinghouse phase (queue → Pressman → merge or conflict).
    // Non-ephemeral; chit.status follows the rich submissionStatus
    // field. Created by `cc-cli clear` after Editor approves or the
    // review-round cap forces bypass.
    'clearance-submission',
    // Project 1.12: review-comment — one Editor-authored Codex-shape
    // comment on a clearance-submission's diff. Non-ephemeral so
    // recurring patterns can compound into CULTURE.md material.
    // Severity 'blocker' rejects the round; 'suggestion'/'nit'
    // advisory only.
    'review-comment',
  ];

  it('contains exactly one entry per registered ChitTypeId', () => {
    const registryIds = CHIT_TYPES.map((e) => e.id).sort();
    const expectedSorted = [...expectedTypeIds].sort();
    expect(registryIds).toEqual(expectedSorted);
  });

  it('idPrefixes are all unique', () => {
    const prefixes = CHIT_TYPES.map((e) => e.idPrefix);
    const unique = new Set(prefixes);
    expect(unique.size).toBe(prefixes.length);
  });

  it('every entry has a non-empty validStatuses list', () => {
    for (const entry of CHIT_TYPES) {
      expect(entry.validStatuses.length).toBeGreaterThan(0);
    }
  });

  it('terminalStatuses is always a subset of validStatuses', () => {
    for (const entry of CHIT_TYPES) {
      for (const terminal of entry.terminalStatuses) {
        expect(entry.validStatuses).toContain(terminal);
      }
    }
  });

  it('ephemeral types have a defaultTTL; non-ephemeral types do not', () => {
    for (const entry of CHIT_TYPES) {
      if (entry.defaultEphemeral) {
        expect(entry.defaultTTL).not.toBeNull();
      } else {
        expect(entry.defaultTTL).toBeNull();
      }
    }
  });

  it('defaultStatus is always in validStatuses', () => {
    for (const entry of CHIT_TYPES) {
      expect(entry.validStatuses).toContain(entry.defaultStatus);
    }
  });

  it('every entry declares a destructionPolicy', () => {
    for (const entry of CHIT_TYPES) {
      expect(entry.destructionPolicy, `${entry.id} missing destructionPolicy`).toMatch(
        /^(destroy-if-not-promoted|keep-forever)$/,
      );
    }
  });

  it('destructionPolicy per type matches the 0.6 design: handoffs/dispatch-contexts/pre-brain-entries destroy; observations and non-ephemeral types keep-forever', () => {
    const byId = (id: string) => CHIT_TYPES.find((e) => e.id === id);

    // Destruction-eligible — semantically transient, accumulating = noise
    expect(byId('handoff')!.destructionPolicy).toBe('destroy-if-not-promoted');
    expect(byId('dispatch-context')!.destructionPolicy).toBe('destroy-if-not-promoted');
    expect(byId('pre-brain-entry')!.destructionPolicy).toBe('destroy-if-not-promoted');

    // Soul material — cold on TTL-age, never destroyed
    expect(byId('observation')!.destructionPolicy).toBe('keep-forever');

    // Non-ephemeral — scanner never visits, policy is a no-op but must be set
    expect(byId('task')!.destructionPolicy).toBe('keep-forever');
    expect(byId('contract')!.destructionPolicy).toBe('keep-forever');
    expect(byId('casket')!.destructionPolicy).toBe('keep-forever');
    expect(byId('step-log')!.destructionPolicy).toBe('keep-forever');
  });

  it('observations can reach `cold` status (via 0.6 scanner), but cold is NOT terminal', () => {
    const observation = CHIT_TYPES.find((e) => e.id === 'observation')!;
    expect(observation.validStatuses).toContain('cold');
    expect(observation.terminalStatuses).not.toContain('cold');
  });

  it('inbox-items can reach `cold` status (Tier 2/3 path), but cold is NOT terminal', () => {
    const inbox = CHIT_TYPES.find((e) => e.id === 'inbox-item')!;
    expect(inbox.validStatuses).toContain('cold');
    expect(inbox.terminalStatuses).not.toContain('cold');
  });

  it('cold status is restricted to keep-forever ephemeral types (observation + inbox-item)', () => {
    const coldTypes = CHIT_TYPES.filter((e) => e.validStatuses.includes('cold')).map((e) => e.id).sort();
    expect(coldTypes).toEqual(['inbox-item', 'observation']);
  });

  it('inbox-item has keep-forever registry default (Tier 2/3 are dominant; Tier 1 overrides per-instance)', () => {
    const inbox = CHIT_TYPES.find((e) => e.id === 'inbox-item')!;
    expect(inbox.destructionPolicy).toBe('keep-forever');
    expect(inbox.defaultEphemeral).toBe(true);
  });
});

describe('validator: task', () => {
  const entry = getChitType('task')!;

  it('accepts a minimal valid task', () => {
    expect(() => entry.validate({ title: 'Do the thing', priority: 'normal' })).not.toThrow();
  });

  it('accepts a fully-populated task with all optional fields', () => {
    expect(() =>
      entry.validate({
        title: 'Do the thing',
        priority: 'high',
        assignee: 'backend-engineer',
        acceptanceCriteria: ['test passes', 'PR merged'],
        estimate: '~2h',
        handedBy: 'engineering-lead',
        handedAt: '2026-04-21T14:32:17Z',
        dueAt: '2026-04-28T00:00:00Z',
        loopId: 'chit-t-aabbccdd',
        workflowStatus: 'in_progress',
      }),
    ).not.toThrow();
  });

  it('accepts all workflow status enum values', () => {
    // Project 1.3 expanded this enum from 7 to 10 states. Legacy
    // names (`pending`, `assigned`) are rejected at write-time now;
    // read-time compat is handled by the tasks.ts bridge.
    const validStates = [
      'draft', 'queued', 'dispatched', 'in_progress',
      'blocked', 'under_review',
      'completed', 'rejected', 'failed', 'cancelled',
    ];
    for (const s of validStates) {
      expect(() =>
        entry.validate({ title: 'x', priority: 'normal', workflowStatus: s }),
      ).not.toThrow();
    }
  });

  it('rejects legacy pending/assigned workflowStatus (1.3 rename)', () => {
    // After 1.3's enum rename, attempts to write pre-1.3 names
    // directly to the chit layer fail loudly. Existing pre-1.3
    // chits on disk still load (read path absorbs via tasks.ts
    // bridge); this guards against NEW writes with legacy names.
    for (const legacy of ['pending', 'assigned']) {
      expect(() =>
        entry.validate({ title: 'x', priority: 'normal', workflowStatus: legacy }),
      ).toThrow(/workflowStatus/);
    }
  });

  it('rejects invalid workflowStatus enum value', () => {
    expect(() =>
      entry.validate({ title: 'x', priority: 'normal', workflowStatus: 'frobnicating' }),
    ).toThrow(/workflowStatus/);
  });

  it('accepts null workflowStatus', () => {
    expect(() =>
      entry.validate({ title: 'x', priority: 'normal', workflowStatus: null }),
    ).not.toThrow();
  });

  it('rejects malformed handedAt timestamp', () => {
    expect(() =>
      entry.validate({ title: 'x', priority: 'normal', handedAt: 'yesterday' }),
    ).toThrow(/handedAt.*ISO/);
  });

  it('rejects malformed dueAt timestamp', () => {
    expect(() => entry.validate({ title: 'x', priority: 'normal', dueAt: '2026-04-28' })).toThrow(
      /dueAt.*ISO/,
    );
  });

  it('accepts ISO with fractional seconds and Z', () => {
    expect(() =>
      entry.validate({ title: 'x', priority: 'normal', dueAt: '2026-04-28T12:00:00.123Z' }),
    ).not.toThrow();
  });

  it('accepts ISO with timezone offset', () => {
    expect(() =>
      entry.validate({ title: 'x', priority: 'normal', dueAt: '2026-04-28T12:00:00+02:00' }),
    ).not.toThrow();
  });

  it('rejects missing title', () => {
    expect(() => entry.validate({ priority: 'normal' })).toThrow(ChitValidationError);
  });

  it('rejects empty-string title', () => {
    expect(() => entry.validate({ title: '', priority: 'normal' })).toThrow(ChitValidationError);
  });

  it('rejects invalid priority', () => {
    expect(() => entry.validate({ title: 'x', priority: 'urgent' })).toThrow(/priority/);
  });

  it('rejects non-string assignee', () => {
    expect(() => entry.validate({ title: 'x', priority: 'normal', assignee: 42 })).toThrow(/assignee/);
  });

  it('rejects non-array acceptanceCriteria', () => {
    expect(() => entry.validate({ title: 'x', priority: 'normal', acceptanceCriteria: 'not an array' })).toThrow(
      /acceptanceCriteria/,
    );
  });

  it('accepts all four complexity levels', () => {
    for (const c of ['trivial', 'small', 'medium', 'large'] as const) {
      expect(() =>
        entry.validate({ title: 'x', priority: 'normal', complexity: c }),
      ).not.toThrow();
    }
  });

  it('accepts null or omitted complexity', () => {
    expect(() =>
      entry.validate({ title: 'x', priority: 'normal', complexity: null }),
    ).not.toThrow();
    expect(() => entry.validate({ title: 'x', priority: 'normal' })).not.toThrow();
  });

  it('rejects invalid complexity value', () => {
    expect(() =>
      entry.validate({ title: 'x', priority: 'normal', complexity: 'huge' }),
    ).toThrow(/complexity/);
    expect(() =>
      entry.validate({ title: 'x', priority: 'normal', complexity: '~2 hours' }),
    ).toThrow(/complexity/);
  });

  it('rejects non-object input', () => {
    expect(() => entry.validate('string payload')).toThrow(/task/);
    expect(() => entry.validate(null)).toThrow(/task/);
    expect(() => entry.validate([])).toThrow(/task/);
  });
});

describe('validator: contract', () => {
  const entry = getChitType('contract')!;

  it('accepts a minimal valid contract', () => {
    expect(() => entry.validate({ title: 'Ship X', goal: 'X is shipped', taskIds: [] })).not.toThrow();
  });

  it('accepts a fully-populated contract', () => {
    expect(() =>
      entry.validate({
        title: 'Ship X',
        goal: 'X is shipped',
        taskIds: ['chit-t-aabbccdd', 'chit-t-11223344'],
        priority: 'high',
        leadId: 'engineering-lead',
        blueprintId: 'ship-feature',
        deadline: '2026-04-30T00:00:00Z',
        completedAt: null,
        reviewedBy: null,
        reviewNotes: null,
        rejectionCount: 0,
        projectId: 'proj-fire',
      }),
    ).not.toThrow();
  });

  it('rejects non-string projectId', () => {
    expect(() =>
      entry.validate({ title: 'x', goal: 'y', taskIds: [], projectId: 42 }),
    ).toThrow(/projectId/);
  });

  it('accepts null projectId (corp-level contract)', () => {
    expect(() =>
      entry.validate({ title: 'x', goal: 'y', taskIds: [], projectId: null }),
    ).not.toThrow();
  });

  it('rejects missing goal', () => {
    expect(() => entry.validate({ title: 'x', taskIds: [] })).toThrow(/goal/);
  });

  it('rejects non-array taskIds', () => {
    expect(() => entry.validate({ title: 'x', goal: 'y', taskIds: 'not array' })).toThrow(/taskIds/);
  });

  it('rejects non-string elements in taskIds', () => {
    expect(() => entry.validate({ title: 'x', goal: 'y', taskIds: ['a', 42] })).toThrow(/taskIds/);
  });

  it('rejects invalid priority enum', () => {
    expect(() =>
      entry.validate({ title: 'x', goal: 'y', taskIds: [], priority: 'urgent' }),
    ).toThrow(/priority/);
  });

  it('rejects negative rejectionCount', () => {
    expect(() =>
      entry.validate({ title: 'x', goal: 'y', taskIds: [], rejectionCount: -1 }),
    ).toThrow(/rejectionCount/);
  });

  it('rejects non-integer rejectionCount', () => {
    expect(() =>
      entry.validate({ title: 'x', goal: 'y', taskIds: [], rejectionCount: 1.5 }),
    ).toThrow(/rejectionCount/);
  });

  it('rejects malformed deadline', () => {
    expect(() =>
      entry.validate({ title: 'x', goal: 'y', taskIds: [], deadline: 'soon' }),
    ).toThrow(/deadline/);
  });

  it('rejects malformed completedAt', () => {
    expect(() =>
      entry.validate({ title: 'x', goal: 'y', taskIds: [], completedAt: 'never' }),
    ).toThrow(/completedAt/);
  });
});

describe('validator: observation', () => {
  const entry = getChitType('observation')!;

  it('accepts a minimal valid observation', () => {
    expect(() =>
      entry.validate({ category: 'FEEDBACK', subject: 'mark', importance: 4 }),
    ).not.toThrow();
  });

  it('accepts a fully-populated observation with context', () => {
    expect(() =>
      entry.validate({
        category: 'FEEDBACK',
        subject: 'mark',
        importance: 4,
        object: 'cascade-archive-errors',
        title: 'Mark prefers actionable errors',
        context: 'mid-work on the cascade feature',
      }),
    ).not.toThrow();
  });

  it('rejects non-string context', () => {
    expect(() =>
      entry.validate({ category: 'NOTICE', subject: 'x', importance: 1, context: 42 }),
    ).toThrow(/context/);
  });

  it('rejects invalid category', () => {
    expect(() => entry.validate({ category: 'RANDOM', subject: 'x', importance: 1 })).toThrow(/category/);
  });

  it('rejects importance below 1', () => {
    expect(() => entry.validate({ category: 'NOTICE', subject: 'x', importance: 0 })).toThrow(/importance/);
  });

  it('rejects importance above 5', () => {
    expect(() => entry.validate({ category: 'NOTICE', subject: 'x', importance: 6 })).toThrow(/importance/);
  });

  it('rejects non-integer importance', () => {
    expect(() => entry.validate({ category: 'NOTICE', subject: 'x', importance: 3.5 })).toThrow(/importance/);
  });
});

describe('validator: casket', () => {
  const entry = getChitType('casket')!;

  it('accepts null currentStep (idle casket)', () => {
    expect(() => entry.validate({ currentStep: null })).not.toThrow();
  });

  it('rejects malformed lastAdvanced timestamp', () => {
    expect(() => entry.validate({ currentStep: null, lastAdvanced: 'yesterday' })).toThrow(
      /lastAdvanced/,
    );
  });

  it('accepts string currentStep', () => {
    expect(() => entry.validate({ currentStep: 'chit-t-abc12345' })).not.toThrow();
  });

  it('rejects missing currentStep (undefined)', () => {
    expect(() => entry.validate({})).toThrow(/currentStep/);
  });

  it('rejects non-string, non-null currentStep', () => {
    expect(() => entry.validate({ currentStep: 42 })).toThrow(/currentStep/);
  });

  it('rejects negative sessionCount', () => {
    expect(() => entry.validate({ currentStep: null, sessionCount: -1 })).toThrow(/sessionCount/);
  });
});

describe('validator: handoff', () => {
  const entry = getChitType('handoff')!;

  it('accepts a minimal valid handoff', () => {
    expect(() =>
      entry.validate({
        predecessorSession: 'toast-17',
        currentStep: 'chit-t-abc',
        completed: [],
        nextAction: 'continue',
      }),
    ).not.toThrow();
  });

  it('rejects missing nextAction', () => {
    expect(() =>
      entry.validate({
        predecessorSession: 'toast-17',
        currentStep: 'chit-t-abc',
        completed: [],
      }),
    ).toThrow(/nextAction/);
  });

  it('rejects non-array completed', () => {
    expect(() =>
      entry.validate({
        predecessorSession: 'toast-17',
        currentStep: 'chit-t-abc',
        completed: 'single string',
        nextAction: 'continue',
      }),
    ).toThrow(/completed/);
  });
});

describe('validator: dispatch-context', () => {
  const entry = getChitType('dispatch-context')!;

  it('accepts a minimal valid dispatch-context', () => {
    expect(() =>
      entry.validate({
        sourceAgent: 'ceo',
        targetAgent: 'backend-engineer',
        workChitId: 'chit-t-abc',
      }),
    ).not.toThrow();
  });

  it('rejects missing targetAgent', () => {
    expect(() => entry.validate({ sourceAgent: 'ceo', workChitId: 'chit-t-abc' })).toThrow(/targetAgent/);
  });
});

describe('validator: pre-brain-entry', () => {
  const entry = getChitType('pre-brain-entry')!;

  it('accepts a minimal valid pre-brain-entry', () => {
    expect(() =>
      entry.validate({ role: 'backend-engineer', memoryType: 'rule', confidence: 'medium' }),
    ).not.toThrow();
  });

  it('rejects invalid memoryType', () => {
    expect(() =>
      entry.validate({ role: 'x', memoryType: 'intuition', confidence: 'high' }),
    ).toThrow(/memoryType/);
  });

  it('rejects invalid confidence', () => {
    expect(() =>
      entry.validate({ role: 'x', memoryType: 'fact', confidence: 'very-high' }),
    ).toThrow(/confidence/);
  });
});

describe('validator: step-log', () => {
  const entry = getChitType('step-log')!;

  it('accepts a minimal valid step-log', () => {
    expect(() =>
      entry.validate({ taskChitId: 'chit-t-abc', phase: 'implement', outcome: 'started' }),
    ).not.toThrow();
  });

  it('rejects invalid outcome', () => {
    expect(() =>
      entry.validate({ taskChitId: 'chit-t-abc', phase: 'x', outcome: 'partially' }),
    ).toThrow(/outcome/);
  });
});

describe('validator: inbox-item', () => {
  const entry = getChitType('inbox-item')!;

  it('accepts a minimal valid Tier 1 ambient inbox-item', () => {
    expect(() =>
      entry.validate({
        tier: 1,
        from: 'failsafe',
        subject: 'restarted researcher',
        source: 'system',
      }),
    ).not.toThrow();
  });

  it('accepts Tier 2 direct @mention inbox-item with sourceRef', () => {
    expect(() =>
      entry.validate({
        tier: 2,
        from: 'herald',
        subject: 'how are the chits going?',
        source: 'channel',
        sourceRef: 'general',
      }),
    ).not.toThrow();
  });

  it('accepts Tier 3 founder DM inbox-item', () => {
    expect(() =>
      entry.validate({
        tier: 3,
        from: 'mark',
        subject: 'what is the corp status?',
        source: 'dm',
      }),
    ).not.toThrow();
  });

  it('rejects invalid tier values (not 1|2|3)', () => {
    expect(() =>
      entry.validate({ tier: 4, from: 'x', subject: 'y', source: 'system' }),
    ).toThrow(/tier/);
    expect(() =>
      entry.validate({ tier: 0, from: 'x', subject: 'y', source: 'system' }),
    ).toThrow(/tier/);
    expect(() =>
      entry.validate({ tier: '1', from: 'x', subject: 'y', source: 'system' }),
    ).toThrow(/tier/);
  });

  it('rejects empty from / subject (the wtf header would render garbage)', () => {
    expect(() =>
      entry.validate({ tier: 2, from: '', subject: 'y', source: 'system' }),
    ).toThrow(/from/);
    expect(() =>
      entry.validate({ tier: 2, from: 'x', subject: '', source: 'system' }),
    ).toThrow(/subject/);
  });

  it('rejects unknown source values (enum drift catch)', () => {
    expect(() =>
      entry.validate({ tier: 2, from: 'x', subject: 'y', source: 'telepathy' }),
    ).toThrow(/source/);
  });

  it('accepts resolution states: responded, dismissed, null, omitted', () => {
    for (const resolution of ['responded', 'dismissed', null, undefined]) {
      expect(() =>
        entry.validate({
          tier: 2,
          from: 'x',
          subject: 'y',
          source: 'dm',
          resolution,
        }),
      ).not.toThrow();
    }
  });

  it('rejects invalid resolution values', () => {
    expect(() =>
      entry.validate({
        tier: 2,
        from: 'x',
        subject: 'y',
        source: 'dm',
        resolution: 'ignored',
      }),
    ).toThrow(/resolution/);
  });

  it('rejects carriedForward:true without carryReason (load-bearing for audit)', () => {
    // The escape valve requires a real reason — a bare carriedForward flip
    // would let an agent punt without explaining, defeating the audit gate.
    expect(() =>
      entry.validate({
        tier: 3,
        from: 'mark',
        subject: 'clarify X',
        source: 'dm',
        carriedForward: true,
      }),
    ).toThrow(/carryReason/);

    expect(() =>
      entry.validate({
        tier: 3,
        from: 'mark',
        subject: 'clarify X',
        source: 'dm',
        carriedForward: true,
        carryReason: '',
      }),
    ).toThrow(/carryReason/);
  });

  it('accepts carriedForward:true with a real carryReason', () => {
    expect(() =>
      entry.validate({
        tier: 3,
        from: 'mark',
        subject: 'clarify X',
        source: 'dm',
        carriedForward: true,
        carryReason: 'waiting on founder clarification on X',
      }),
    ).not.toThrow();
  });

  it('accepts carriedForward:false or null without a reason', () => {
    expect(() =>
      entry.validate({
        tier: 2,
        from: 'x',
        subject: 'y',
        source: 'dm',
        carriedForward: false,
      }),
    ).not.toThrow();
    expect(() =>
      entry.validate({
        tier: 2,
        from: 'x',
        subject: 'y',
        source: 'dm',
        carriedForward: null,
      }),
    ).not.toThrow();
  });
});

describe('ChitValidationError', () => {
  it('carries the failing field path', () => {
    const entry = getChitType('task')!;
    try {
      entry.validate({ title: '', priority: 'normal' });
      expect.fail('expected validation to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ChitValidationError);
      expect((err as ChitValidationError).field).toBe('task.title');
    }
  });

  it('has a descriptive name', () => {
    const err = new ChitValidationError('test');
    expect(err.name).toBe('ChitValidationError');
  });
});
