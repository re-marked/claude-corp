import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  findChitById,
  buildWtfOutput,
  ChitValidationError,
  getChitType,
  type Chit,
  type HandoffFields,
  type HandoffWalkCompletedStep,
} from '../packages/shared/src/index.js';
import { promotePendingHandoff } from '../packages/shared/src/audit/handoff-promotion.js';

/**
 * Project 2.2.2 — handoff walk-fields coverage. Three concerns:
 *
 *   1. Schema validator (validateHandoff): walk fields are optional+
 *      nullable; structural rejection on malformed input.
 *   2. Audit-promotion pipeline: promotePendingHandoff populates the
 *      walk fields when the predecessor's task was walk-shaped, omits
 *      them on ad-hoc tasks (graceful degradation).
 *   3. End-to-end via buildWtfOutput: successor's wtf header renders
 *      the "Walk continuity:" line above the prose XML in the handoff
 *      block when the chit carries walk fields.
 */

// ─── Fixtures ──────────────────────────────────────────────────────

function makeCorp(): { corpRoot: string; cleanup: () => void } {
  const corpRoot = mkdtempSync(join(tmpdir(), 'handoff-walk-'));
  return {
    corpRoot,
    cleanup: () => {
      try {
        rmSync(corpRoot, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    },
  };
}

function validate(fields: Partial<HandoffFields>): void {
  const entry = getChitType('handoff');
  if (!entry) throw new Error('test setup: handoff type missing from registry');
  entry.validate(fields);
}

function minimalHandoff(overrides: Partial<HandoffFields> = {}): Partial<HandoffFields> {
  return {
    predecessorSession: 'toast-1',
    currentStep: 'chit-t-current',
    completed: ['did the thing'],
    nextAction: 'do the next thing',
    ...overrides,
  };
}

/**
 * Seed a walk-shaped predecessor scenario: blueprint + contract + tasks
 * (one completed, one in-progress). Returns ids for assertions.
 */
function seedWalkScenario(corpRoot: string, agentSlug: string): {
  blueprintId: string;
  contractId: string;
  completedTaskId: string;
  currentTaskId: string;
} {
  const blueprint = createChit(corpRoot, {
    type: 'blueprint',
    scope: 'corp',
    status: 'active',
    createdBy: 'ceo',
    body: '',
    fields: {
      blueprint: {
        name: 'ship-feature',
        origin: 'authored',
        steps: [
          { id: 'pick-up-task', title: 'Pick up' },
          { id: 'acquire-worktree', title: 'Acquire', dependsOn: ['pick-up-task'] },
          { id: 'implement', title: 'Implement', dependsOn: ['acquire-worktree'] },
        ],
      },
    },
  });
  const t1 = createChit(corpRoot, {
    type: 'task',
    scope: 'corp',
    createdBy: agentSlug,
    body: '',
    tags: ['blueprint:ship-feature', 'blueprint-step:pick-up-task'],
    fields: {
      task: {
        title: 'Pick up',
        priority: 'normal',
        assignee: agentSlug,
        workflowStatus: 'completed',
      },
    },
  });
  const t2 = createChit(corpRoot, {
    type: 'task',
    scope: 'corp',
    createdBy: agentSlug,
    body: '',
    tags: ['blueprint:ship-feature', 'blueprint-step:acquire-worktree'],
    fields: {
      task: {
        title: 'Acquire',
        priority: 'normal',
        assignee: agentSlug,
        workflowStatus: 'under_review', // predecessor reached `cc-cli done`
      },
    },
  });
  const t3 = createChit(corpRoot, {
    type: 'task',
    scope: 'corp',
    createdBy: agentSlug,
    body: '',
    tags: ['blueprint:ship-feature', 'blueprint-step:implement'],
    fields: {
      task: {
        title: 'Implement',
        priority: 'normal',
        assignee: agentSlug,
        workflowStatus: 'queued',
      },
    },
  });
  const contract = createChit(corpRoot, {
    type: 'contract',
    scope: 'corp',
    createdBy: 'ceo',
    body: '',
    fields: {
      contract: {
        title: 'Ship the feature',
        goal: 'g',
        taskIds: [t1.id, t2.id, t3.id],
        blueprintId: blueprint.id,
      },
    },
  });
  // Casket pointing at the predecessor's current step (t2).
  createChit(corpRoot, {
    type: 'casket',
    id: `casket-${agentSlug}`,
    scope: `agent:${agentSlug}`,
    createdBy: agentSlug,
    body: '',
    fields: { casket: { currentStep: t2.id } },
  });
  return {
    blueprintId: blueprint.id,
    contractId: contract.id,
    completedTaskId: t1.id,
    currentTaskId: t2.id,
  };
}

// ─── 1. Schema validator ───────────────────────────────────────────

describe('validateHandoff — walk fields', () => {
  it('accepts handoff with all walk fields present', () => {
    expect(() =>
      validate(
        minimalHandoff({
          walkBlueprintName: 'ship-feature',
          walkStepId: 'acquire-worktree',
          walkStepIndex: 2,
          walkTotalSteps: 3,
          walkCompletedSteps: [
            {
              stepId: 'pick-up-task',
              taskId: 'chit-t-1',
              status: 'completed',
              completedAt: '2026-05-02T14:46:00.000Z',
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('accepts handoff with all walk fields explicitly null (graceful no-walk)', () => {
    expect(() =>
      validate(
        minimalHandoff({
          walkBlueprintName: null,
          walkStepId: null,
          walkStepIndex: null,
          walkTotalSteps: null,
          walkCompletedSteps: null,
        }),
      ),
    ).not.toThrow();
  });

  it('accepts handoff with walk fields entirely absent (pre-2.2.2 chits)', () => {
    expect(() => validate(minimalHandoff())).not.toThrow();
  });

  it('rejects walkStepIndex of 0 (must be 1-based)', () => {
    expect(() =>
      validate(
        minimalHandoff({
          walkStepIndex: 0,
        }),
      ),
    ).toThrow(ChitValidationError);
  });

  it('rejects walkStepIndex of -5', () => {
    expect(() =>
      validate(
        minimalHandoff({
          walkStepIndex: -5,
        }),
      ),
    ).toThrow(ChitValidationError);
  });

  it('rejects walkTotalSteps of 0', () => {
    expect(() =>
      validate(
        minimalHandoff({
          walkTotalSteps: 0,
        }),
      ),
    ).toThrow(ChitValidationError);
  });

  it('rejects walkCompletedSteps when not an array', () => {
    expect(() =>
      validate(
        minimalHandoff({
          walkCompletedSteps: 'not-an-array' as unknown as readonly HandoffWalkCompletedStep[],
        }),
      ),
    ).toThrow(ChitValidationError);
  });

  it('rejects walkCompletedSteps entry with empty stepId', () => {
    expect(() =>
      validate(
        minimalHandoff({
          walkCompletedSteps: [
            {
              stepId: '',
              taskId: 'chit-t-1',
              status: 'completed',
              completedAt: '2026-05-02T14:46:00.000Z',
            } as unknown as HandoffWalkCompletedStep,
          ],
        }),
      ),
    ).toThrow(ChitValidationError);
  });

  it('rejects walkCompletedSteps entry with empty status', () => {
    expect(() =>
      validate(
        minimalHandoff({
          walkCompletedSteps: [
            {
              stepId: 's1',
              taskId: 'chit-t-1',
              status: '',
              completedAt: null,
            } as unknown as HandoffWalkCompletedStep,
          ],
        }),
      ),
    ).toThrow(ChitValidationError);
  });

  it('accepts walkCompletedSteps entry with null taskId + null completedAt', () => {
    expect(() =>
      validate(
        minimalHandoff({
          walkCompletedSteps: [
            {
              stepId: 's1',
              taskId: null,
              status: 'completed',
              completedAt: null,
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

// ─── 2. Audit-promotion populates walk fields ──────────────────────

describe('promotePendingHandoff — walk-shaped task', () => {
  it('writes walk fields to the handoff chit', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const { completedTaskId, currentTaskId } = seedWalkScenario(corpRoot, 'toast');
      const workspace = join(corpRoot, 'agents', 'toast');
      // Write pending-handoff payload.
      const pendingPayload = {
        predecessorSession: 'toast-1',
        currentStep: currentTaskId,
        completed: ['acquired worktree, ran tests'],
        nextAction: 'implement the actual feature',
        openQuestion: null,
        sandboxState: 'feat/walks branch checked out',
        notes: null,
        createdBy: 'toast',
        createdAt: '2026-05-02T15:00:00.000Z',
      };
      // Ensure workspace exists.
      
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, '.pending-handoff.json'), JSON.stringify(pendingPayload));

      const result = promotePendingHandoff(corpRoot, 'toast', workspace);
      // Surface promotion errors immediately if any — turns the
      // null-handoffChitId failure mode into an actionable diagnostic.
      if (result.errors.length > 0) {
        throw new Error(`promote errors: ${result.errors.join(' | ')}`);
      }
      expect(result.promoted).toBe(true);
      expect(result.handoffChitId).not.toBeNull();
      expect(result.errors).toEqual([]);

      // Read back the handoff chit + verify walk fields.
      const handoffHit = findChitById(corpRoot, result.handoffChitId!);
      expect(handoffHit).not.toBeNull();
      const f = handoffHit.chit.fields.handoff as HandoffFields;
      expect(f.walkBlueprintName).toBe('ship-feature');
      expect(f.walkStepId).toBe('acquire-worktree');
      expect(f.walkStepIndex).toBe(2);
      expect(f.walkTotalSteps).toBe(3);
      // Only the first task is `completed`; the current task is
      // `under_review` (terminal-ish but not terminal per state machine);
      // implement is `queued`. So walkCompletedSteps should have ONE
      // entry for pick-up-task.
      expect(f.walkCompletedSteps).toHaveLength(1);
      expect(f.walkCompletedSteps![0].stepId).toBe('pick-up-task');
      expect(f.walkCompletedSteps![0].taskId).toBe(completedTaskId);
      expect(f.walkCompletedSteps![0].status).toBe('completed');
    } finally {
      cleanup();
    }
  });
});

describe('promotePendingHandoff — ad-hoc task', () => {
  it('omits walk fields when predecessor task has no walk linkage', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Ad-hoc task — no blueprint / contract.
      const t = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'toast',
        body: '',
        fields: {
          task: {
            title: 'Ad-hoc task',
            priority: 'normal',
            assignee: 'toast',
            workflowStatus: 'under_review',
          },
        },
      });
      createChit(corpRoot, {
        type: 'casket',
        id: 'casket-toast',
        scope: 'agent:toast',
        createdBy: 'toast',
        body: '',
        fields: { casket: { currentStep: t.id } },
      });

      const workspace = join(corpRoot, 'agents', 'toast');
      
      mkdirSync(workspace, { recursive: true });
      const pendingPayload = {
        predecessorSession: 'toast-1',
        currentStep: t.id,
        completed: ['some prose'],
        nextAction: 'finish it',
        openQuestion: null,
        sandboxState: null,
        notes: null,
        createdBy: 'toast',
        createdAt: '2026-05-02T15:00:00.000Z',
      };
      writeFileSync(join(workspace, '.pending-handoff.json'), JSON.stringify(pendingPayload));

      const result = promotePendingHandoff(corpRoot, 'toast', workspace);
      // Surface promotion errors immediately if any — turns the
      // null-handoffChitId failure mode into an actionable diagnostic.
      if (result.errors.length > 0) {
        throw new Error(`promote errors: ${result.errors.join(' | ')}`);
      }
      expect(result.promoted).toBe(true);
      expect(result.handoffChitId).not.toBeNull();

      
      const handoffHit = findChitById(corpRoot, result.handoffChitId!);
      const f = handoffHit.chit.fields.handoff as HandoffFields;
      expect(f.walkBlueprintName).toBeUndefined();
      expect(f.walkStepId).toBeUndefined();
      expect(f.walkStepIndex).toBeUndefined();
      expect(f.walkTotalSteps).toBeUndefined();
      expect(f.walkCompletedSteps).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

// ─── 3. End-to-end via buildWtfOutput ─────────────────────────────

describe('buildWtfOutput — successor sees walk continuity in handoff block', () => {
  it('renders Walk continuity line above the prose XML when handoff carries walk fields', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Write a handoff chit with walk fields directly (skipping the
      // promotion path — that's covered above; here we focus on the
      // wtf-header render).
      createChit(corpRoot, {
        type: 'handoff',
        scope: 'agent:successor',
        createdBy: 'toast',
        body: '',
        fields: {
          handoff: {
            predecessorSession: 'toast-1',
            currentStep: 'chit-t-current',
            completed: ['acquired worktree'],
            nextAction: 'implement',
            walkBlueprintName: 'ship-feature',
            walkStepId: 'implement',
            walkStepIndex: 3,
            walkTotalSteps: 5,
            walkCompletedSteps: [
              { stepId: 'pick-up-task', taskId: 'chit-t-1', status: 'completed', completedAt: '2026-05-02T14:30:00.000Z' },
              { stepId: 'design', taskId: 'chit-t-2', status: 'completed', completedAt: '2026-05-02T14:45:00.000Z' },
            ],
          },
        },
      });

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'successor',
        displayName: 'Copper',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'successor'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false, // peek so we can read it
      });

      expect(result.header).toContain('Handoff from predecessor session:');
      expect(result.header).toContain('Walk continuity: ship-feature, step 3 of 5 (implement)');
      expect(result.header).toContain('Predecessor completed: pick-up-task, design');
      // Walk continuity line appears ABOVE the XML block.
      const continuityIdx = result.header.indexOf('Walk continuity');
      const xmlIdx = result.header.indexOf('```xml');
      expect(continuityIdx).toBeGreaterThan(-1);
      expect(xmlIdx).toBeGreaterThan(-1);
      expect(continuityIdx).toBeLessThan(xmlIdx);
    } finally {
      cleanup();
    }
  });

  it('renders "Predecessor progress unknown" when walkCompletedSteps is null (Codex P2 regression)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // walkCompletedSteps: null is the snapshot writer's explicit
      // failure marker (resolveWalkSnapshotForHandoff sets null when
      // getWalkProgress is unavailable). Earlier draft conflated null
      // with [] and rendered "No completed steps yet" — misleading
      // successors about predecessor progress in degraded scenarios.
      // Distinct render now disambiguates.
      createChit(corpRoot, {
        type: 'handoff',
        scope: 'agent:successor',
        createdBy: 'toast',
        body: '',
        fields: {
          handoff: {
            predecessorSession: 'toast-1',
            currentStep: 'chit-t-current',
            completed: ['some prose'],
            nextAction: 'continue',
            walkBlueprintName: 'ship-feature',
            walkStepId: 'implement',
            walkStepIndex: 3,
            walkTotalSteps: 5,
            walkCompletedSteps: null, // <-- failure marker, NOT empty
          },
        },
      });

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'successor',
        displayName: 'Copper',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'successor'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });

      expect(result.header).toContain('Walk continuity: ship-feature, step 3 of 5 (implement)');
      expect(result.header).toContain('Predecessor progress unknown');
      // Critically: NOT the "No completed steps yet" render — that's
      // the [] case with different semantics.
      expect(result.header).not.toContain('No completed steps yet');
    } finally {
      cleanup();
    }
  });

  it('renders "No completed steps yet" when predecessor was on step 1', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      createChit(corpRoot, {
        type: 'handoff',
        scope: 'agent:successor',
        createdBy: 'toast',
        body: '',
        fields: {
          handoff: {
            predecessorSession: 'toast-1',
            currentStep: 'chit-t-current',
            completed: [],
            nextAction: 'continue step 1',
            walkBlueprintName: 'ship-feature',
            walkStepId: 'pick-up-task',
            walkStepIndex: 1,
            walkTotalSteps: 5,
            walkCompletedSteps: [],
          },
        },
      });

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'successor',
        displayName: 'Copper',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'successor'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });

      expect(result.header).toContain('Walk continuity: ship-feature, step 1 of 5 (pick-up-task)');
      expect(result.header).toContain('No completed steps yet.');
    } finally {
      cleanup();
    }
  });

  it('renders explicit per-step status when any step is non-completed terminal (Codex P2 round 2 regression)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // walkCompletedSteps captures all TERMINAL-status steps via
      // isTerminal — completed, failed, rejected, cancelled. Earlier
      // draft labeled them all "Predecessor completed" — would have
      // told successors a failed step was completed. Now disambiguates:
      //   all-completed → terse "Predecessor completed: X, Y."
      //   mixed         → explicit "Predecessor steps: X (completed), Y (failed)."
      createChit(corpRoot, {
        type: 'handoff',
        scope: 'agent:successor',
        createdBy: 'toast',
        body: '',
        fields: {
          handoff: {
            predecessorSession: 'toast-1',
            currentStep: 'chit-t-current',
            completed: ['some prose'],
            nextAction: 'recover',
            walkBlueprintName: 'ship-feature',
            walkStepId: 'recovery',
            walkStepIndex: 4,
            walkTotalSteps: 5,
            walkCompletedSteps: [
              { stepId: 'pick-up', taskId: 'chit-t-1', status: 'completed', completedAt: null },
              { stepId: 'design', taskId: 'chit-t-2', status: 'failed', completedAt: null },
              { stepId: 'attempt', taskId: 'chit-t-3', status: 'cancelled', completedAt: null },
            ],
          },
        },
      });

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'successor',
        displayName: 'Copper',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'successor'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });

      // Per-step status framing: each step's status visible.
      expect(result.header).toContain('Predecessor steps: pick-up (completed), design (failed), attempt (cancelled)');
      // Critically: NOT the misleading "Predecessor completed:" framing.
      expect(result.header).not.toContain('Predecessor completed: pick-up');
    } finally {
      cleanup();
    }
  });

  it('switches to verbose mode when a HIDDEN (truncated) step is non-completed (audit follow-on)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Self-audit follow-on to Codex P2 round 2: earlier draft
      // checked shown.every — meaning a failed step truncated past
      // the visible cap stayed hidden behind the terse "Predecessor
      // completed" label. Now checks the full completedSteps array
      // so any hidden non-completed step forces verbose mode on the
      // visible items too. Successor sees explicit "(completed)" on
      // visible items + "+N more" suffix; can `cc-cli chit read` for
      // the full tail.
      createChit(corpRoot, {
        type: 'handoff',
        scope: 'agent:successor',
        createdBy: 'toast',
        body: '',
        fields: {
          handoff: {
            predecessorSession: 'toast-1',
            currentStep: 'chit-t-current',
            completed: ['mixed bag'],
            nextAction: 'recover',
            walkBlueprintName: 'big-walk',
            walkStepId: 'recovery',
            walkStepIndex: 6,
            walkTotalSteps: 8,
            walkCompletedSteps: [
              { stepId: 'a', taskId: 'chit-t-a', status: 'completed', completedAt: null },
              { stepId: 'b', taskId: 'chit-t-b', status: 'completed', completedAt: null },
              { stepId: 'c', taskId: 'chit-t-c', status: 'completed', completedAt: null },
              // 4th step is FAILED but cap=3 hides it — must still
              // force verbose mode on the visible 3.
              { stepId: 'd', taskId: 'chit-t-d', status: 'failed', completedAt: null },
              { stepId: 'e', taskId: 'chit-t-e', status: 'completed', completedAt: null },
            ],
          },
        },
      });

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'successor',
        displayName: 'Copper',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'successor'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });

      // Verbose mode kicks in even though shown items (a, b, c) are
      // all completed — because hidden 'd' is failed.
      expect(result.header).toContain('Predecessor steps: a (completed), b (completed), c (completed), +2 more');
      expect(result.header).not.toContain('Predecessor completed:');
    } finally {
      cleanup();
    }
  });

  it('keeps terse "Predecessor completed" framing when all shown steps are completed (common case)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // The dominant case in healthy walks — all shown steps reached
      // terminal-success. Terse render preserved.
      createChit(corpRoot, {
        type: 'handoff',
        scope: 'agent:successor',
        createdBy: 'toast',
        body: '',
        fields: {
          handoff: {
            predecessorSession: 'toast-1',
            currentStep: 'chit-t-current',
            completed: ['ok'],
            nextAction: 'continue',
            walkBlueprintName: 'ship-feature',
            walkStepId: 'implement',
            walkStepIndex: 3,
            walkTotalSteps: 5,
            walkCompletedSteps: [
              { stepId: 'a', taskId: 'chit-t-a', status: 'completed', completedAt: null },
              { stepId: 'b', taskId: 'chit-t-b', status: 'completed', completedAt: null },
            ],
          },
        },
      });

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'successor',
        displayName: 'Copper',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'successor'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });

      expect(result.header).toContain('Predecessor completed: a, b');
      expect(result.header).not.toContain('Predecessor steps:');
    } finally {
      cleanup();
    }
  });

  it('truncates completedSteps with "+N more" when over cap', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      createChit(corpRoot, {
        type: 'handoff',
        scope: 'agent:successor',
        createdBy: 'toast',
        body: '',
        fields: {
          handoff: {
            predecessorSession: 'toast-1',
            currentStep: 'chit-t-current',
            completed: ['lots done'],
            nextAction: 'continue',
            walkBlueprintName: 'big-walk',
            walkStepId: 'final',
            walkStepIndex: 6,
            walkTotalSteps: 7,
            walkCompletedSteps: [
              { stepId: 'a', taskId: 'chit-t-a', status: 'completed', completedAt: null },
              { stepId: 'b', taskId: 'chit-t-b', status: 'completed', completedAt: null },
              { stepId: 'c', taskId: 'chit-t-c', status: 'completed', completedAt: null },
              { stepId: 'd', taskId: 'chit-t-d', status: 'completed', completedAt: null },
              { stepId: 'e', taskId: 'chit-t-e', status: 'completed', completedAt: null },
            ],
          },
        },
      });

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'successor',
        displayName: 'Copper',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'successor'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });

      expect(result.header).toContain('Predecessor completed: a, b, c, +2 more');
    } finally {
      cleanup();
    }
  });

  it('omits Walk continuity line when handoff has no walk fields (graceful)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      createChit(corpRoot, {
        type: 'handoff',
        scope: 'agent:successor',
        createdBy: 'toast',
        body: '',
        fields: {
          handoff: {
            predecessorSession: 'toast-1',
            currentStep: 'chit-t-current',
            completed: ['some prose'],
            nextAction: 'continue',
            // No walk fields.
          },
        },
      });

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'successor',
        displayName: 'Copper',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'successor'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });

      expect(result.header).toContain('Handoff from predecessor session:');
      expect(result.header).not.toContain('Walk continuity');
    } finally {
      cleanup();
    }
  });
});
