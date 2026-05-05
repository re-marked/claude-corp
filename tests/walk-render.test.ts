import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderWalkPositionBlock,
  buildWtfOutput,
  createChit,
  type Chit,
  type WalkPosition,
  type WalkProgress,
  type WalkStep,
  type BlueprintFields,
} from '../packages/shared/src/index.js';
import { buildWtfHeader } from '../packages/shared/src/templates/wtf-header.js';

/**
 * Project 2.2.1 — coverage for walk-render + wtf-header + wtf-state
 * orchestrator wiring. Three concerns:
 *
 *   1. Pure renderer (renderWalkPositionBlock) — three rendering
 *      states, DAG fan-in/fan-out, all task-status verbs on prev /
 *      next sub-lines, age formatting.
 *   2. Template integration (buildWtfHeader with walkBlock opt) —
 *      walk block appears above current-task; absent block doesn't
 *      leak structure.
 *   3. End-to-end via buildWtfOutput — orchestrator reads casket →
 *      task → walk → renders block. Real fixtures, no mocks.
 */

// ─── Test fixtures ─────────────────────────────────────────────────

function makeCorp(): { corpRoot: string; cleanup: () => void } {
  const corpRoot = mkdtempSync(join(tmpdir(), 'walk-render-'));
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

const FIXED_NOW = new Date('2026-05-02T15:00:00.000Z');

/**
 * Build a synthetic WalkPosition without writing to disk. Lets the
 * pure renderer be tested in isolation; integration tests use real
 * chit fixtures via createChit + getWalkPosition.
 */
function fakeWalkPosition(overrides: Partial<WalkPosition> = {}): WalkPosition {
  const blueprintChit: Chit<'blueprint'> = {
    id: 'chit-b-walk',
    type: 'blueprint',
    status: 'active',
    createdAt: '2026-05-02T14:46:00.000Z', // 14m ago vs FIXED_NOW
    updatedAt: '2026-05-02T14:46:00.000Z',
    createdBy: 'ceo',
    tags: [],
    fields: {
      blueprint: {
        name: 'ship-feature',
        origin: 'authored',
        steps: [
          { id: 'pick-up-task', title: 'Pick up' },
          { id: 'acquire-worktree', title: 'Acquire worktree', dependsOn: ['pick-up-task'] },
          { id: 'implement', title: 'Implement', dependsOn: ['acquire-worktree'] },
        ],
      },
    },
  } as Chit<'blueprint'>;

  const contractChit: Chit<'contract'> = {
    id: 'chit-c-walk',
    type: 'contract',
    status: 'active',
    createdAt: '2026-05-02T14:46:00.000Z', // 14m ago
    updatedAt: '2026-05-02T14:46:00.000Z',
    createdBy: 'ceo',
    tags: [],
    fields: {
      contract: {
        title: 'Ship the feature',
        goal: 'g',
        taskIds: ['chit-t-1', 'chit-t-2', 'chit-t-3'],
        blueprintId: 'chit-b-walk',
      },
    },
  } as Chit<'contract'>;

  return {
    blueprintName: 'ship-feature',
    stepId: 'acquire-worktree',
    stepIndex: 2,
    totalSteps: 3,
    step: blueprintChit.fields.blueprint.steps[1]!,
    contract: contractChit,
    blueprint: blueprintChit,
    expectedOutput: { kind: 'task-output-nonempty' },
    taskOutput: null,
    claimedAt: null,
    ...overrides,
  };
}

function fakeWalkProgress(overrides: Partial<WalkProgress> = {}): WalkProgress {
  const stepEntries: WalkStep[] = [
    {
      stepId: 'pick-up-task',
      stepIndex: 1,
      step: { id: 'pick-up-task', title: 'Pick up' },
      taskId: 'chit-t-1',
      taskStatus: 'completed',
      taskTitle: 'Pick up',
      taskUpdatedAt: '2026-05-02T14:46:00.000Z',
      taskAssignee: 'toast', // 14m ago
    },
    {
      stepId: 'acquire-worktree',
      stepIndex: 2,
      step: { id: 'acquire-worktree', title: 'Acquire', dependsOn: ['pick-up-task'] },
      taskId: 'chit-t-2',
      taskStatus: 'in_progress',
      taskTitle: 'Acquire',
      taskUpdatedAt: '2026-05-02T14:55:00.000Z',
      taskAssignee: 'toast',
    },
    {
      stepId: 'implement',
      stepIndex: 3,
      step: { id: 'implement', title: 'Implement', dependsOn: ['acquire-worktree'] },
      taskId: 'chit-t-3',
      taskStatus: 'queued',
      taskTitle: 'Implement',
      taskUpdatedAt: '2026-05-02T14:55:00.000Z',
      taskAssignee: 'toast',
    },
  ];
  return {
    blueprintName: 'ship-feature',
    totalSteps: 3,
    steps: stepEntries,
    contract: {} as Chit<'contract'>,
    blueprint: {} as Chit<'blueprint'>,
    ...overrides,
  };
}

// ─── 1. Renderer — ad-hoc rendering state ─────────────────────────

describe('renderWalkPositionBlock — ad-hoc', () => {
  it('returns one-liner when walkPos is null', () => {
    const out = renderWalkPositionBlock({
      walkPos: null,
      walkProgress: null,
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toBe(
      'Walk: ad-hoc (no blueprint) — single-step task, no walk-aware audit will fire on this work.',
    );
  });

  it('one-liner contains no newlines (single-line invariant)', () => {
    const out = renderWalkPositionBlock({
      walkPos: null,
      walkProgress: null,
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).not.toContain('\n');
  });
});

// ─── 2. Renderer — walk-shaped + full spec ────────────────────────

describe('renderWalkPositionBlock — walk-shaped + full spec', () => {
  it('renders walk header line with name + cast age + author', () => {
    const out = renderWalkPositionBlock({
      walkPos: fakeWalkPosition(),
      walkProgress: fakeWalkProgress(),
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toMatch(/^Walk: ship-feature {2}\(cast 14m ago by ceo\)$/m);
  });

  it('renders current-step line with id + index/total — no audit-degraded tag when expectedOutput is set', () => {
    const out = renderWalkPositionBlock({
      walkPos: fakeWalkPosition(),
      walkProgress: fakeWalkProgress(),
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toMatch(/Current step: acquire-worktree {2}\(step 2 of 3\)$/m);
    expect(out).not.toContain('audit-degraded');
  });

  it('renders Previous line for steps with dependencies (with "by you" attribution when assignee matches currentSlug)', () => {
    const out = renderWalkPositionBlock({
      walkPos: fakeWalkPosition(),
      walkProgress: fakeWalkProgress(),
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toContain('  Previous: pick-up-task — completed by you,');
  });

  it('renders Previous line WITHOUT "by you" when assignee differs from currentSlug', () => {
    const out = renderWalkPositionBlock({
      walkPos: fakeWalkPosition(),
      walkProgress: fakeWalkProgress(),
      currentSlug: 'someone-else',
      now: FIXED_NOW,
    });
    expect(out).toContain('  Previous: pick-up-task — completed,');
    expect(out).not.toContain('by you');
  });

  it('renders Next line with downstream step status', () => {
    const out = renderWalkPositionBlock({
      walkPos: fakeWalkPosition(),
      walkProgress: fakeWalkProgress(),
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toContain('  Next: implement → blocked on this step');
  });
});

// ─── 3. Renderer — walk-shaped + audit-degraded ───────────────────

describe('renderWalkPositionBlock — walk-shaped + audit-degraded', () => {
  it('appends audit-degraded tag to current-step line when expectedOutput is null', () => {
    const out = renderWalkPositionBlock({
      walkPos: fakeWalkPosition({ expectedOutput: null }),
      walkProgress: fakeWalkProgress(),
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toMatch(/Current step: acquire-worktree.*audit-degraded \(no expectedOutput on this step\)/);
  });

  it('walk header line still shows even with audit-degraded current step', () => {
    const out = renderWalkPositionBlock({
      walkPos: fakeWalkPosition({ expectedOutput: null }),
      walkProgress: fakeWalkProgress(),
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toMatch(/^Walk: ship-feature/m);
  });

  it('Previous + Next lines still render with audit-degraded current step', () => {
    const out = renderWalkPositionBlock({
      walkPos: fakeWalkPosition({ expectedOutput: null }),
      walkProgress: fakeWalkProgress(),
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toContain('  Previous: pick-up-task');
    expect(out).toContain('  Next: implement');
  });
});

// ─── 4. Renderer — DAG fan-out / fan-in ───────────────────────────

describe('renderWalkPositionBlock — DAG fan-out / fan-in', () => {
  it('renders multiple Next entries on fan-out (semicolon-separated)', () => {
    const fanOut = fakeWalkProgress({
      steps: [
        {
          stepId: 'root',
          stepIndex: 1,
          step: { id: 'root', title: 'Root' },
          taskId: 'chit-t-r',
          taskStatus: 'in_progress',
          taskTitle: 'Root',
          taskUpdatedAt: '2026-05-02T14:55:00.000Z',
      taskAssignee: 'toast',
        },
        {
          stepId: 'left',
          stepIndex: 2,
          step: { id: 'left', title: 'Left', dependsOn: ['root'] },
          taskId: 'chit-t-l',
          taskStatus: 'queued',
          taskTitle: 'Left',
          taskUpdatedAt: '2026-05-02T14:55:00.000Z',
      taskAssignee: 'toast',
        },
        {
          stepId: 'right',
          stepIndex: 3,
          step: { id: 'right', title: 'Right', dependsOn: ['root'] },
          taskId: 'chit-t-rt',
          taskStatus: 'queued',
          taskTitle: 'Right',
          taskUpdatedAt: '2026-05-02T14:55:00.000Z',
      taskAssignee: 'toast',
        },
      ],
    });
    const walkPos = fakeWalkPosition({
      stepId: 'root',
      stepIndex: 1,
      totalSteps: 3,
      step: { id: 'root', title: 'Root' },
    });
    const out = renderWalkPositionBlock({
      walkPos,
      walkProgress: fanOut,
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toContain('Next: left → blocked on this step; right → blocked on this step');
  });

  it('renders multiple Previous entries on fan-in', () => {
    const fanIn = fakeWalkProgress({
      steps: [
        {
          stepId: 'a',
          stepIndex: 1,
          step: { id: 'a', title: 'A' },
          taskId: 'chit-t-a',
          taskStatus: 'completed',
          taskTitle: 'A',
          taskUpdatedAt: '2026-05-02T14:46:00.000Z',
      taskAssignee: 'toast',
        },
        {
          stepId: 'b',
          stepIndex: 2,
          step: { id: 'b', title: 'B' },
          taskId: 'chit-t-b',
          taskStatus: 'completed',
          taskTitle: 'B',
          taskUpdatedAt: '2026-05-02T14:46:00.000Z',
      taskAssignee: 'toast',
        },
        {
          stepId: 'merge',
          stepIndex: 3,
          step: { id: 'merge', title: 'Merge', dependsOn: ['a', 'b'] },
          taskId: 'chit-t-m',
          taskStatus: 'in_progress',
          taskTitle: 'Merge',
          taskUpdatedAt: '2026-05-02T14:55:00.000Z',
      taskAssignee: 'toast',
        },
      ],
    });
    const walkPos = fakeWalkPosition({
      stepId: 'merge',
      stepIndex: 3,
      totalSteps: 3,
      step: { id: 'merge', title: 'Merge', dependsOn: ['a', 'b'] },
    });
    const out = renderWalkPositionBlock({
      walkPos,
      walkProgress: fanIn,
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toContain('Previous: a — completed');
    expect(out).toContain('b — completed');
  });

  it('truncates Previous list with "+N more" when over cap', () => {
    const wideSteps: WalkStep[] = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({
      stepId: id,
      stepIndex: i + 1,
      step: { id, title: id.toUpperCase() },
      taskId: `chit-t-${id}`,
      taskStatus: 'completed' as const,
      taskTitle: id.toUpperCase(),
      taskUpdatedAt: '2026-05-02T14:46:00.000Z',
      taskAssignee: 'toast',
    }));
    const fanIn = fakeWalkProgress({
      steps: [
        ...wideSteps,
        {
          stepId: 'merge',
          stepIndex: 6,
          step: { id: 'merge', title: 'Merge', dependsOn: ['a', 'b', 'c', 'd', 'e'] },
          taskId: 'chit-t-m',
          taskStatus: 'in_progress',
          taskTitle: 'Merge',
          taskUpdatedAt: '2026-05-02T14:55:00.000Z',
      taskAssignee: 'toast',
        },
      ],
    });
    const walkPos = fakeWalkPosition({
      stepId: 'merge',
      stepIndex: 6,
      totalSteps: 6,
      step: { id: 'merge', title: 'Merge', dependsOn: ['a', 'b', 'c', 'd', 'e'] },
    });
    const out = renderWalkPositionBlock({
      walkPos,
      walkProgress: fanIn,
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    // First 3 shown, +2 more.
    expect(out).toContain('+2 more');
  });
});

// ─── 5. Renderer — terminal / top-of-chain ────────────────────────

describe('renderWalkPositionBlock — chain edges', () => {
  it('omits Previous line for top-of-chain step (no dependsOn)', () => {
    const walkPos = fakeWalkPosition({
      stepId: 'pick-up-task',
      stepIndex: 1,
      step: { id: 'pick-up-task', title: 'Pick up' }, // no dependsOn
    });
    const out = renderWalkPositionBlock({
      walkPos,
      walkProgress: fakeWalkProgress(),
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).not.toContain('Previous:');
    expect(out).toContain('Next:');
  });

  it('omits Next line for terminal step (no successors)', () => {
    const walkPos = fakeWalkPosition({
      stepId: 'implement',
      stepIndex: 3,
      step: { id: 'implement', title: 'Implement', dependsOn: ['acquire-worktree'] },
    });
    const out = renderWalkPositionBlock({
      walkPos,
      walkProgress: fakeWalkProgress(),
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toContain('Previous:');
    expect(out).not.toContain('Next:');
  });
});

// ─── 6. Renderer — task status framing ────────────────────────────

describe('renderWalkPositionBlock — task status framing', () => {
  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['rejected', 'rejected'],
    ['cancelled', 'cancelled'],
    ['in_progress', 'in-progress'],
    ['under_review', 'under review'],
    ['blocked', 'blocked'],
    ['clearance', 'in clearance'],
  ] as const)('Previous: status "%s" renders as "%s"', (status, expected) => {
    const progress = fakeWalkProgress({
      steps: [
        {
          stepId: 'a',
          stepIndex: 1,
          step: { id: 'a', title: 'A' },
          taskId: 'chit-t-a',
          taskStatus: status,
          taskTitle: 'A',
          taskUpdatedAt: '2026-05-02T14:46:00.000Z',
      taskAssignee: 'toast',
        },
        {
          stepId: 'b',
          stepIndex: 2,
          step: { id: 'b', title: 'B', dependsOn: ['a'] },
          taskId: 'chit-t-b',
          taskStatus: 'in_progress',
          taskTitle: 'B',
          taskUpdatedAt: '2026-05-02T14:55:00.000Z',
      taskAssignee: 'toast',
        },
      ],
    });
    const walkPos = fakeWalkPosition({
      stepId: 'b',
      stepIndex: 2,
      step: { id: 'b', title: 'B', dependsOn: ['a'] },
    });
    const out = renderWalkPositionBlock({
      walkPos,
      walkProgress: progress,
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toContain(`a — ${expected}`);
  });

  it('Next: status "queued" renders as "blocked on this step"', () => {
    const out = renderWalkPositionBlock({
      walkPos: fakeWalkPosition(),
      walkProgress: fakeWalkProgress(), // implement is queued
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toContain('implement → blocked on this step');
  });
});

// ─── 7. Renderer — when walkProgress is null ──────────────────────

describe('renderWalkPositionBlock — degraded walkProgress', () => {
  it('renders walk + current-step lines when walkProgress is null (no Previous/Next)', () => {
    const out = renderWalkPositionBlock({
      walkPos: fakeWalkPosition(),
      walkProgress: null,
      currentSlug: 'toast',
      now: FIXED_NOW,
    });
    expect(out).toMatch(/^Walk: ship-feature/m);
    expect(out).toContain('Current step: acquire-worktree');
    expect(out).not.toContain('Previous:');
    expect(out).not.toContain('Next:');
  });
});

// ─── 8. Template integration — buildWtfHeader ─────────────────────

describe('buildWtfHeader — walkBlock integration', () => {
  it('renders walkBlock above currentTaskBlock when present', () => {
    const out = buildWtfHeader({
      kind: 'employee',
      displayName: 'Toast',
      role: 'Backend Engineer',
      workspacePath: '/workspace',
      corpMdPath: '/workspace/CORP.md',
      generatedAt: '2026-05-02T15:00:00.000Z',
      currentTask: { chitId: 'chit-t-abc', title: 'Acquire worktree' },
      walkBlock: 'Walk: ship-feature  (cast 14m ago by ceo)\nCurrent step: acquire-worktree',
      inboxSummary: { tier3Count: 0, tier2Count: 0, tier1Count: 0 },
    });
    const walkIdx = out.indexOf('Walk: ship-feature');
    const taskIdx = out.indexOf('Current task: chit-t-abc');
    expect(walkIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(walkIdx).toBeLessThan(taskIdx);
  });

  it('skips walkBlock section when absent (header has no walk content)', () => {
    const out = buildWtfHeader({
      kind: 'employee',
      displayName: 'Toast',
      role: 'Backend Engineer',
      workspacePath: '/workspace',
      corpMdPath: '/workspace/CORP.md',
      generatedAt: '2026-05-02T15:00:00.000Z',
      currentTask: { chitId: 'chit-t-abc', title: 'Acquire worktree' },
      inboxSummary: { tier3Count: 0, tier2Count: 0, tier1Count: 0 },
    });
    expect(out).not.toContain('Walk:');
    expect(out).toContain('Current task: chit-t-abc');
  });

  it('skips walkBlock section when explicitly empty string', () => {
    const out = buildWtfHeader({
      kind: 'employee',
      displayName: 'Toast',
      role: 'Backend Engineer',
      workspacePath: '/workspace',
      corpMdPath: '/workspace/CORP.md',
      generatedAt: '2026-05-02T15:00:00.000Z',
      currentTask: { chitId: 'chit-t-abc', title: 'Acquire worktree' },
      walkBlock: '   \n  ',
      inboxSummary: { tier3Count: 0, tier2Count: 0, tier1Count: 0 },
    });
    expect(out).not.toContain('Walk:');
  });
});

// ─── 9. End-to-end — buildWtfOutput orchestrator ──────────────────

/**
 * End-to-end: write a real corp on disk with a casket pointing at a
 * task chit, then call buildWtfOutput and verify the walk block
 * appears in the rendered header.
 */
describe('buildWtfOutput — walk block end-to-end', () => {
  it('renders walk block in header when agent is on a walk-shaped task', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Seed a blueprint + contract + task triple.
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
            ],
          },
        },
      });
      const t1 = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'toast',
        body: '',
        tags: ['blueprint:ship-feature', 'blueprint-step:pick-up-task'],
        fields: {
          task: {
            title: 'Pick up',
            priority: 'normal',
            assignee: 'toast',
            workflowStatus: 'completed',
          },
        },
      });
      const t2 = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'toast',
        body: '',
        tags: ['blueprint:ship-feature', 'blueprint-step:acquire-worktree'],
        fields: {
          task: {
            title: 'Acquire',
            priority: 'normal',
            assignee: 'toast',
            workflowStatus: 'in_progress',
          },
        },
      });
      createChit(corpRoot, {
        type: 'contract',
        scope: 'corp',
        createdBy: 'ceo',
        body: '',
        fields: {
          contract: {
            title: 'Ship the feature',
            goal: 'g',
            taskIds: [t1.id, t2.id],
            blueprintId: blueprint.id,
          },
        },
      });
      // Write a casket pointing at t2 (the in-progress task).
      createChit(corpRoot, {
        type: 'casket',
        id: 'casket-toast',
        scope: 'agent:toast',
        createdBy: 'toast',
        body: '',
        fields: {
          casket: { currentStep: t2.id },
        },
      });

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'toast',
        displayName: 'Toast',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'toast'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });

      expect(result.header).toContain('Walk: ship-feature');
      expect(result.header).toContain('Current step: acquire-worktree');
      expect(result.header).toContain('Previous: pick-up-task');
      // Walk block appears above the current-task line.
      const walkIdx = result.header.indexOf('Walk: ship-feature');
      const taskIdx = result.header.indexOf(`Current task: ${t2.id}`);
      expect(walkIdx).toBeGreaterThan(-1);
      expect(taskIdx).toBeGreaterThan(-1);
      expect(walkIdx).toBeLessThan(taskIdx);
    } finally {
      cleanup();
    }
  });

  it('renders ad-hoc one-liner when current task has no walk linkage', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Task with no walk tags + no containing contract.
      const t = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'toast',
        body: '',
        fields: {
          task: { title: 'Adhoc task', priority: 'normal', assignee: 'toast' },
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

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'toast',
        displayName: 'Toast',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'toast'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });

      expect(result.header).toContain('Walk: ad-hoc (no blueprint)');
      expect(result.header).toContain(`Current task: ${t.id}`);
    } finally {
      cleanup();
    }
  });

  it('omits walk block when no current task (Casket idle)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Casket exists but has null currentStep.
      createChit(corpRoot, {
        type: 'casket',
        id: 'casket-toast',
        scope: 'agent:toast',
        createdBy: 'toast',
        body: '',
        fields: { casket: { currentStep: null } },
      });

      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'toast',
        displayName: 'Toast',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'toast'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });

      expect(result.header).not.toContain('Walk:');
      expect(result.header).toContain('Current task: none');
    } finally {
      cleanup();
    }
  });

  it('omits walk block when casket missing entirely (fresh agent)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // No casket at all.
      const result = buildWtfOutput({
        corpRoot,
        corpName: 'test-corp',
        agentSlug: 'fresh',
        displayName: 'Fresh',
        rank: 'worker',
        kind: 'employee',
        roleId: 'backend-engineer',
        workspacePath: join(corpRoot, 'agents', 'fresh'),
        generatedAt: '2026-05-02T15:00:00.000Z',
        now: new Date('2026-05-02T15:00:00.000Z'),
        consumeHandoff: false,
      });
      expect(result.header).not.toContain('Walk:');
      expect(result.header).toContain('Current task: none');
    } finally {
      cleanup();
    }
  });
});
