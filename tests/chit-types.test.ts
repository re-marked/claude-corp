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
      }),
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
      }),
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
