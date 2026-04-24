import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  findChitById,
  castFromBlueprint,
  BlueprintCastError,
  BlueprintParseError,
  BlueprintVarError,
  type Chit,
  type BlueprintFields,
} from '../packages/shared/src/index.js';

/**
 * Project 1.8 PR 2 — integration coverage for the cast primitive.
 *
 * Real tmpdir corps + real chit writes. Validates the end-to-end
 * pipeline from blueprint chit → parseBlueprint → createChit for
 * Contract + Task chits → dependsOn rewriting.
 *
 * Pure-primitive concerns (Handlebars expansion, var coercion, DAG
 * shape) live in blueprint-parser.test.ts + blueprint-vars.test.ts +
 * blueprint-chit-type.test.ts. This file focuses on the cast-specific
 * integration surface: status gating, role resolution, chit
 * materialization, dependsOn rewriting with real pre-allocated ids.
 */

// ─── Helpers ────────────────────────────────────────────────────────

function makeCorp(): { corpRoot: string; cleanup: () => void } {
  const corpRoot = mkdtempSync(join(tmpdir(), 'cast-'));
  return {
    corpRoot,
    cleanup: () => {
      try {
        rmSync(corpRoot, { recursive: true, force: true });
      } catch {
        // Windows fs-handle race — best effort.
      }
    },
  };
}

/**
 * Create an active blueprint chit in the given tmpdir corp. Tests
 * that need a non-active status override `status` via the second arg.
 */
function createActiveBlueprint(
  corpRoot: string,
  fields: BlueprintFields,
  status: 'draft' | 'active' | 'closed' = 'active',
): Chit<'blueprint'> {
  // New blueprints default to 'draft'. We need to create-then-update to
  // reach active, OR pass status directly at create time. createChit
  // accepts an explicit status in opts, which is the simpler path.
  return createChit(corpRoot, {
    type: 'blueprint',
    scope: 'corp',
    createdBy: 'founder',
    status,
    fields: { blueprint: fields },
  });
}

const minimalFields = (overrides: Partial<BlueprintFields> = {}): BlueprintFields => ({
  name: 'test-bp',
  origin: 'authored',
  steps: [{ id: 's1', title: 'Step One', assigneeRole: 'backend-engineer' }],
  ...overrides,
});

// ─── Happy path: minimal blueprint ──────────────────────────────────

describe('castFromBlueprint — minimal blueprint', () => {
  it('produces 1 Contract + 1 Task with linked blueprintId', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(corpRoot, minimalFields());
      const result = castFromBlueprint(corpRoot, blueprint, {}, {
        scope: 'corp',
        createdBy: 'founder',
      });

      expect(result.tasks).toHaveLength(1);
      expect(result.contract.type).toBe('contract');
      expect(result.tasks[0]!.type).toBe('task');
      expect(result.contract.fields.contract.blueprintId).toBe(blueprint.id);
      expect(result.contract.fields.contract.taskIds).toEqual([result.tasks[0]!.id]);
    } finally {
      cleanup();
    }
  });

  it('persists to disk — round-trips via findChitById', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(corpRoot, minimalFields());
      const result = castFromBlueprint(corpRoot, blueprint, {}, {
        scope: 'corp',
        createdBy: 'founder',
      });

      const contractOnDisk = findChitById(corpRoot, result.contract.id);
      expect(contractOnDisk).not.toBeNull();
      expect(contractOnDisk!.chit.type).toBe('contract');

      const taskOnDisk = findChitById(corpRoot, result.tasks[0]!.id);
      expect(taskOnDisk).not.toBeNull();
      expect(taskOnDisk!.chit.type).toBe('task');
    } finally {
      cleanup();
    }
  });

  it('defaults contract title from blueprint.title, then name as fallback', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const withTitle = createActiveBlueprint(corpRoot, minimalFields({ title: 'Ship Feature' }));
      const r1 = castFromBlueprint(corpRoot, withTitle, {}, { scope: 'corp', createdBy: 'f' });
      expect(r1.contract.fields.contract.title).toBe('Ship Feature');

      const withoutTitle = createActiveBlueprint(
        corpRoot,
        minimalFields({ name: 'ship-feature', title: null }),
      );
      const r2 = castFromBlueprint(corpRoot, withoutTitle, {}, { scope: 'corp', createdBy: 'f' });
      expect(r2.contract.fields.contract.title).toBe('ship-feature');
    } finally {
      cleanup();
    }
  });

  it('defaults contract goal from summary, else synthesized "Cast from..." string', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const withSummary = createActiveBlueprint(
        corpRoot,
        minimalFields({ summary: 'Do the thing' }),
      );
      const r1 = castFromBlueprint(corpRoot, withSummary, {}, { scope: 'corp', createdBy: 'f' });
      expect(r1.contract.fields.contract.goal).toBe('Do the thing');

      const withoutSummary = createActiveBlueprint(
        corpRoot,
        minimalFields({ name: 'my-bp', summary: null }),
      );
      const r2 = castFromBlueprint(corpRoot, withoutSummary, {}, { scope: 'corp', createdBy: 'f' });
      expect(r2.contract.fields.contract.goal).toContain('my-bp');
    } finally {
      cleanup();
    }
  });

  it('tasks tagged blueprint:<name> + blueprint-step:<step-id>', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({ name: 'my-bp', steps: [{ id: 's1', title: 'T', assigneeRole: 'ceo' }] }),
      );
      const result = castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' });
      expect(result.tasks[0]!.tags).toContain('blueprint:my-bp');
      expect(result.tasks[0]!.tags).toContain('blueprint-step:s1');
    } finally {
      cleanup();
    }
  });

  it('contract tagged blueprint:<name>', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(corpRoot, minimalFields({ name: 'my-bp' }));
      const result = castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' });
      expect(result.contract.tags).toContain('blueprint:my-bp');
    } finally {
      cleanup();
    }
  });
});

// ─── contractOverrides ──────────────────────────────────────────────

describe('castFromBlueprint — contractOverrides', () => {
  it('title override wins over blueprint title', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({ title: 'Blueprint Title' }),
      );
      const result = castFromBlueprint(corpRoot, blueprint, {}, {
        scope: 'corp',
        createdBy: 'f',
        contractOverrides: { title: 'Override Title' },
      });
      expect(result.contract.fields.contract.title).toBe('Override Title');
    } finally {
      cleanup();
    }
  });

  it('goal override wins over blueprint summary', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({ summary: 'Summary goal' }),
      );
      const result = castFromBlueprint(corpRoot, blueprint, {}, {
        scope: 'corp',
        createdBy: 'f',
        contractOverrides: { goal: 'Override goal' },
      });
      expect(result.contract.fields.contract.goal).toBe('Override goal');
    } finally {
      cleanup();
    }
  });

  it('priority override applies to Contract AND to every cast Task', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(corpRoot, minimalFields());
      const result = castFromBlueprint(corpRoot, blueprint, {}, {
        scope: 'corp',
        createdBy: 'f',
        contractOverrides: { priority: 'critical' },
      });
      expect(result.contract.fields.contract.priority).toBe('critical');
      expect(result.tasks[0]!.fields.task.priority).toBe('critical');
    } finally {
      cleanup();
    }
  });

  it('priority defaults to normal when no override', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(corpRoot, minimalFields());
      const result = castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' });
      expect(result.contract.fields.contract.priority).toBe('normal');
    } finally {
      cleanup();
    }
  });
});

// ─── Multi-step DAG ─────────────────────────────────────────────────

describe('castFromBlueprint — multi-step DAG', () => {
  it('creates one Task per step, dependsOn rewritten from step-ids to chit-ids', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({
          steps: [
            { id: 'a', title: 'A', assigneeRole: 'ceo' },
            { id: 'b', title: 'B', dependsOn: ['a'], assigneeRole: 'ceo' },
            { id: 'c', title: 'C', dependsOn: ['a', 'b'], assigneeRole: 'ceo' },
          ],
        }),
      );
      const result = castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' });

      expect(result.tasks).toHaveLength(3);

      const taskA = result.tasks.find((t) => t.fields.task.title === 'A')!;
      const taskB = result.tasks.find((t) => t.fields.task.title === 'B')!;
      const taskC = result.tasks.find((t) => t.fields.task.title === 'C')!;

      // B depends on A's chit id (not the string "a")
      expect(taskB.dependsOn).toEqual([taskA.id]);
      // C depends on both A's and B's chit ids
      expect(taskC.dependsOn).toEqual(expect.arrayContaining([taskA.id, taskB.id]));
      expect(taskC.dependsOn).toHaveLength(2);
      // A has no deps
      expect(taskA.dependsOn).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

// ─── Handlebars expansion in cast ───────────────────────────────────

describe('castFromBlueprint — Handlebars expansion flows through to Task chits', () => {
  it('Task titles get Handlebars vars filled in', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({
          vars: [{ name: 'feature', type: 'string' }],
          steps: [{ id: 's', title: 'Ship {{feature}}', assigneeRole: 'backend-engineer' }],
        }),
      );
      const result = castFromBlueprint(corpRoot, blueprint, { feature: 'fire' }, {
        scope: 'corp',
        createdBy: 'f',
      });
      expect(result.tasks[0]!.fields.task.title).toBe('Ship fire');
    } finally {
      cleanup();
    }
  });

  it('acceptanceCriteria expanded into Task fields', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({
          vars: [{ name: 'n', type: 'int' }],
          steps: [
            {
              id: 's',
              title: 'T',
              acceptanceCriteria: ['threshold is {{n}}', 'no regressions'],
              assigneeRole: 'ceo',
            },
          ],
        }),
      );
      const result = castFromBlueprint(corpRoot, blueprint, { n: '7' }, {
        scope: 'corp',
        createdBy: 'f',
      });
      expect(result.tasks[0]!.fields.task.acceptanceCriteria).toEqual([
        'threshold is 7',
        'no regressions',
      ]);
    } finally {
      cleanup();
    }
  });
});

// ─── Role resolution ────────────────────────────────────────────────

describe('castFromBlueprint — role resolution', () => {
  it('blueprint-declared assigneeRole wins (stepRoleOverrides do not override non-null)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({ steps: [{ id: 's', title: 'T', assigneeRole: 'ceo' }] }),
      );
      const result = castFromBlueprint(corpRoot, blueprint, {}, {
        scope: 'corp',
        createdBy: 'f',
        stepRoleOverrides: { s: 'backend-engineer' }, // ignored because blueprint is non-null
      });
      expect(result.tasks[0]!.fields.task.assignee).toBe('ceo');
    } finally {
      cleanup();
    }
  });

  it('null assigneeRole + stepRoleOverride resolves via override', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({ steps: [{ id: 's', title: 'T', assigneeRole: null }] }),
      );
      const result = castFromBlueprint(corpRoot, blueprint, {}, {
        scope: 'corp',
        createdBy: 'f',
        stepRoleOverrides: { s: 'backend-engineer' },
      });
      expect(result.tasks[0]!.fields.task.assignee).toBe('backend-engineer');
    } finally {
      cleanup();
    }
  });

  it('null assigneeRole + no override throws BlueprintCastError with step id', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({ steps: [{ id: 'orphan-step', title: 'T', assigneeRole: null }] }),
      );
      try {
        castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' });
        expect.fail('expected cast to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BlueprintCastError);
        expect((err as BlueprintCastError).stepId).toBe('orphan-step');
        expect((err as Error).message).toContain('stepRoleOverrides');
      }
    } finally {
      cleanup();
    }
  });

  it('unknown role (blueprint-declared) throws BlueprintCastError', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({ steps: [{ id: 's', title: 'T', assigneeRole: 'non-existent-role' }] }),
      );
      expect(() =>
        castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' }),
      ).toThrow(/role registry/);
    } finally {
      cleanup();
    }
  });

  it('unknown role (via override) throws BlueprintCastError', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({ steps: [{ id: 's', title: 'T', assigneeRole: null }] }),
      );
      expect(() =>
        castFromBlueprint(corpRoot, blueprint, {}, {
          scope: 'corp',
          createdBy: 'f',
          stepRoleOverrides: { s: 'fake-role' },
        }),
      ).toThrow(/role registry/);
    } finally {
      cleanup();
    }
  });
});

// ─── Status gating ──────────────────────────────────────────────────

describe('castFromBlueprint — blueprint status gating', () => {
  it('rejects draft-status blueprint with promote-hint in message', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(corpRoot, minimalFields(), 'draft');
      try {
        castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BlueprintCastError);
        expect((err as Error).message).toContain("status 'draft'");
        expect((err as Error).message).toContain('cc-cli blueprint validate');
      }
    } finally {
      cleanup();
    }
  });

  it('rejects closed-status blueprint', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(corpRoot, minimalFields(), 'closed');
      expect(() =>
        castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' }),
      ).toThrow(/status 'closed'/);
    } finally {
      cleanup();
    }
  });
});

// ─── Error propagation ─────────────────────────────────────────────

describe('castFromBlueprint — error propagation', () => {
  it('propagates BlueprintVarError (missing required var)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({
          vars: [{ name: 'required', type: 'string' }],
        }),
      );
      expect(() =>
        castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' }),
      ).toThrow(BlueprintVarError);
    } finally {
      cleanup();
    }
  });

  it('propagates BlueprintParseError (undeclared var ref)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({
          steps: [{ id: 's', title: 'Hello {{undeclared}}', assigneeRole: 'ceo' }],
        }),
      );
      expect(() =>
        castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' }),
      ).toThrow(BlueprintParseError);
    } finally {
      cleanup();
    }
  });

  it('validation-first: failing cast does NOT leave orphan chits on disk', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const blueprint = createActiveBlueprint(
        corpRoot,
        minimalFields({
          vars: [{ name: 'required', type: 'string' }],
          steps: [
            { id: 'a', title: 'A', assigneeRole: 'ceo' },
            { id: 'b', title: 'B', dependsOn: ['a'], assigneeRole: 'ceo' },
          ],
        }),
      );
      try {
        castFromBlueprint(corpRoot, blueprint, {}, { scope: 'corp', createdBy: 'f' });
      } catch {
        // expected
      }

      // Broader-than-findChitById check: walk the on-disk chits
      // directory directly to prove cast never started writing tasks
      // or a contract. Validation-first is only real if pre-check
      // throws MEAN no chit was written, not merely that the claimed
      // chits don't exist.
      const tasksDir = join(corpRoot, 'chits', 'task');
      const contractsDir = join(corpRoot, 'chits', 'contract');
      if (existsSync(tasksDir)) {
        expect(readdirSync(tasksDir)).toHaveLength(0);
      }
      if (existsSync(contractsDir)) {
        expect(readdirSync(contractsDir)).toHaveLength(0);
      }
    } finally {
      cleanup();
    }
  });
});
