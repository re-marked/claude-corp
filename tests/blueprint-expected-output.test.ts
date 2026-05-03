import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  findChitById,
  getChitType,
  ChitValidationError,
  EXPECTED_OUTPUT_KINDS,
  type BlueprintFields,
  type BlueprintStep,
  type ExpectedOutputSpec,
  type Chit,
  type TaskFields,
} from '../packages/shared/src/index.js';

/**
 * Project 2.1 PR 1 — schema validator coverage for the new
 * expectedOutput field on BlueprintStep + the new claimedAt field on
 * TaskFields. Both are optional + nullable additions; pre-2.1 chits
 * round-trip unchanged. New chits with the fields populated must
 * structurally validate per kind.
 *
 * Three concerns:
 *   - validateExpectedOutput: per-kind shape checks (7 kinds + multi
 *     composition). Drives validateBlueprint with one-step blueprints
 *     that vary the step.expectedOutput field.
 *   - validateTask claimedAt: simple ISO timestamp check.
 *   - End-to-end round-trip: blueprint chit with expectedOutput written
 *     + read preserves the spec; task chit with claimedAt round-trips.
 */

// ─── Test helpers ──────────────────────────────────────────────────

function makeCorp(): { corpRoot: string; cleanup: () => void } {
  const corpRoot = mkdtempSync(join(tmpdir(), 'bp-eo-'));
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

/**
 * Minimal blueprint that varies only the first step's expectedOutput.
 * Tests that exercise the validator drive it through this helper so
 * the unrelated structural fields stay constant — the diff between
 * passing and failing cases is exactly the expectedOutput shape.
 */
function blueprintWithStepExpected(spec: unknown): Partial<BlueprintFields> {
  return {
    name: 'walk-test',
    origin: 'authored',
    steps: [
      {
        id: 'do-thing',
        title: 'Do the thing',
        ...(spec !== undefined ? { expectedOutput: spec as ExpectedOutputSpec | null } : {}),
      } as BlueprintStep,
    ],
  };
}

function validate(fields: Partial<BlueprintFields>): void {
  const entry = getChitType('blueprint');
  if (!entry) throw new Error('test setup: blueprint type missing from registry');
  entry.validate(fields);
}

function validateTaskFields(fields: Partial<TaskFields>): void {
  const entry = getChitType('task');
  if (!entry) throw new Error('test setup: task type missing from registry');
  entry.validate(fields);
}

function minimalTask(overrides: Partial<TaskFields> = {}): Partial<TaskFields> {
  return {
    title: 'Test task',
    priority: 'normal',
    ...overrides,
  };
}

// ─── EXPECTED_OUTPUT_KINDS exhaustiveness ───────────────────────────

describe('EXPECTED_OUTPUT_KINDS — discriminator set', () => {
  it('contains all seven anticipated kinds', () => {
    expect([...EXPECTED_OUTPUT_KINDS].sort()).toEqual([
      'branch-exists',
      'chit-of-type',
      'commit-on-branch',
      'file-exists',
      'multi',
      'tag-on-task',
      'task-output-nonempty',
    ]);
  });
});

// ─── validateExpectedOutput — happy paths per kind ──────────────────

describe('expectedOutput — accepts valid shapes per kind', () => {
  it('absent expectedOutput is fine (graceful degradation)', () => {
    expect(() => validate(blueprintWithStepExpected(undefined))).not.toThrow();
  });

  it('null expectedOutput is fine', () => {
    expect(() => validate(blueprintWithStepExpected(null))).not.toThrow();
  });

  it('chit-of-type with chitType only', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'chit-of-type', chitType: 'clearance-submission' })),
    ).not.toThrow();
  });

  it('chit-of-type with chitType + withTags', () => {
    expect(() =>
      validate(
        blueprintWithStepExpected({
          kind: 'chit-of-type',
          chitType: 'clearance-submission',
          withTags: ['task:{{taskId}}', 'submitter:{{slug}}'],
        }),
      ),
    ).not.toThrow();
  });

  it('chit-of-type with empty withTags array', () => {
    expect(() =>
      validate(
        blueprintWithStepExpected({
          kind: 'chit-of-type',
          chitType: 'review-comment',
          withTags: [],
        }),
      ),
    ).not.toThrow();
  });

  it('branch-exists with branchPattern', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'branch-exists', branchPattern: 'feat/{{feature}}' })),
    ).not.toThrow();
  });

  it('commit-on-branch with branchPattern only (sinceClaim defaults at checker time)', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'commit-on-branch', branchPattern: 'feat/{{feature}}' })),
    ).not.toThrow();
  });

  it('commit-on-branch with sinceClaim explicit true', () => {
    expect(() =>
      validate(
        blueprintWithStepExpected({
          kind: 'commit-on-branch',
          branchPattern: 'feat/{{feature}}',
          sinceClaim: true,
        }),
      ),
    ).not.toThrow();
  });

  it('commit-on-branch with sinceClaim explicit false', () => {
    expect(() =>
      validate(
        blueprintWithStepExpected({
          kind: 'commit-on-branch',
          branchPattern: 'feat/{{feature}}',
          sinceClaim: false,
        }),
      ),
    ).not.toThrow();
  });

  it('file-exists with pathPattern', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'file-exists', pathPattern: 'notes/{{topic}}.md' })),
    ).not.toThrow();
  });

  it('tag-on-task with tag', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'tag-on-task', tag: 'reviewed' })),
    ).not.toThrow();
  });

  it('task-output-nonempty with no extra fields', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'task-output-nonempty' })),
    ).not.toThrow();
  });

  it('multi with two sub-specs of different kinds', () => {
    expect(() =>
      validate(
        blueprintWithStepExpected({
          kind: 'multi',
          specs: [
            { kind: 'task-output-nonempty' },
            { kind: 'branch-exists', branchPattern: 'feat/{{feature}}' },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('multi with one nested multi (recursive case)', () => {
    expect(() =>
      validate(
        blueprintWithStepExpected({
          kind: 'multi',
          specs: [
            {
              kind: 'multi',
              specs: [
                { kind: 'task-output-nonempty' },
                { kind: 'tag-on-task', tag: 'inner' },
              ],
            },
            { kind: 'branch-exists', branchPattern: 'feat/{{feature}}' },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

// ─── validateExpectedOutput — rejection paths ──────────────────────

describe('expectedOutput — rejects malformed shapes', () => {
  it('rejects missing kind', () => {
    expect(() => validate(blueprintWithStepExpected({} as unknown))).toThrow(
      ChitValidationError,
    );
  });

  it('rejects unknown kind', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'something-bogus', chitType: 'task' } as unknown)),
    ).toThrow(ChitValidationError);
  });

  it('rejects non-object spec (e.g. string)', () => {
    expect(() => validate(blueprintWithStepExpected('chit-of-type' as unknown))).toThrow(
      ChitValidationError,
    );
  });

  it('rejects array spec', () => {
    expect(() => validate(blueprintWithStepExpected([] as unknown))).toThrow(ChitValidationError);
  });

  it('chit-of-type rejects missing chitType', () => {
    expect(() => validate(blueprintWithStepExpected({ kind: 'chit-of-type' } as unknown))).toThrow(
      ChitValidationError,
    );
  });

  it('chit-of-type rejects empty chitType', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'chit-of-type', chitType: '' } as unknown)),
    ).toThrow(ChitValidationError);
  });

  it('chit-of-type rejects non-string-array withTags', () => {
    expect(() =>
      validate(
        blueprintWithStepExpected({
          kind: 'chit-of-type',
          chitType: 'task',
          withTags: [1, 2, 3] as unknown,
        } as unknown),
      ),
    ).toThrow(ChitValidationError);
  });

  it('branch-exists rejects missing branchPattern', () => {
    expect(() => validate(blueprintWithStepExpected({ kind: 'branch-exists' } as unknown))).toThrow(
      ChitValidationError,
    );
  });

  it('commit-on-branch rejects missing branchPattern', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'commit-on-branch' } as unknown)),
    ).toThrow(ChitValidationError);
  });

  it('commit-on-branch rejects non-boolean sinceClaim', () => {
    expect(() =>
      validate(
        blueprintWithStepExpected({
          kind: 'commit-on-branch',
          branchPattern: 'feat/{{f}}',
          sinceClaim: 'yes' as unknown,
        } as unknown),
      ),
    ).toThrow(ChitValidationError);
  });

  it('file-exists rejects missing pathPattern', () => {
    expect(() => validate(blueprintWithStepExpected({ kind: 'file-exists' } as unknown))).toThrow(
      ChitValidationError,
    );
  });

  it('tag-on-task rejects missing tag', () => {
    expect(() => validate(blueprintWithStepExpected({ kind: 'tag-on-task' } as unknown))).toThrow(
      ChitValidationError,
    );
  });

  it('multi rejects missing specs', () => {
    expect(() => validate(blueprintWithStepExpected({ kind: 'multi' } as unknown))).toThrow(
      ChitValidationError,
    );
  });

  it('multi rejects empty specs array', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'multi', specs: [] } as unknown)),
    ).toThrow(ChitValidationError);
  });

  it('multi rejects non-array specs', () => {
    expect(() =>
      validate(blueprintWithStepExpected({ kind: 'multi', specs: 'not-array' } as unknown)),
    ).toThrow(ChitValidationError);
  });

  it('multi propagates nested validation failure with precise field path', () => {
    try {
      validate(
        blueprintWithStepExpected({
          kind: 'multi',
          specs: [
            { kind: 'branch-exists', branchPattern: 'feat/x' },
            // Second spec is malformed (missing tag).
            { kind: 'tag-on-task' } as unknown,
          ],
        } as unknown),
      );
      throw new Error('expected validation to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ChitValidationError);
      const e = err as ChitValidationError;
      // Path should reach into specs[1] precisely so authors can find
      // the bad nested spec.
      expect(e.field).toContain('specs[1]');
      expect(e.field).toContain('tag');
    }
  });

  it('multi propagates deeper nested failure (multi-of-multi)', () => {
    try {
      validate(
        blueprintWithStepExpected({
          kind: 'multi',
          specs: [
            {
              kind: 'multi',
              specs: [
                { kind: 'task-output-nonempty' },
                // Inner spec missing required field.
                { kind: 'file-exists' } as unknown,
              ],
            },
          ],
        } as unknown),
      );
      throw new Error('expected validation to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ChitValidationError);
      const e = err as ChitValidationError;
      expect(e.field).toContain('specs[0]');
      expect(e.field).toContain('specs[1]');
      expect(e.field).toContain('pathPattern');
    }
  });
});

// ─── TaskFields.claimedAt — validator ────────────────────────────────

describe('TaskFields.claimedAt — ISO timestamp validation', () => {
  it('absent claimedAt is fine', () => {
    expect(() => validateTaskFields(minimalTask())).not.toThrow();
  });

  it('null claimedAt is fine', () => {
    expect(() => validateTaskFields(minimalTask({ claimedAt: null }))).not.toThrow();
  });

  it('valid ISO timestamp accepted', () => {
    expect(() =>
      validateTaskFields(minimalTask({ claimedAt: '2026-05-02T15:30:00.000Z' })),
    ).not.toThrow();
  });

  it('rejects non-ISO string', () => {
    expect(() =>
      validateTaskFields(minimalTask({ claimedAt: 'yesterday' as unknown as string })),
    ).toThrow(ChitValidationError);
  });

  it('rejects number', () => {
    expect(() =>
      validateTaskFields(minimalTask({ claimedAt: 1714659000 as unknown as string })),
    ).toThrow(ChitValidationError);
  });

  it('does not collide with reviewerClaim.claimedAt (Editor review claim)', () => {
    // Both fields can coexist on the same task — distinct lifecycle events.
    expect(() =>
      validateTaskFields(
        minimalTask({
          claimedAt: '2026-05-02T15:30:00.000Z',
          reviewerClaim: { slug: 'editor', claimedAt: '2026-05-02T16:00:00.000Z' },
        }),
      ),
    ).not.toThrow();
  });
});

// ─── End-to-end round-trip via createChit ────────────────────────────

describe('expectedOutput round-trip via createChit', () => {
  it('writes + reads a blueprint with multi expectedOutput preserving structure', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const written = createChit(corpRoot, {
        type: 'blueprint',
        scope: 'corp',
        createdBy: 'test-author',
        body: 'test blueprint',
        fields: {
          blueprint: {
            name: 'walk-roundtrip',
            origin: 'authored',
            steps: [
              {
                id: 'submit',
                title: 'Submit clearance',
                expectedOutput: {
                  kind: 'multi',
                  specs: [
                    {
                      kind: 'chit-of-type',
                      chitType: 'clearance-submission',
                      withTags: ['task:{{taskId}}'],
                    },
                    {
                      kind: 'commit-on-branch',
                      branchPattern: 'feat/{{feature}}',
                      sinceClaim: true,
                    },
                  ],
                },
              },
            ],
          },
        },
      });

      const hit = findChitById(corpRoot, written.id);
      expect(hit).not.toBeNull();
      const chit = hit!.chit as Chit<'blueprint'>;
      const step = chit.fields.blueprint.steps[0]!;
      expect(step.expectedOutput?.kind).toBe('multi');
      const multi = step.expectedOutput as { kind: 'multi'; specs: ExpectedOutputSpec[] };
      expect(multi.specs).toHaveLength(2);
      expect(multi.specs[0]?.kind).toBe('chit-of-type');
      expect(multi.specs[1]?.kind).toBe('commit-on-branch');
    } finally {
      cleanup();
    }
  });

  it('writes + reads a task with claimedAt preserved', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const written = createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        createdBy: 'test-author',
        body: 'test task',
        fields: {
          task: {
            title: 'Test task',
            priority: 'normal',
            assignee: 'backend-engineer',
            claimedAt: '2026-05-02T15:30:00.000Z',
          },
        },
      });

      const hit = findChitById(corpRoot, written.id);
      expect(hit).not.toBeNull();
      const chit = hit!.chit as Chit<'task'>;
      expect(chit.fields.task.claimedAt).toBe('2026-05-02T15:30:00.000Z');
    } finally {
      cleanup();
    }
  });

  it('rejects blueprint with malformed expectedOutput at write time (createChit invokes validator)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'test-author',
          body: 'bad',
          fields: {
            blueprint: {
              name: 'bad-walk',
              origin: 'authored',
              steps: [
                {
                  id: 'broken',
                  title: 'Broken step',
                  // chit-of-type without chitType → must throw.
                  expectedOutput: { kind: 'chit-of-type' } as unknown as ExpectedOutputSpec,
                },
              ],
            },
          },
        }),
      ).toThrow(ChitValidationError);
    } finally {
      cleanup();
    }
  });
});
