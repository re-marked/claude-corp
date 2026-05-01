import { describe, it, expect } from 'vitest';
import {
  validateTransition,
  resolveTransition,
  legalTriggersFrom,
  initialState,
  isTerminal,
  isTerminalSuccess,
  isTerminalFailure,
  TaskTransitionError,
  TRANSITION_RULES,
  TERMINAL_STATES,
  ALL_STATES,
} from '../packages/shared/src/task-state-machine.js';
import type { TaskWorkflowStatus } from '../packages/shared/src/types/chit.js';

/**
 * Unit tests for the pure task state machine. No I/O, no fixtures —
 * just the transition table + validator + classification helpers.
 * Pins every legal (from, trigger) pair documented in REFACTOR.md 1.3
 * plus the negative cases the validator must reject.
 */

describe('task state machine — TRANSITION_RULES shape', () => {
  it('every state appears in ALL_STATES', () => {
    const expected: TaskWorkflowStatus[] = [
      'draft', 'queued', 'dispatched', 'in_progress', 'blocked',
      'under_review', 'clearance', 'completed', 'rejected', 'failed', 'cancelled',
    ];
    expect([...ALL_STATES]).toEqual(expected);
  });

  it('terminal states have no legal triggers in the rules table', () => {
    for (const t of ['completed', 'failed', 'cancelled'] as const) {
      expect(TRANSITION_RULES[t] ?? {}).toEqual({});
    }
  });

  it('rejected has exactly one legal trigger: reopen', () => {
    expect(Object.keys(TRANSITION_RULES.rejected ?? {})).toEqual(['reopen']);
  });

  it('every non-terminal state allows cancel (founder escape hatch)', () => {
    for (const s of ALL_STATES) {
      if (isTerminal(s)) continue;
      expect(TRANSITION_RULES[s]?.cancel).toBe('cancelled');
    }
  });

  it('every non-terminal state allows fail (circuit breaker)', () => {
    for (const s of ALL_STATES) {
      if (isTerminal(s)) continue;
      expect(TRANSITION_RULES[s]?.fail).toBe('failed');
    }
  });
});

describe('task state machine — happy path transitions', () => {
  it('draft → assign → queued', () => {
    expect(validateTransition('draft', 'assign')).toBe('queued');
  });

  it('queued → dispatch → dispatched', () => {
    expect(validateTransition('queued', 'dispatch')).toBe('dispatched');
  });

  it('dispatched → claim → in_progress', () => {
    expect(validateTransition('dispatched', 'claim')).toBe('in_progress');
  });

  it('in_progress → handoff → under_review', () => {
    expect(validateTransition('in_progress', 'handoff')).toBe('under_review');
  });

  it('under_review → audit-approve → completed', () => {
    expect(validateTransition('under_review', 'audit-approve')).toBe('completed');
  });

  it('under_review → audit-block → in_progress', () => {
    expect(validateTransition('under_review', 'audit-block')).toBe('in_progress');
  });

  it('in_progress → block → blocked, blocked → unblock → in_progress', () => {
    expect(validateTransition('in_progress', 'block')).toBe('blocked');
    expect(validateTransition('blocked', 'unblock')).toBe('in_progress');
  });

  it('dispatched → block → blocked (rare but legal — pre-work blocker)', () => {
    expect(validateTransition('dispatched', 'block')).toBe('blocked');
  });

  it('rejected → reopen → in_progress (the only way out of rejected)', () => {
    expect(validateTransition('rejected', 'reopen')).toBe('in_progress');
  });
});

describe('task state machine — invalid transitions throw', () => {
  it('draft → handoff is illegal (no in_progress yet)', () => {
    expect(() => validateTransition('draft', 'handoff')).toThrow(TaskTransitionError);
  });

  it('queued → audit-approve is illegal (no under_review yet)', () => {
    expect(() => validateTransition('queued', 'audit-approve')).toThrow(TaskTransitionError);
  });

  it('completed is truly terminal — any trigger fails', () => {
    for (const trigger of ['assign', 'dispatch', 'claim', 'block', 'unblock', 'handoff', 'audit-approve', 'audit-block', 'reject', 'reopen', 'fail', 'cancel'] as const) {
      expect(() => validateTransition('completed', trigger)).toThrow(TaskTransitionError);
    }
  });

  it('failed is truly terminal — any trigger fails', () => {
    for (const trigger of ['assign', 'dispatch', 'claim', 'handoff', 'audit-approve', 'reopen'] as const) {
      expect(() => validateTransition('failed', trigger)).toThrow(TaskTransitionError);
    }
  });

  it('cancelled is truly terminal — any trigger fails', () => {
    for (const trigger of ['assign', 'reopen', 'unblock'] as const) {
      expect(() => validateTransition('cancelled', trigger)).toThrow(TaskTransitionError);
    }
  });

  it('blocked → audit-approve is illegal (must unblock first)', () => {
    expect(() => validateTransition('blocked', 'audit-approve')).toThrow(TaskTransitionError);
  });

  it('TaskTransitionError carries from, trigger, and a helpful message', () => {
    try {
      validateTransition('draft', 'handoff', 'chit-t-abc12345');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskTransitionError);
      const e = err as TaskTransitionError;
      expect(e.from).toBe('draft');
      expect(e.trigger).toBe('handoff');
      expect(e.taskId).toBe('chit-t-abc12345');
      expect(e.message).toContain('draft');
      expect(e.message).toContain('handoff');
      expect(e.message).toContain('Legal triggers from');
    }
  });
});

describe('task state machine — resolveTransition (non-throwing twin)', () => {
  it('returns the destination on legal pairs', () => {
    expect(resolveTransition('in_progress', 'handoff')).toBe('under_review');
  });

  it('returns undefined on illegal pairs (no throw)', () => {
    expect(resolveTransition('completed', 'assign')).toBeUndefined();
    expect(resolveTransition('draft', 'handoff')).toBeUndefined();
  });
});

describe('task state machine — classification helpers', () => {
  it('TERMINAL_STATES == [completed, rejected, failed, cancelled]', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['cancelled', 'completed', 'failed', 'rejected']);
  });

  it('isTerminal is true for terminal states and false otherwise', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('rejected')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('draft')).toBe(false);
    expect(isTerminal('in_progress')).toBe(false);
    expect(isTerminal('blocked')).toBe(false);
    expect(isTerminal('under_review')).toBe(false);
  });

  it('isTerminalSuccess is true only for completed', () => {
    expect(isTerminalSuccess('completed')).toBe(true);
    for (const s of ['rejected', 'failed', 'cancelled', 'draft', 'in_progress'] as const) {
      expect(isTerminalSuccess(s)).toBe(false);
    }
  });

  it('isTerminalFailure is true for rejected / failed / cancelled', () => {
    expect(isTerminalFailure('rejected')).toBe(true);
    expect(isTerminalFailure('failed')).toBe(true);
    expect(isTerminalFailure('cancelled')).toBe(true);
    expect(isTerminalFailure('completed')).toBe(false);
    expect(isTerminalFailure('draft')).toBe(false);
  });
});

describe('task state machine — initialState', () => {
  it('no assignee → draft', () => {
    expect(initialState(false)).toBe('draft');
  });

  it('has assignee → queued', () => {
    expect(initialState(true)).toBe('queued');
  });
});

describe('task state machine — legalTriggersFrom', () => {
  it('returns the key list for a state with rules', () => {
    const triggers = legalTriggersFrom('under_review').sort();
    expect(triggers).toContain('audit-approve');
    expect(triggers).toContain('audit-block');
    expect(triggers).toContain('reject');
  });

  it('returns [] for fully-terminal states', () => {
    expect(legalTriggersFrom('completed')).toEqual([]);
    expect(legalTriggersFrom('failed')).toEqual([]);
    expect(legalTriggersFrom('cancelled')).toEqual([]);
  });

  it('under_review supports submit-for-clearance → clearance (Codex P2 round 7 PR #204)', () => {
    // The clearinghouse-aware branch of audit-approve. Pre-fix,
    // enterClearance wrote workflowStatus directly; Project 1.3's
    // mechanical-enforcement guarantee silently bypassed on this
    // path. New trigger fires through validateTransition, so the
    // table is the single source of truth for under_review exits.
    const triggers = legalTriggersFrom('under_review');
    expect(triggers).toContain('submit-for-clearance');
    expect(triggers).toContain('audit-approve'); // direct path still preserved
  });

  it('returns [merge, block, fail, cancel] for clearance (Codex P1 round 4 PR #204)', () => {
    // Pre-fix: clearance had no row in TRANSITION_RULES, so any
    // validateTransition call against a clearance-state task threw —
    // fail/cancel/recovery flows from the Pressman lane couldn't
    // complete. Pin the legal-trigger set so the row stays present.
    const triggers = legalTriggersFrom('clearance');
    expect([...triggers].sort()).toEqual(['block', 'cancel', 'fail', 'merge']);
  });

  it('returns [reopen] for rejected (the only legal exit)', () => {
    expect(legalTriggersFrom('rejected')).toEqual(['reopen']);
  });
});
