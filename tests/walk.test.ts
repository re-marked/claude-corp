import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isWalkTask,
  isAdHocTask,
  getWalkBlueprintName,
  getWalkStepId,
  getWalkPosition,
  getWalkProgress,
  nextSteps,
  previousSteps,
  checkExpectedOutput,
  createChit,
  findChitById,
  type Chit,
  type BlueprintFields,
} from '../packages/shared/src/index.js';

/**
 * Project 2.1 PR 2 — comprehensive coverage for the walk read API +
 * the per-kind ExpectedOutput checkers.
 *
 * Five concerns:
 *   1. Tag-only helpers (pure data inspection on Task chits)
 *   2. getWalkPosition + getWalkProgress + DAG navigation
 *   3. checkExpectedOutput dispatcher + pure-data checkers
 *   4. chit-of-type checker (role expansion, queryChits integration,
 *      ALL-tags filter, claimedAt fallback)
 *   5. Shell-out checkers (real git in tmpdir, real fs)
 *
 * Real git is used for branch-exists + commit-on-branch tests so the
 * checker behavior + safeGitExec helper get end-to-end coverage. The
 * tests assume `git` is in PATH (always true in CI + on Mark's box).
 *
 * Each test creates its own tmpdir corp / git repo to avoid bleeding
 * state across tests. Setup is per-suite via beforeEach / afterEach
 * patterns, but the explicit try/finally style is used here so cleanup
 * runs even when assertions throw.
 */

// ─── Test fixtures ─────────────────────────────────────────────────

function makeCorp(): { corpRoot: string; cleanup: () => void } {
  const corpRoot = mkdtempSync(join(tmpdir(), 'walk-test-'));
  return {
    corpRoot,
    cleanup: () => {
      try {
        rmSync(corpRoot, { recursive: true, force: true });
      } catch {
        // Best-effort on Windows.
      }
    },
  };
}

/** Fixture: minimal walk-tagged task chit shape (not written to disk). */
function fakeWalkTask(overrides: Partial<Chit<'task'>> = {}): Chit<'task'> {
  return {
    id: 'chit-t-walktest1',
    type: 'task',
    status: 'active',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    createdBy: 'test-author',
    tags: ['blueprint:ship-feature', 'blueprint-step:acquire-worktree'],
    fields: {
      task: {
        title: 'Acquire worktree',
        priority: 'normal',
        assignee: 'toast',
      },
    },
    ...overrides,
  } as Chit<'task'>;
}

function fakeAdHocTask(): Chit<'task'> {
  return fakeWalkTask({
    id: 'chit-t-adhoc1',
    tags: [], // Ad-hoc: no walk tags.
  });
}

// ─── 1. Tag-only helpers ───────────────────────────────────────────

describe('isWalkTask / isAdHocTask', () => {
  it('isWalkTask true when both blueprint and blueprint-step tags present', () => {
    expect(isWalkTask(fakeWalkTask())).toBe(true);
  });

  it('isWalkTask false on ad-hoc (no tags)', () => {
    expect(isWalkTask(fakeAdHocTask())).toBe(false);
  });

  it('isWalkTask false when only blueprint tag (missing step)', () => {
    expect(isWalkTask(fakeWalkTask({ tags: ['blueprint:ship-feature'] }))).toBe(false);
  });

  it('isWalkTask false when only step tag (missing blueprint)', () => {
    expect(isWalkTask(fakeWalkTask({ tags: ['blueprint-step:acquire-worktree'] }))).toBe(false);
  });

  it('isAdHocTask is the inverse of isWalkTask', () => {
    expect(isAdHocTask(fakeWalkTask())).toBe(false);
    expect(isAdHocTask(fakeAdHocTask())).toBe(true);
  });
});

describe('getWalkBlueprintName / getWalkStepId', () => {
  it('extracts the suffix from a walk task', () => {
    const t = fakeWalkTask();
    expect(getWalkBlueprintName(t)).toBe('ship-feature');
    expect(getWalkStepId(t)).toBe('acquire-worktree');
  });

  it('returns null for ad-hoc tasks', () => {
    expect(getWalkBlueprintName(fakeAdHocTask())).toBe(null);
    expect(getWalkStepId(fakeAdHocTask())).toBe(null);
  });

  it('first match wins on duplicate tags (defensive)', () => {
    const t = fakeWalkTask({
      tags: ['blueprint:first', 'blueprint:second', 'blueprint-step:s1'],
    });
    expect(getWalkBlueprintName(t)).toBe('first');
  });
});

// ─── 2a. getWalkPosition (real chit store) ─────────────────────────

/**
 * Helper: write a blueprint + contract + tasks triple to a tmpdir corp.
 * Returns the written ids and the underlying chits for assertions.
 */
function seedWalk(
  corpRoot: string,
  opts: {
    blueprintName: string;
    steps: BlueprintFields['steps'];
    blueprintMissing?: boolean; // If true, write blueprint but don't reference from contract.
    contractMissingBlueprintId?: boolean;
    deletedBlueprint?: boolean; // If true, blueprint chit is deleted after contract creation.
  },
): {
  blueprintId: string;
  contractId: string;
  taskIds: string[];
} {
  const blueprint = createChit(corpRoot, {
    type: 'blueprint',
    scope: 'corp',
    createdBy: 'test',
    body: 'test blueprint',
    fields: {
      blueprint: {
        name: opts.blueprintName,
        origin: 'authored',
        steps: opts.steps,
      },
    },
  });

  const taskIds: string[] = [];
  for (const step of opts.steps) {
    const t = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'test',
      body: '',
      tags: [`blueprint:${opts.blueprintName}`, `blueprint-step:${step.id}`],
      fields: {
        task: {
          title: step.title,
          priority: 'normal',
          assignee: 'toast',
        },
      },
    });
    taskIds.push(t.id);
  }

  const contract = createChit(corpRoot, {
    type: 'contract',
    scope: 'corp',
    createdBy: 'test',
    body: '',
    fields: {
      contract: {
        title: 'test contract',
        goal: 'test',
        taskIds,
        blueprintId: opts.contractMissingBlueprintId ? null : blueprint.id,
      },
    },
  });

  // Deleted-blueprint case: remove the blueprint file but keep the
  // contract pointing at it. Simulates "blueprint deleted after cast."
  if (opts.deletedBlueprint) {
    rmSync(join(corpRoot, 'chits', 'blueprint', `${blueprint.id}.md`));
  }

  return { blueprintId: blueprint.id, contractId: contract.id, taskIds };
}

describe('getWalkPosition — happy path', () => {
  it('returns full position for a task in a walk', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const { blueprintId, contractId, taskIds } = seedWalk(corpRoot, {
        blueprintName: 'ship-feature',
        steps: [
          { id: 'a', title: 'Step A' },
          { id: 'b', title: 'Step B', dependsOn: ['a'] },
        ],
      });
      // Read back the second task chit and feed to getWalkPosition.
      const hit = findChitById(corpRoot, taskIds[1]!);
      expect(hit).not.toBeNull();
      const t = hit!.chit as Chit<'task'>;
      const pos = getWalkPosition(t, corpRoot);
      expect(pos).not.toBeNull();
      expect(pos!.blueprintName).toBe('ship-feature');
      expect(pos!.stepId).toBe('b');
      expect(pos!.stepIndex).toBe(2);
      expect(pos!.totalSteps).toBe(2);
      expect(pos!.contract.id).toBe(contractId);
      expect(pos!.blueprint.id).toBe(blueprintId);
    } finally {
      cleanup();
    }
  });

  it('surfaces pre-expanded fields from the task chit (expectedOutput, taskOutput, claimedAt)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Seed a blueprint + contract + ONE task with all the pre-expanded
      // fields populated, then verify getWalkPosition returns them.
      const blueprint = createChit(corpRoot, {
        type: 'blueprint',
        scope: 'corp',
        createdBy: 'test',
        body: '',
        fields: {
          blueprint: {
            name: 'bp',
            origin: 'authored',
            steps: [{ id: 's1', title: 'S' }],
          },
        },
      });
      const expectedSpec = {
        kind: 'tag-on-task' as const,
        tag: 'reviewed',
      };
      const t = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'test',
        body: '',
        tags: ['blueprint:bp', 'blueprint-step:s1'],
        fields: {
          task: {
            title: 'S',
            priority: 'normal',
            assignee: 'toast',
            output: 'shipped the thing',
            claimedAt: '2026-05-01T15:00:00.000Z',
            expectedOutput: expectedSpec,
          },
        },
      });
      createChit(corpRoot, {
        type: 'contract',
        scope: 'corp',
        createdBy: 'test',
        body: '',
        fields: {
          contract: {
            title: 'c',
            goal: 'g',
            taskIds: [t.id],
            blueprintId: blueprint.id,
          },
        },
      });
      const hit = findChitById(corpRoot, t.id);
      const pos = getWalkPosition(hit!.chit as Chit<'task'>, corpRoot);
      expect(pos).not.toBeNull();
      expect(pos!.expectedOutput).toEqual(expectedSpec);
      expect(pos!.taskOutput).toBe('shipped the thing');
      expect(pos!.claimedAt).toBe('2026-05-01T15:00:00.000Z');
    } finally {
      cleanup();
    }
  });
});

describe('cast → Task chit roundtrip — pre-expanded expectedOutput lands on task', () => {
  it('blueprint with templated branchPattern is expanded onto the cast Task chit', async () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Use the real cast pipeline so we exercise parser + cast +
      // chit-write end-to-end. Verifies that a Handlebars-templated
      // expectedOutput field on the blueprint becomes a concrete-
      // string version on every cast Task chit.
      const { castFromBlueprint } = await import('../packages/shared/src/index.js');

      const blueprint = createChit(corpRoot, {
        type: 'blueprint',
        scope: 'corp',
        status: 'active', // Cast requires active blueprints; default is draft.
        createdBy: 'test',
        body: '',
        fields: {
          blueprint: {
            name: 'ship-feature',
            origin: 'authored',
            vars: [{ name: 'feature', type: 'string' }],
            steps: [
              {
                id: 'acquire',
                title: 'Acquire worktree for {{feature}}',
                assigneeRole: 'backend-engineer',
                expectedOutput: {
                  kind: 'branch-exists',
                  branchPattern: 'feat/{{feature}}',
                },
              },
              {
                id: 'submit',
                title: 'Submit clearance for {{feature}}',
                dependsOn: ['acquire'],
                assigneeRole: 'backend-engineer',
                expectedOutput: {
                  kind: 'multi',
                  specs: [
                    {
                      kind: 'chit-of-type',
                      chitType: 'observation',
                      withTags: ['feature:{{feature}}'],
                    },
                    { kind: 'task-output-nonempty' },
                  ],
                },
              },
            ],
          },
        },
      });

      const result = castFromBlueprint(corpRoot, blueprint as Chit<'blueprint'>, {
        feature: 'fire-command',
      }, {
        scope: 'corp',
        createdBy: 'test',
      });

      // First task: acquire-worktree. expectedOutput should have
      // branchPattern with {{feature}} resolved to 'fire-command'.
      const t1 = result.tasks[0]!;
      expect(t1.fields.task.expectedOutput).toEqual({
        kind: 'branch-exists',
        branchPattern: 'feat/fire-command',
      });

      // Second task: submit-clearance. Multi-composed expectedOutput
      // with the inner withTags also expanded.
      const t2 = result.tasks[1]!;
      expect(t2.fields.task.expectedOutput).toEqual({
        kind: 'multi',
        specs: [
          {
            kind: 'chit-of-type',
            chitType: 'observation',
            withTags: ['feature:fire-command'],
          },
          { kind: 'task-output-nonempty' },
        ],
      });
    } finally {
      cleanup();
    }
  });

  it('blueprint step with withTags: null casts cleanly (Codex P1 regression)', async () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // validateExpectedOutput accepts withTags: null on chit-of-type
      // (`!== undefined && !== null` guard). Before the fix,
      // expandExpectedOutput's `!== undefined` check let null through
      // to `null.map(...)` → TypeError, breaking cast on otherwise-
      // validator-accepted blueprints.
      const { castFromBlueprint } = await import('../packages/shared/src/index.js');
      const blueprint = createChit(corpRoot, {
        type: 'blueprint',
        scope: 'corp',
        status: 'active',
        createdBy: 'test',
        body: '',
        fields: {
          blueprint: {
            name: 'null-tags',
            origin: 'authored',
            steps: [
              {
                id: 's1',
                title: 'Step',
                assigneeRole: 'backend-engineer',
                expectedOutput: {
                  kind: 'chit-of-type',
                  chitType: 'observation',
                  withTags: null as unknown as readonly string[],
                },
              },
            ],
          },
        },
      });
      // Cast should succeed without throwing.
      const result = castFromBlueprint(corpRoot, blueprint as Chit<'blueprint'>, {}, {
        scope: 'corp',
        createdBy: 'test',
      });
      const t = result.tasks[0]!;
      const expanded = t.fields.task.expectedOutput as { kind: string; withTags?: unknown };
      expect(expanded.kind).toBe('chit-of-type');
      // Field absent on the expanded result (null source dropped from
      // the spread-conditional, same as undefined source).
      expect(expanded.withTags).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('blueprint step with no expectedOutput → cast Task chit has no expectedOutput field', async () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const { castFromBlueprint } = await import('../packages/shared/src/index.js');
      const blueprint = createChit(corpRoot, {
        type: 'blueprint',
        scope: 'corp',
        status: 'active', // Cast requires active.
        createdBy: 'test',
        body: '',
        fields: {
          blueprint: {
            name: 'no-expected',
            origin: 'authored',
            steps: [
              {
                id: 's1',
                title: 'No expected output declared',
                assigneeRole: 'backend-engineer',
                // No expectedOutput at all.
              },
            ],
          },
        },
      });
      const result = castFromBlueprint(corpRoot, blueprint as Chit<'blueprint'>, {}, {
        scope: 'corp',
        createdBy: 'test',
      });
      const t = result.tasks[0]!;
      // Field absent (spread-conditional in cast — null source step
      // skips the field entirely so existing fixture shapes pass-through).
      expect(t.fields.task.expectedOutput).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe('getWalkPosition — null cases', () => {
  it('null on ad-hoc task (no walk tags)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(getWalkPosition(fakeAdHocTask(), corpRoot)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('null when no contract contains the task (orphan)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Create a task with walk tags but no containing contract.
      const t = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'test',
        body: '',
        tags: ['blueprint:bp', 'blueprint-step:s1'],
        fields: { task: { title: 'orphan', priority: 'normal' } },
      });
      expect(getWalkPosition(t as Chit<'task'>, corpRoot)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('null when contract has no blueprintId', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const { taskIds } = seedWalk(corpRoot, {
        blueprintName: 'bp',
        steps: [{ id: 's1', title: 'Step 1' }],
        contractMissingBlueprintId: true,
      });
      
      const t = findChitById(corpRoot, taskIds[0]!).chit as Chit<'task'>;
      expect(getWalkPosition(t, corpRoot)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('null when blueprint chit is deleted post-cast', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const { taskIds } = seedWalk(corpRoot, {
        blueprintName: 'bp',
        steps: [{ id: 's1', title: 'Step 1' }],
        deletedBlueprint: true,
      });
      
      const t = findChitById(corpRoot, taskIds[0]!).chit as Chit<'task'>;
      expect(getWalkPosition(t, corpRoot)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('null when step id is no longer in the blueprint (post-cast edit)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Seed a walk, then edit the blueprint to remove the step that
      // tasks reference. The simulation: create a task with a tag for
      // a step that doesn't exist in the blueprint we'll create.
      const blueprint = createChit(corpRoot, {
        type: 'blueprint',
        scope: 'corp',
        createdBy: 'test',
        body: '',
        fields: {
          blueprint: {
            name: 'bp',
            origin: 'authored',
            steps: [{ id: 'real-step', title: 'Real step' }],
          },
        },
      });
      const t = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'test',
        body: '',
        tags: ['blueprint:bp', 'blueprint-step:ghost-step'], // ghost-step not in blueprint
        fields: { task: { title: 'Ghost', priority: 'normal' } },
      });
      createChit(corpRoot, {
        type: 'contract',
        scope: 'corp',
        createdBy: 'test',
        body: '',
        fields: {
          contract: {
            title: 'c',
            goal: 'g',
            taskIds: [t.id],
            blueprintId: blueprint.id,
          },
        },
      });
      
      const taskRead = findChitById(corpRoot, t.id).chit as Chit<'task'>;
      expect(getWalkPosition(taskRead, corpRoot)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ─── 2b. getWalkProgress ───────────────────────────────────────────

describe('getWalkProgress', () => {
  it('returns step entries in declaration order with task status', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const { contractId } = seedWalk(corpRoot, {
        blueprintName: 'bp',
        steps: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B', dependsOn: ['a'] },
          { id: 'c', title: 'C', dependsOn: ['b'] },
        ],
      });
      
      const c = findChitById(corpRoot, contractId).chit as Chit<'contract'>;
      const progress = getWalkProgress(c, corpRoot);
      expect(progress).not.toBeNull();
      expect(progress!.totalSteps).toBe(3);
      expect(progress!.steps.map((s) => s.stepId)).toEqual(['a', 'b', 'c']);
      expect(progress!.steps.map((s) => s.stepIndex)).toEqual([1, 2, 3]);
      // Each step has a matching task.
      for (const step of progress!.steps) {
        expect(step.taskId).not.toBeNull();
      }
    } finally {
      cleanup();
    }
  });

  it('returns null for contract without blueprintId', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const { contractId } = seedWalk(corpRoot, {
        blueprintName: 'bp',
        steps: [{ id: 's1', title: 'S' }],
        contractMissingBlueprintId: true,
      });
      
      const c = findChitById(corpRoot, contractId).chit as Chit<'contract'>;
      expect(getWalkProgress(c, corpRoot)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ─── 2c. nextSteps / previousSteps DAG navigation ──────────────────

describe('nextSteps / previousSteps', () => {
  const fanOutBlueprint: BlueprintFields = {
    name: 'fanout',
    origin: 'authored',
    steps: [
      { id: 'root', title: 'Root' },
      { id: 'left', title: 'Left', dependsOn: ['root'] },
      { id: 'right', title: 'Right', dependsOn: ['root'] },
      { id: 'merge', title: 'Merge', dependsOn: ['left', 'right'] },
    ],
  };

  it('nextSteps returns all successors (DAG fan-out)', () => {
    const next = nextSteps(fanOutBlueprint, 'root');
    expect(next.map((s) => s.id).sort()).toEqual(['left', 'right']);
  });

  it('nextSteps empty for terminal step', () => {
    expect(nextSteps(fanOutBlueprint, 'merge')).toEqual([]);
  });

  it('nextSteps empty for unknown step id', () => {
    expect(nextSteps(fanOutBlueprint, 'ghost')).toEqual([]);
  });

  it('previousSteps returns all dependencies (DAG fan-in)', () => {
    const prev = previousSteps(fanOutBlueprint, 'merge');
    expect(prev.map((s) => s.id).sort()).toEqual(['left', 'right']);
  });

  it('previousSteps empty for top-of-chain step', () => {
    expect(previousSteps(fanOutBlueprint, 'root')).toEqual([]);
  });

  it('previousSteps empty for unknown step id', () => {
    expect(previousSteps(fanOutBlueprint, 'ghost')).toEqual([]);
  });
});

// ─── 3. checkExpectedOutput dispatcher + pure-data checkers ────────

describe('checkExpectedOutput — dispatcher', () => {
  const { corpRoot, cleanup } = makeCorp();

  it('vacuous truth on null spec', () => {
    const result = checkExpectedOutput(null, fakeWalkTask(), corpRoot);
    expect(result.status).toBe('met');
    expect((result.evidence as { reason: string }).reason).toMatch(/no expectedOutput/);
  });

  it('dispatches tag-on-task to pure checker', () => {
    const t = fakeWalkTask({ tags: ['blueprint:bp', 'blueprint-step:s1', 'reviewed'] });
    const result = checkExpectedOutput(
      { kind: 'tag-on-task', tag: 'reviewed' },
      t,
      corpRoot,
    );
    expect(result.status).toBe('met');
  });

  cleanup();
});

describe('tag-on-task checker', () => {
  it('met when tag present', () => {
    const r = checkExpectedOutput(
      { kind: 'tag-on-task', tag: 'reviewed' },
      fakeWalkTask({ tags: ['reviewed'] }),
      '/nonexistent',
    );
    expect(r.status).toBe('met');
  });

  it('unmet when tag absent, missing populated', () => {
    const r = checkExpectedOutput(
      { kind: 'tag-on-task', tag: 'reviewed' },
      fakeWalkTask(),
      '/nonexistent',
    );
    expect(r.status).toBe('unmet');
    expect(r.missing).toContain('reviewed');
  });
});

describe('task-output-nonempty checker', () => {
  it('met when output has content', () => {
    const t = fakeWalkTask();
    (t.fields.task as { output?: string | null }).output = 'shipped the thing';
    const r = checkExpectedOutput({ kind: 'task-output-nonempty' }, t, '/nonexistent');
    expect(r.status).toBe('met');
  });

  it('unmet when output is null', () => {
    const r = checkExpectedOutput(
      { kind: 'task-output-nonempty' },
      fakeWalkTask(),
      '/nonexistent',
    );
    expect(r.status).toBe('unmet');
  });

  it('unmet when output is whitespace only', () => {
    const t = fakeWalkTask();
    (t.fields.task as { output?: string | null }).output = '   \n  \t  ';
    const r = checkExpectedOutput({ kind: 'task-output-nonempty' }, t, '/nonexistent');
    expect(r.status).toBe('unmet');
  });
});

describe('multi checker — precedence', () => {
  const t = fakeWalkTask({ tags: ['blueprint:bp', 'blueprint-step:s1', 'always'] });
  const cwd = '/nonexistent';

  it('all sub-checks met → met', () => {
    const r = checkExpectedOutput(
      {
        kind: 'multi',
        specs: [
          { kind: 'tag-on-task', tag: 'always' },
          {
            kind: 'task-output-nonempty',
          },
        ],
      },
      (() => {
        const tt = fakeWalkTask({ tags: ['always'] });
        (tt.fields.task as { output?: string }).output = 'something';
        return tt;
      })(),
      cwd,
    );
    expect(r.status).toBe('met');
  });

  it('any sub unmet → unmet (aggregates missing)', () => {
    const r = checkExpectedOutput(
      {
        kind: 'multi',
        specs: [
          { kind: 'tag-on-task', tag: 'always' }, // met
          { kind: 'tag-on-task', tag: 'never' }, // unmet
          { kind: 'tag-on-task', tag: 'also-never' }, // unmet
        ],
      },
      t,
      cwd,
    );
    expect(r.status).toBe('unmet');
    expect(r.missing).toContain('never');
    expect(r.missing).toContain('also-never');
  });

  it('any sub unable + no unmet → unable propagates', () => {
    // chit-of-type without an assignee on the task → unable.
    const noAssignee = fakeWalkTask();
    delete (noAssignee.fields.task as { assignee?: unknown }).assignee;
    const r = checkExpectedOutput(
      {
        kind: 'multi',
        specs: [
          { kind: 'tag-on-task', tag: 'always' }, // met (after we adjust)
          { kind: 'chit-of-type', chitType: 'task' }, // unable (no assignee)
        ],
      },
      (() => {
        const tt = fakeWalkTask({ tags: ['always'] });
        delete (tt.fields.task as { assignee?: unknown }).assignee;
        return tt;
      })(),
      cwd,
    );
    expect(r.status).toBe('unable-to-check');
  });

  it('mix unable + unmet → unmet wins (definite failure beats no-signal)', () => {
    const noAssignee = fakeWalkTask();
    delete (noAssignee.fields.task as { assignee?: unknown }).assignee;
    const r = checkExpectedOutput(
      {
        kind: 'multi',
        specs: [
          { kind: 'tag-on-task', tag: 'never' }, // unmet
          { kind: 'chit-of-type', chitType: 'task' }, // unable
        ],
      },
      noAssignee,
      cwd,
    );
    expect(r.status).toBe('unmet');
  });

  it('recursive multi — multi-of-multi resolves correctly', () => {
    const tt = fakeWalkTask({ tags: ['inner', 'outer'] });
    const r = checkExpectedOutput(
      {
        kind: 'multi',
        specs: [
          { kind: 'tag-on-task', tag: 'outer' },
          {
            kind: 'multi',
            specs: [
              { kind: 'tag-on-task', tag: 'inner' },
            ],
          },
        ],
      },
      tt,
      cwd,
    );
    expect(r.status).toBe('met');
  });
});

// ─── 4. chit-of-type checker (real chit store + role expansion) ────

describe('chit-of-type checker', () => {
  it('met when chit produced by slot assignee since claimedAt', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Seed a clearance-submission chit produced by 'toast' just now.
      createChit(corpRoot, {
        type: 'observation', // any type works; using observation for simplicity
        scope: 'corp',
        createdBy: 'toast',
        body: '',
        tags: ['task:abc'],
        fields: {
          observation: {
            category: 'NOTICE',
            subject: 'test',
            object: '',
            importance: 1,
          },
        },
      });
      const t = fakeWalkTask();
      (t.fields.task as { assignee?: string }).assignee = 'toast';
      (t.fields.task as { claimedAt?: string }).claimedAt = '2025-01-01T00:00:00.000Z';
      const r = checkExpectedOutput(
        { kind: 'chit-of-type', chitType: 'observation' },
        t,
        corpRoot,
      );
      expect(r.status).toBe('met');
    } finally {
      cleanup();
    }
  });

  it('unmet when no chit matches', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const t = fakeWalkTask();
      (t.fields.task as { assignee?: string }).assignee = 'toast';
      (t.fields.task as { claimedAt?: string }).claimedAt = '2025-01-01T00:00:00.000Z';
      const r = checkExpectedOutput(
        { kind: 'chit-of-type', chitType: 'observation' },
        t,
        corpRoot,
      );
      expect(r.status).toBe('unmet');
    } finally {
      cleanup();
    }
  });

  it('unable-to-check when task has no assignee', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const t = fakeWalkTask();
      delete (t.fields.task as { assignee?: unknown }).assignee;
      const r = checkExpectedOutput(
        { kind: 'chit-of-type', chitType: 'observation' },
        t,
        corpRoot,
      );
      expect(r.status).toBe('unable-to-check');
    } finally {
      cleanup();
    }
  });

  it('withTags filter requires ALL tags present', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Chit has 'task:abc' but missing 'submitter:foo'.
      createChit(corpRoot, {
        type: 'observation',
        scope: 'corp',
        createdBy: 'toast',
        body: '',
        tags: ['task:abc'],
        fields: {
          observation: { category: 'NOTICE', subject: 's', object: '', importance: 1 },
        },
      });
      const t = fakeWalkTask();
      (t.fields.task as { assignee?: string }).assignee = 'toast';
      (t.fields.task as { claimedAt?: string }).claimedAt = '2025-01-01T00:00:00.000Z';
      const r = checkExpectedOutput(
        {
          kind: 'chit-of-type',
          chitType: 'observation',
          withTags: ['task:abc', 'submitter:foo'],
        },
        t,
        corpRoot,
      );
      // ALL tags required; chit only has one → unmet.
      expect(r.status).toBe('unmet');
    } finally {
      cleanup();
    }
  });

  it('role expansion — assignee is role-id; matches any member of that role', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Seed members.json so backend-engineer role expands to [toast, copper].
      writeFileSync(
        join(corpRoot, 'members.json'),
        JSON.stringify([
          { id: 'toast', displayName: 'Toast', rank: 'worker', role: 'backend-engineer' },
          { id: 'copper', displayName: 'Copper', rank: 'worker', role: 'backend-engineer' },
          { id: 'unrelated', displayName: 'Unrelated', rank: 'worker', role: 'frontend-engineer' },
        ]),
      );
      // Create a chit produced by 'copper' (a member of backend-engineer role).
      // Old createdAt to be safely after the test task's createdAt.
      createChit(corpRoot, {
        type: 'observation',
        scope: 'corp',
        createdBy: 'copper',
        body: '',
        fields: {
          observation: { category: 'NOTICE', subject: 's', object: '', importance: 1 },
        },
      });
      // Task assignee is the ROLE, not a slot. Role expansion should
      // accept chits created by any backend-engineer member.
      const t = fakeWalkTask({
        createdAt: '2025-01-01T00:00:00.000Z',
      });
      (t.fields.task as { assignee?: string }).assignee = 'backend-engineer';
      (t.fields.task as { claimedAt?: string }).claimedAt = '2025-01-01T00:00:00.000Z';
      const r = checkExpectedOutput(
        { kind: 'chit-of-type', chitType: 'observation' },
        t,
        corpRoot,
      );
      expect(r.status).toBe('met');
      // Evidence should reflect the role-expanded creator set.
      const evidence = r.evidence as { query: { createdBy: string[] } };
      expect(evidence.query.createdBy).toEqual(expect.arrayContaining(['toast', 'copper']));
      expect(evidence.query.createdBy).not.toContain('unrelated');
    } finally {
      cleanup();
    }
  });

  it('role expansion — malformed members.json → unmet, not crash (Codex P2 regression)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // readConfigOr throws on malformed JSON (missing-only fallback,
      // not malformed-fallback). Before the fix, the throw propagated
      // out of checkChitOfType into audit, crashing the gate for
      // role-assigned tasks whenever members.json got corrupted
      // (mid-write race, partial backup restore, manual edit). The
      // try/catch in readMembersWithRole catches and treats as empty
      // pool — operator sees honest unmet vs hard stack trace.
      writeFileSync(
        join(corpRoot, 'members.json'),
        '{ this is { not [ valid JSON',
      );
      const t = fakeWalkTask();
      (t.fields.task as { assignee?: string }).assignee = 'backend-engineer';
      (t.fields.task as { claimedAt?: string }).claimedAt = '2025-01-01T00:00:00.000Z';
      // Should NOT throw. Should return unmet (empty pool fallback).
      const r = checkExpectedOutput(
        { kind: 'chit-of-type', chitType: 'observation' },
        t,
        corpRoot,
      );
      expect(r.status).toBe('unmet');
    } finally {
      cleanup();
    }
  });

  it('role expansion — role with no current members → unmet (honest, not unable)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // members.json has no backend-engineer entries.
      writeFileSync(
        join(corpRoot, 'members.json'),
        JSON.stringify([
          { id: 'unrelated', displayName: 'Unrelated', rank: 'worker', role: 'frontend-engineer' },
        ]),
      );
      const t = fakeWalkTask();
      (t.fields.task as { assignee?: string }).assignee = 'backend-engineer';
      (t.fields.task as { claimedAt?: string }).claimedAt = '2025-01-01T00:00:00.000Z';
      const r = checkExpectedOutput(
        { kind: 'chit-of-type', chitType: 'observation' },
        t,
        corpRoot,
      );
      // Empty role pool → check FIRED, answer is "no, no members" → unmet.
      // (Critically: NOT unable-to-check; the check ran successfully and
      // discovered "no possible matches because pool is empty.")
      expect(r.status).toBe('unmet');
    } finally {
      cleanup();
    }
  });

  it('claimedAt fallback to taskChit.createdAt when claimedAt is null', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Create a chit AFTER the task (its createdAt becomes the fallback boundary).
      const t = fakeWalkTask({
        createdAt: '2026-05-01T10:00:00.000Z',
      });
      (t.fields.task as { assignee?: string }).assignee = 'toast';
      delete (t.fields.task as { claimedAt?: unknown }).claimedAt;
      // Sleep is unnecessary; the createChit timestamp will be > task.createdAt.
      createChit(corpRoot, {
        type: 'observation',
        scope: 'corp',
        createdBy: 'toast',
        body: '',
        fields: {
          observation: { category: 'NOTICE', subject: 's', object: '', importance: 1 },
        },
      });
      const r = checkExpectedOutput(
        { kind: 'chit-of-type', chitType: 'observation' },
        t,
        corpRoot,
      );
      // The chit was created after task.createdAt, so falls within the
      // fallback boundary → met.
      expect(r.status).toBe('met');
    } finally {
      cleanup();
    }
  });
});

// ─── 5. Shell-out checkers (real git in tmpdir) ────────────────────

/**
 * Spin up a real git repo in a tmpdir for shell-out tests. Each test
 * gets its own — git init is fast, isolation matters more than reuse.
 */
function makeGitRepo(): { repo: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), 'walk-git-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, stdio: 'ignore' });
  // Initial commit so the repo has HEAD.
  writeFileSync(join(repo, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  return {
    repo,
    cleanup: () => {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    },
  };
}

describe('branch-exists checker', () => {
  it('met when branch matches', () => {
    const { repo, cleanup } = makeGitRepo();
    try {
      execFileSync('git', ['checkout', '-b', 'feat/walks'], { cwd: repo, stdio: 'ignore' });
      const r = checkExpectedOutput(
        { kind: 'branch-exists', branchPattern: 'feat/walks' },
        fakeWalkTask(),
        repo,
        { cwd: repo },
      );
      expect(r.status).toBe('met');
    } finally {
      cleanup();
    }
  });

  it('unmet when branch absent', () => {
    const { repo, cleanup } = makeGitRepo();
    try {
      const r = checkExpectedOutput(
        { kind: 'branch-exists', branchPattern: 'feat/ghost' },
        fakeWalkTask(),
        repo,
        { cwd: repo },
      );
      expect(r.status).toBe('unmet');
    } finally {
      cleanup();
    }
  });

  it('unable-to-check when cwd is not a git repository', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'walk-notrepo-'));
    try {
      const r = checkExpectedOutput(
        { kind: 'branch-exists', branchPattern: 'main' },
        fakeWalkTask(),
        notRepo,
        { cwd: notRepo },
      );
      expect(r.status).toBe('unable-to-check');
      expect(r.reason).toMatch(/not (?:a |inside a )git repository/i);
    } finally {
      try {
        rmSync(notRepo, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('unable-to-check when cwd is outside corpRoot (ceiling enforced)', () => {
    const { repo, cleanup } = makeGitRepo();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'walk-outside-'));
    try {
      // cwd is outside the corpRoot ceiling. findGitRoot rejects
      // cwd-outside-ceiling immediately so a misrouted audit caller
      // can't pick up an unrelated parent .git tree.
      const r = checkExpectedOutput(
        { kind: 'branch-exists', branchPattern: 'main' },
        fakeWalkTask(),
        repo, // corpRoot
        { cwd: outsideRoot }, // cwd outside corpRoot
      );
      expect(r.status).toBe('unable-to-check');
    } finally {
      cleanup();
      try {
        rmSync(outsideRoot, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('runs against a subdirectory of a git repo (Codex P2 regression)', () => {
    const { repo, cleanup } = makeGitRepo();
    try {
      execFileSync('git', ['checkout', '-b', 'feat/walks'], { cwd: repo, stdio: 'ignore' });
      // Create a subdirectory inside the repo and pass IT as cwd.
      // Earlier .git sentinel check (`existsSync(join(cwd, '.git'))`)
      // only matched the repo root; this subdir would have falsely
      // returned unable-to-check, downgrading audit enforcement.
      // findGitRoot walks UP from cwd, finds the .git ancestor, and
      // the check proceeds normally.
      const subdir = join(repo, 'packages', 'deep', 'nested');
      mkdirSync(subdir, { recursive: true });
      const r = checkExpectedOutput(
        { kind: 'branch-exists', branchPattern: 'feat/walks' },
        fakeWalkTask(),
        repo,
        { cwd: subdir },
      );
      expect(r.status).toBe('met');
    } finally {
      cleanup();
    }
  });

  it('commit-on-branch also runs against a subdirectory of a git repo (Codex P2 regression)', () => {
    const { repo, cleanup } = makeGitRepo();
    try {
      const subdir = join(repo, 'packages', 'shared');
      mkdirSync(subdir, { recursive: true });
      const t = fakeWalkTask();
      (t.fields.task as { claimedAt?: string }).claimedAt = '2000-01-01T00:00:00.000Z';
      const r = checkExpectedOutput(
        { kind: 'commit-on-branch', branchPattern: 'main' },
        t,
        repo,
        { cwd: subdir },
      );
      expect(r.status).toBe('met');
    } finally {
      cleanup();
    }
  });

  it('unable-to-check when cwd does not exist', () => {
    const r = checkExpectedOutput(
      { kind: 'branch-exists', branchPattern: 'main' },
      fakeWalkTask(),
      '/definitely/not/a/real/path',
      { cwd: '/definitely/not/a/real/path' },
    );
    expect(r.status).toBe('unable-to-check');
    expect(r.reason).toMatch(/cwd does not exist/i);
  });
});

describe('commit-on-branch checker', () => {
  it('met when commits exist on branch', () => {
    const { repo, cleanup } = makeGitRepo();
    try {
      const t = fakeWalkTask();
      (t.fields.task as { claimedAt?: string }).claimedAt = '2000-01-01T00:00:00.000Z'; // very old
      const r = checkExpectedOutput(
        { kind: 'commit-on-branch', branchPattern: 'main' },
        t,
        repo,
        { cwd: repo },
      );
      expect(r.status).toBe('met');
    } finally {
      cleanup();
    }
  });

  it('unmet when no commits since claim boundary', () => {
    const { repo, cleanup } = makeGitRepo();
    try {
      const t = fakeWalkTask();
      // Future claim date → no commits since.
      (t.fields.task as { claimedAt?: string }).claimedAt = '2099-01-01T00:00:00.000Z';
      const r = checkExpectedOutput(
        { kind: 'commit-on-branch', branchPattern: 'main' },
        t,
        repo,
        { cwd: repo },
      );
      expect(r.status).toBe('unmet');
    } finally {
      cleanup();
    }
  });

  it('met regardless of claim when sinceClaim=false', () => {
    const { repo, cleanup } = makeGitRepo();
    try {
      const t = fakeWalkTask();
      (t.fields.task as { claimedAt?: string }).claimedAt = '2099-01-01T00:00:00.000Z';
      const r = checkExpectedOutput(
        { kind: 'commit-on-branch', branchPattern: 'main', sinceClaim: false },
        t,
        repo,
        { cwd: repo },
      );
      expect(r.status).toBe('met');
    } finally {
      cleanup();
    }
  });

  it('unmet when branch does not exist', () => {
    const { repo, cleanup } = makeGitRepo();
    try {
      const r = checkExpectedOutput(
        { kind: 'commit-on-branch', branchPattern: 'feat/ghost' },
        fakeWalkTask(),
        repo,
        { cwd: repo },
      );
      expect(r.status).toBe('unmet');
    } finally {
      cleanup();
    }
  });
});

describe('file-exists checker', () => {
  it('met when file is present at the resolved path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-fs-'));
    try {
      mkdirSync(join(dir, 'notes'), { recursive: true });
      writeFileSync(join(dir, 'notes', 'welcome.md'), 'hello\n');
      const r = checkExpectedOutput(
        { kind: 'file-exists', pathPattern: 'notes/welcome.md' },
        fakeWalkTask(),
        dir,
        { cwd: dir },
      );
      expect(r.status).toBe('met');
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('unmet when file is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-fs-'));
    try {
      const r = checkExpectedOutput(
        { kind: 'file-exists', pathPattern: 'notes/welcome.md' },
        fakeWalkTask(),
        dir,
        { cwd: dir },
      );
      expect(r.status).toBe('unmet');
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  });

  it('unable-to-check when cwd does not exist', () => {
    const r = checkExpectedOutput(
      { kind: 'file-exists', pathPattern: 'foo' },
      fakeWalkTask(),
      '/definitely/not/a/real/path',
      { cwd: '/definitely/not/a/real/path' },
    );
    expect(r.status).toBe('unable-to-check');
    expect(r.reason).toMatch(/cwd does not exist/i);
  });
});
