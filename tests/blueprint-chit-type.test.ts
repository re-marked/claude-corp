import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  findChitById,
  getChitType,
  ChitValidationError,
  type BlueprintFields,
  type BlueprintStep,
  type BlueprintVar,
} from '../packages/shared/src/index.js';

/**
 * Project 1.8 PR 1 — validator coverage for the blueprint chit type.
 *
 * validateBlueprint runs on every write through createChit, so a
 * well-formed blueprint can round-trip but a malformed one throws at
 * write time. These tests pin every validation branch the commit
 * messages claim, plus the end-to-end integration (createChit actually
 * invokes the validator) so fast-fail-at-write isn't a lie.
 *
 * Pure tests drive the validator directly via the registry lookup so
 * we exercise the same function production hits. Integration tests
 * spin a tmpdir corp to confirm createChit wires the validator in.
 */

// ─── Test helpers ──────────────────────────────────────────────────

/**
 * Fresh corp root under os.tmpdir for each suite that needs createChit.
 * Returned as a tuple with cleanup closure so the finally block stays
 * one line and tests don't forget to run it.
 */
function makeCorp(): { corpRoot: string; cleanup: () => void } {
  const corpRoot = mkdtempSync(join(tmpdir(), 'bp-chit-'));
  return {
    corpRoot,
    cleanup: () => {
      try {
        rmSync(corpRoot, { recursive: true, force: true });
      } catch {
        // Best-effort on Windows where rmSync occasionally races with fs handles.
      }
    },
  };
}

/**
 * Minimal valid BlueprintFields payload. Tests start from this and
 * mutate one field at a time — makes it obvious which invariant is
 * under test.
 */
function minimalBlueprint(overrides: Partial<BlueprintFields> = {}): BlueprintFields {
  return {
    name: 'health-check',
    origin: 'authored',
    steps: [
      { id: 'scan', title: 'Scan caskets' },
    ],
    ...overrides,
  };
}

/**
 * Direct validator invocation via the registry — exercises the same
 * function production's createChit calls, without any I/O fixture.
 */
function validate(fields: Partial<BlueprintFields>): void {
  const entry = getChitType('blueprint');
  if (!entry) throw new Error('test setup: blueprint type missing from registry');
  entry.validate(fields);
}

// ─── Happy paths ───────────────────────────────────────────────────

describe('validateBlueprint — accepts valid shapes', () => {
  it('minimal: one step, no vars, no optional fields', () => {
    expect(() => validate(minimalBlueprint())).not.toThrow();
  });

  it('full: multi-step DAG, vars with defaults, title, summary', () => {
    const fields: BlueprintFields = {
      name: 'patrol/health-check',
      origin: 'builtin',
      title: 'Health check patrol',
      summary: 'Sweep the corp for stuck, stalled, or silent-exited agents.',
      vars: [
        { name: 'threshold_min', type: 'int', default: 5, description: 'Minutes before stall flag' },
        { name: 'dry_run', type: 'bool', default: false },
        { name: 'note', type: 'string', default: null, description: 'Optional annotation' },
      ],
      steps: [
        { id: 'scan-caskets', title: 'Enumerate caskets', assigneeRole: 'sexton' },
        {
          id: 'detect-stalls',
          title: 'Flag caskets idle > {{threshold_min}} min',
          dependsOn: ['scan-caskets'],
          acceptanceCriteria: ['All stall candidates identified with evidence'],
          assigneeRole: 'sexton',
        },
        {
          id: 'respawn-or-escalate',
          title: 'Respawn silent-exits, escalate stubborn stalls',
          dependsOn: ['detect-stalls'],
          assigneeRole: 'sexton',
        },
      ],
    };
    expect(() => validate(fields)).not.toThrow();
  });

  it('accepts names with `/` category separator (patrol/X, domain/Y)', () => {
    expect(() => validate(minimalBlueprint({ name: 'patrol/cleanup-stale-sandboxes' }))).not.toThrow();
  });

  it('accepts a single-character name', () => {
    expect(() => validate(minimalBlueprint({ name: 'a' }))).not.toThrow();
  });

  it('accepts origin "authored" and "builtin"', () => {
    expect(() => validate(minimalBlueprint({ origin: 'authored' }))).not.toThrow();
    expect(() => validate(minimalBlueprint({ origin: 'builtin' }))).not.toThrow();
  });

  it('accepts assigneeRole as null (cast-time resolution)', () => {
    expect(() =>
      validate(minimalBlueprint({ steps: [{ id: 's1', title: 'X', assigneeRole: null }] })),
    ).not.toThrow();
  });
});

// ─── name ──────────────────────────────────────────────────────────

describe('validateBlueprint — name', () => {
  it('rejects missing name', () => {
    const f: Partial<BlueprintFields> = { origin: 'authored', steps: [{ id: 's', title: 't' }] };
    expect(() => validate(f)).toThrow(/blueprint\.name/);
  });

  it('rejects empty name', () => {
    expect(() => validate(minimalBlueprint({ name: '' }))).toThrow(/blueprint\.name/);
  });

  it('rejects uppercase in name', () => {
    expect(() => validate(minimalBlueprint({ name: 'Health-Check' }))).toThrow(/kebab-case/);
  });

  it('rejects trailing hyphen', () => {
    expect(() => validate(minimalBlueprint({ name: 'health-check-' }))).toThrow(/kebab-case/);
  });

  it('rejects trailing slash', () => {
    expect(() => validate(minimalBlueprint({ name: 'patrol/' }))).toThrow(/kebab-case/);
  });

  it('rejects spaces', () => {
    expect(() => validate(minimalBlueprint({ name: 'health check' }))).toThrow(/kebab-case/);
  });

  it('rejects Handlebars-looking characters', () => {
    expect(() => validate(minimalBlueprint({ name: '{{ship-feature}}' }))).toThrow(/kebab-case/);
  });
});

// ─── origin ────────────────────────────────────────────────────────

describe('validateBlueprint — origin', () => {
  it('rejects missing origin', () => {
    const f: Partial<BlueprintFields> = { name: 'x', steps: [{ id: 's', title: 't' }] };
    expect(() => validate(f)).toThrow(/blueprint\.origin/);
  });

  it('rejects invalid origin enum', () => {
    expect(() => validate(minimalBlueprint({ origin: 'captured' as 'authored' }))).toThrow(
      /blueprint\.origin/,
    );
  });
});

// ─── steps — structural ────────────────────────────────────────────

describe('validateBlueprint — steps structure', () => {
  it('rejects empty steps array', () => {
    expect(() => validate(minimalBlueprint({ steps: [] }))).toThrow(/non-empty/);
  });

  it('rejects non-array steps', () => {
    expect(() =>
      validate(minimalBlueprint({ steps: 'not-an-array' as unknown as BlueprintStep[] })),
    ).toThrow(/non-empty array/);
  });

  it('rejects missing step id', () => {
    expect(() =>
      validate(minimalBlueprint({ steps: [{ title: 'X' } as unknown as BlueprintStep] })),
    ).toThrow(/steps\[0\]\.id/);
  });

  it('rejects empty step id', () => {
    expect(() => validate(minimalBlueprint({ steps: [{ id: '', title: 'X' }] }))).toThrow(
      /steps\[0\]\.id/,
    );
  });

  it('rejects invalid step id chars', () => {
    expect(() =>
      validate(minimalBlueprint({ steps: [{ id: 'bad id', title: 'X' }] })),
    ).toThrow(/alphanumeric/);
    expect(() =>
      validate(minimalBlueprint({ steps: [{ id: 'bad/id', title: 'X' }] })),
    ).toThrow(/alphanumeric/);
    expect(() =>
      validate(minimalBlueprint({ steps: [{ id: 'bad.id', title: 'X' }] })),
    ).toThrow(/alphanumeric/);
  });

  it('rejects duplicate step ids within a blueprint', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          steps: [
            { id: 'scan', title: 'A' },
            { id: 'scan', title: 'B' },
          ],
        }),
      ),
    ).toThrow(/duplicates an earlier step id/);
  });

  it('rejects missing step title', () => {
    expect(() =>
      validate(minimalBlueprint({ steps: [{ id: 's' } as unknown as BlueprintStep] })),
    ).toThrow(/steps\[0\]\.title/);
  });
});

// ─── steps — dependsOn ────────────────────────────────────────────

describe('validateBlueprint — step dependsOn', () => {
  it('rejects dependsOn referencing an unknown step id', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          steps: [
            { id: 's1', title: 'A', dependsOn: ['nonexistent'] },
          ],
        }),
      ),
    ).toThrow(/unknown step id/);
  });

  it('accepts dependsOn referencing a step declared later (forward ref)', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          steps: [
            { id: 's1', title: 'A', dependsOn: ['s2'] },
            { id: 's2', title: 'B' },
          ],
        }),
      ),
    ).not.toThrow();
    // DAG check: the accepted-forward-ref case has s1 depending on s2, no cycle.
  });

  it('rejects a non-array dependsOn', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          steps: [{ id: 's', title: 'X', dependsOn: 'nope' as unknown as string[] }],
        }),
      ),
    ).toThrow(/dependsOn/);
  });
});

// ─── steps — DAG cycle detection ───────────────────────────────────

describe('validateBlueprint — DAG cycle detection', () => {
  it('rejects self-loop (step depends on itself)', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          steps: [{ id: 's1', title: 'A', dependsOn: ['s1'] }],
        }),
      ),
    ).toThrow(/dependency cycle/);
  });

  it('rejects a 2-node cycle', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          steps: [
            { id: 'a', title: 'A', dependsOn: ['b'] },
            { id: 'b', title: 'B', dependsOn: ['a'] },
          ],
        }),
      ),
    ).toThrow(/dependency cycle/);
  });

  it('rejects a 3-node cycle + surfaces the path in the error message', () => {
    try {
      validate(
        minimalBlueprint({
          steps: [
            { id: 'a', title: 'A', dependsOn: ['c'] },
            { id: 'b', title: 'B', dependsOn: ['a'] },
            { id: 'c', title: 'C', dependsOn: ['b'] },
          ],
        }),
      );
      throw new Error('expected validation to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ChitValidationError);
      expect((err as Error).message).toMatch(/→/);
      // Cycle path is printed — exact nodes present matters more than order,
      // since the walker's visit order depends on iteration.
      expect((err as Error).message).toMatch(/a|b|c/);
    }
  });

  it('accepts a fan-out DAG (one → many)', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          steps: [
            { id: 'root', title: 'Root' },
            { id: 'left', title: 'L', dependsOn: ['root'] },
            { id: 'right', title: 'R', dependsOn: ['root'] },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('accepts a fan-in DAG (many → one)', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          steps: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'merge', title: 'Merge', dependsOn: ['a', 'b'] },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

// ─── steps — assigneeRole format ───────────────────────────────────

describe('validateBlueprint — assigneeRole format', () => {
  it('accepts kebab-case role ids', () => {
    expect(() =>
      validate(minimalBlueprint({ steps: [{ id: 's', title: 'X', assigneeRole: 'backend-engineer' }] })),
    ).not.toThrow();
    expect(() =>
      validate(minimalBlueprint({ steps: [{ id: 's', title: 'X', assigneeRole: 'ceo' }] })),
    ).not.toThrow();
  });

  it('rejects uppercase in role id', () => {
    expect(() =>
      validate(minimalBlueprint({ steps: [{ id: 's', title: 'X', assigneeRole: 'Backend-Engineer' }] })),
    ).toThrow(/role id/);
  });

  it('rejects scope-qualified slug (slot not role) with the teaching message', () => {
    try {
      validate(minimalBlueprint({ steps: [{ id: 's', title: 'X', assigneeRole: 'agent:toast' }] }));
      throw new Error('expected validation to throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/scope-qualified slug/);
      expect(msg).toMatch(/assign to ROLES/);
      expect(msg).toMatch(/backend-engineer/); // teaches the correct form
    }
  });

  it('rejects digit-leading role id (must start with a letter)', () => {
    expect(() =>
      validate(minimalBlueprint({ steps: [{ id: 's', title: 'X', assigneeRole: '1cool' }] })),
    ).toThrow(/role id/);
  });
});

// ─── vars ─────────────────────────────────────────────────────────

describe('validateBlueprint — vars', () => {
  it('rejects non-array vars', () => {
    expect(() =>
      validate(minimalBlueprint({ vars: 'no' as unknown as BlueprintVar[] })),
    ).toThrow(/vars must be an array/);
  });

  it('accepts empty vars array (equivalent to absent)', () => {
    expect(() => validate(minimalBlueprint({ vars: [] }))).not.toThrow();
  });

  it('rejects duplicate var names', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          vars: [
            { name: 'x', type: 'string' },
            { name: 'x', type: 'int' },
          ],
        }),
      ),
    ).toThrow(/duplicates an earlier var name/);
  });

  it('rejects invalid var type', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          vars: [{ name: 'x', type: 'number' as 'int' }],
        }),
      ),
    ).toThrow(/vars\[0\]\.type/);
  });
});

// ─── var default type coherence ────────────────────────────────────

describe('validateBlueprint — var default type coherence', () => {
  it('string var accepts string default', () => {
    expect(() =>
      validate(minimalBlueprint({ vars: [{ name: 'n', type: 'string', default: 'hi' }] })),
    ).not.toThrow();
  });

  it('string var rejects number default', () => {
    expect(() =>
      validate(
        minimalBlueprint({ vars: [{ name: 'n', type: 'string', default: 42 as unknown as string }] }),
      ),
    ).toThrow(/type='string'/);
  });

  it('int var accepts integer default', () => {
    expect(() =>
      validate(minimalBlueprint({ vars: [{ name: 'n', type: 'int', default: 5 }] })),
    ).not.toThrow();
  });

  it('int var rejects non-integer number default', () => {
    try {
      validate(minimalBlueprint({ vars: [{ name: 'n', type: 'int', default: 3.14 }] }));
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/type='int'/);
      expect(msg).toMatch(/non-integer number/);
    }
  });

  it('int var rejects string default', () => {
    expect(() =>
      validate(
        minimalBlueprint({ vars: [{ name: 'n', type: 'int', default: '5' as unknown as number }] }),
      ),
    ).toThrow(/type='int'/);
  });

  it('bool var accepts boolean default', () => {
    expect(() =>
      validate(minimalBlueprint({ vars: [{ name: 'n', type: 'bool', default: true }] })),
    ).not.toThrow();
    expect(() =>
      validate(minimalBlueprint({ vars: [{ name: 'n', type: 'bool', default: false }] })),
    ).not.toThrow();
  });

  it('bool var rejects string default', () => {
    expect(() =>
      validate(
        minimalBlueprint({
          vars: [{ name: 'n', type: 'bool', default: 'true' as unknown as boolean }],
        }),
      ),
    ).toThrow(/type='bool'/);
  });

  it('null default accepted for every type', () => {
    for (const type of ['string', 'int', 'bool'] as const) {
      expect(() =>
        validate(minimalBlueprint({ vars: [{ name: 'n', type, default: null }] })),
      ).not.toThrow();
    }
  });
});

// ─── Integration — createChit actually invokes the validator ──────

describe('validateBlueprint — integration via createChit', () => {
  it('round-trips a valid blueprint through createChit + readChit', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const chit = createChit(corpRoot, {
        type: 'blueprint',
        scope: 'corp',
        createdBy: 'founder',
        fields: {
          blueprint: minimalBlueprint({
            name: 'my-workflow',
            title: 'My workflow',
            summary: 'Does the thing',
          }),
        },
      });

      expect(chit.id).toMatch(/^chit-b-[0-9a-f]+$/);
      expect(chit.status).toBe('draft'); // registry defaultStatus
      expect(chit.ephemeral).toBe(false);

      const hit = findChitById(corpRoot, chit.id);
      expect(hit).not.toBeNull();
      const blueprint = hit!.chit.fields.blueprint as BlueprintFields;
      expect(blueprint.name).toBe('my-workflow');
      expect(blueprint.origin).toBe('authored');
      expect(blueprint.steps).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('throws ChitValidationError on invalid blueprint (validator IS wired)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: minimalBlueprint({ name: 'HAS_UPPERCASE' }),
          },
        }),
      ).toThrow(ChitValidationError);
    } finally {
      cleanup();
    }
  });

  it('throws ChitValidationError on DAG cycle through createChit', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: minimalBlueprint({
              steps: [
                { id: 'a', title: 'A', dependsOn: ['b'] },
                { id: 'b', title: 'B', dependsOn: ['a'] },
              ],
            }),
          },
        }),
      ).toThrow(/dependency cycle/);
    } finally {
      cleanup();
    }
  });
});
