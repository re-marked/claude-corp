import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChit,
  findChitById,
  castSweeperFromBlueprint,
  BlueprintCastError,
  BlueprintParseError,
  BlueprintVarError,
  ChitValidationError,
  CHIT_TYPES,
  type Chit,
  type BlueprintFields,
  type SweeperRunFields,
} from '../packages/shared/src/index.js';

/**
 * Project 1.9 PR 1 — end-of-PR coverage for the sweeper substrate.
 *
 * Covers three layers:
 *   1. Validator extensions: BlueprintFields.kind + BlueprintStep.moduleRef
 *      shape checks (rejected uppercase / wrong types / unknown kinds).
 *   2. sweeper-run chit type: registry entry presence, validator enforces
 *      required fields + outcome enum.
 *   3. castSweeperFromBlueprint: happy path + every error class it throws
 *      (status, kind routing, single-step, parse/var errors from the
 *      shared pipeline).
 *
 * Real tmpdir corps + real chit writes throughout. No mocking — if the
 * primitive writes a chit that validates against the shipped registry,
 * the test accepts it.
 */

// ─── Helpers ────────────────────────────────────────────────────────

function makeCorp(): { corpRoot: string; cleanup: () => void } {
  const corpRoot = mkdtempSync(join(tmpdir(), 'sweeper-cast-'));
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

function createActiveSweeperBlueprint(
  corpRoot: string,
  overrides: Partial<BlueprintFields> = {},
  status: 'draft' | 'active' | 'closed' = 'active',
): Chit<'blueprint'> {
  const fields: BlueprintFields = {
    name: 'test-sweeper',
    origin: 'authored',
    kind: 'sweeper',
    steps: [
      {
        id: 'run',
        title: 'Run the sweeper',
        description: 'Scan for orphan chits and report findings.',
        moduleRef: 'chit-hygiene',
      },
    ],
    ...overrides,
  };
  return createChit(corpRoot, {
    type: 'blueprint',
    scope: 'corp',
    createdBy: 'founder',
    status,
    fields: { blueprint: fields },
  });
}

// ─── Validator: BlueprintFields.kind ────────────────────────────────

describe('validateBlueprint — kind discriminator', () => {
  it('accepts absent kind (legacy 1.8-era blueprints)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'no-kind',
              origin: 'authored',
              steps: [{ id: 's1', title: 'Step', assigneeRole: 'ceo' }],
            },
          },
        }),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it("accepts kind: 'contract'", () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'contract-kind',
              origin: 'authored',
              kind: 'contract',
              steps: [{ id: 's1', title: 'Step', assigneeRole: 'ceo' }],
            },
          },
        }),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it("accepts kind: 'sweeper'", () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'sweeper-kind',
              origin: 'authored',
              kind: 'sweeper',
              steps: [{ id: 's1', title: 'Step', moduleRef: 'session-gc' }],
            },
          },
        }),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('rejects unknown kind value', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'weird',
              origin: 'authored',
              kind: 'patrol' as 'contract',
              steps: [{ id: 's1', title: 'Step', assigneeRole: 'ceo' }],
            },
          },
        }),
      ).toThrowError(ChitValidationError);
    } finally {
      cleanup();
    }
  });

  it('rejects non-string kind (wrong type)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'wrongtype',
              origin: 'authored',
              kind: 123 as unknown as 'contract',
              steps: [{ id: 's1', title: 'Step', assigneeRole: 'ceo' }],
            },
          },
        }),
      ).toThrowError(ChitValidationError);
    } finally {
      cleanup();
    }
  });
});

// ─── Validator: BlueprintStep.moduleRef ─────────────────────────────

describe('validateBlueprint — step.moduleRef', () => {
  it('accepts absent moduleRef', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'no-modref',
              origin: 'authored',
              kind: 'sweeper',
              steps: [{ id: 's1', title: 'Step', description: 'AI prompt' }],
            },
          },
        }),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('accepts explicit null moduleRef (AI sweeper)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'null-modref',
              origin: 'authored',
              kind: 'sweeper',
              steps: [{ id: 's1', title: 'Step', moduleRef: null }],
            },
          },
        }),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('accepts valid kebab-case moduleRef', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'kebab-modref',
              origin: 'authored',
              kind: 'sweeper',
              steps: [{ id: 's1', title: 'Step', moduleRef: 'phantom-cleanup' }],
            },
          },
        }),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('rejects uppercase moduleRef', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'upper-modref',
              origin: 'authored',
              kind: 'sweeper',
              steps: [{ id: 's1', title: 'Step', moduleRef: 'Session-GC' }],
            },
          },
        }),
      ).toThrowError(/moduleRef must be kebab-case/);
    } finally {
      cleanup();
    }
  });

  it('rejects moduleRef with underscore', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'underscore-modref',
              origin: 'authored',
              kind: 'sweeper',
              steps: [{ id: 's1', title: 'Step', moduleRef: 'session_gc' }],
            },
          },
        }),
      ).toThrowError(/moduleRef must be kebab-case/);
    } finally {
      cleanup();
    }
  });

  it('rejects moduleRef on kind=contract blueprint (authoring mistake guard)', () => {
    // Cross-field check: setting moduleRef on a non-sweeper blueprint
    // is almost certainly an authoring mistake. Catch at write time
    // with a message that teaches the fix, rather than silently casting
    // as a contract-task that ignores moduleRef and leaves the author
    // wondering weeks later why their sweeper never fires.
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'mismatched-kind',
              origin: 'authored',
              kind: 'contract',
              steps: [
                { id: 's1', title: 'Step', moduleRef: 'session-gc', assigneeRole: 'ceo' },
              ],
            },
          },
        }),
      ).toThrowError(/only meaningful on kind=sweeper blueprints/);
    } finally {
      cleanup();
    }
  });

  it('rejects moduleRef when kind is absent (defaults to contract)', () => {
    // Same authoring mistake, absent-kind variant — an author writing
    // a sweeper and forgetting the kind field entirely. Same error
    // fires, teaching the fix in the same place.
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'absent-kind-with-modref',
              origin: 'authored',
              // kind absent → defaults to contract → moduleRef invalid
              steps: [
                { id: 's1', title: 'Step', moduleRef: 'session-gc', assigneeRole: 'ceo' },
              ],
            },
          },
        }),
      ).toThrowError(/only meaningful on kind=sweeper blueprints/);
    } finally {
      cleanup();
    }
  });

  it('allows explicit null moduleRef on kind=contract (cross-field check skips null)', () => {
    // Null moduleRef is semantically "no module" — legal on any kind.
    // The cross-field guard only fires when moduleRef is a non-null
    // string (the actual authoring-mistake signal).
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'blueprint',
          scope: 'corp',
          createdBy: 'founder',
          fields: {
            blueprint: {
              name: 'null-modref-contract',
              origin: 'authored',
              kind: 'contract',
              steps: [
                { id: 's1', title: 'Step', moduleRef: null, assigneeRole: 'ceo' },
              ],
            },
          },
        }),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });
});

// ─── Registry: sweeper-run chit type ────────────────────────────────

describe('sweeper-run chit type registry', () => {
  it('has a registry entry with idPrefix "sr"', () => {
    const entry = CHIT_TYPES.find((t) => t.id === 'sweeper-run');
    expect(entry).toBeDefined();
    expect(entry!.idPrefix).toBe('sr');
  });

  it('is ephemeral with 7d TTL and destroy-if-not-promoted policy', () => {
    const entry = CHIT_TYPES.find((t) => t.id === 'sweeper-run')!;
    expect(entry.defaultEphemeral).toBe(true);
    expect(entry.defaultTTL).toBe('7d');
    expect(entry.destructionPolicy).toBe('destroy-if-not-promoted');
  });

  it('has active/closed/burning valid statuses; closed/burning terminal', () => {
    const entry = CHIT_TYPES.find((t) => t.id === 'sweeper-run')!;
    expect(entry.validStatuses).toEqual(['active', 'closed', 'burning']);
    expect(entry.terminalStatuses).toEqual(['closed', 'burning']);
  });

  it('idPrefix sr does not collide with any other chit type', () => {
    const prefixes = CHIT_TYPES.map((t) => t.idPrefix);
    const srCount = prefixes.filter((p) => p === 'sr').length;
    expect(srCount).toBe(1);
  });
});

// ─── Validator: validateSweeperRun ──────────────────────────────────

describe('validateSweeperRun', () => {
  const baseFields: SweeperRunFields = {
    blueprintId: 'chit-b-abc12345',
    triggeredBy: 'sexton',
    outcome: 'running',
  };

  it('accepts minimal valid fields', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'sweeper-run',
          scope: 'corp',
          createdBy: 'sexton',
          fields: { 'sweeper-run': baseFields },
        }),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('accepts full fields set', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'sweeper-run',
          scope: 'corp',
          createdBy: 'sexton',
          fields: {
            'sweeper-run': {
              ...baseFields,
              triggerContext: 'scheduled patrol health-check',
              moduleRef: 'chit-hygiene',
              observationsProduced: ['chit-o-11111111', 'chit-o-22222222'],
              decision: 'Flagged 2 orphan chits; noted in observations.',
            },
          },
        }),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('rejects missing blueprintId', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const { blueprintId: _drop, ...incomplete } = baseFields;
      expect(() =>
        createChit(corpRoot, {
          type: 'sweeper-run',
          scope: 'corp',
          createdBy: 'sexton',
          fields: { 'sweeper-run': incomplete as SweeperRunFields },
        }),
      ).toThrowError(/sweeper-run\.blueprintId/);
    } finally {
      cleanup();
    }
  });

  it('rejects missing triggeredBy', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const { triggeredBy: _drop, ...incomplete } = baseFields;
      expect(() =>
        createChit(corpRoot, {
          type: 'sweeper-run',
          scope: 'corp',
          createdBy: 'sexton',
          fields: { 'sweeper-run': incomplete as SweeperRunFields },
        }),
      ).toThrowError(/sweeper-run\.triggeredBy/);
    } finally {
      cleanup();
    }
  });

  it('rejects invalid outcome value', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'sweeper-run',
          scope: 'corp',
          createdBy: 'sexton',
          fields: {
            'sweeper-run': { ...baseFields, outcome: 'finished' as 'running' },
          },
        }),
      ).toThrowError(/sweeper-run\.outcome/);
    } finally {
      cleanup();
    }
  });

  it('rejects non-string entry in observationsProduced', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      expect(() =>
        createChit(corpRoot, {
          type: 'sweeper-run',
          scope: 'corp',
          createdBy: 'sexton',
          fields: {
            'sweeper-run': {
              ...baseFields,
              observationsProduced: ['chit-o-ok', 42 as unknown as string],
            },
          },
        }),
      ).toThrowError(/sweeper-run\.observationsProduced/);
    } finally {
      cleanup();
    }
  });
});

// ─── castSweeperFromBlueprint: happy paths ──────────────────────────

describe('castSweeperFromBlueprint — happy paths', () => {
  it('produces a sweeper-run chit with moduleRef set for code sweepers', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot);
      const { sweeperRun, parsed } = castSweeperFromBlueprint(corpRoot, bp, {}, {
        scope: 'corp',
        createdBy: 'sexton',
        triggerContext: 'patrol:health-check step:chit-hygiene',
      });

      expect(sweeperRun.type).toBe('sweeper-run');
      expect(sweeperRun.id).toMatch(/^chit-sr-/);
      const f = sweeperRun.fields['sweeper-run'] as SweeperRunFields;
      expect(f.blueprintId).toBe(bp.id);
      expect(f.triggeredBy).toBe('sexton');
      expect(f.moduleRef).toBe('chit-hygiene');
      expect(f.outcome).toBe('running');
      expect(f.triggerContext).toBe('patrol:health-check step:chit-hygiene');
      expect(f.observationsProduced).toEqual([]);

      expect(sweeperRun.tags).toContain('blueprint:test-sweeper');
      expect(sweeperRun.tags).toContain('sweeper:chit-hygiene');

      expect(parsed.name).toBe('test-sweeper');
      expect(parsed.steps).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('produces a sweeper-run with moduleRef=null for AI sweepers', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot, {
        name: 'ai-sweeper',
        steps: [
          {
            id: 'judge',
            title: 'Judge this chit',
            description: 'Decide: delete, archive, or escalate.',
            // moduleRef absent → AI dispatch
          },
        ],
      });
      const { sweeperRun } = castSweeperFromBlueprint(corpRoot, bp, {}, {
        scope: 'corp',
        createdBy: 'sexton',
      });

      const f = sweeperRun.fields['sweeper-run'] as SweeperRunFields;
      expect(f.moduleRef).toBeNull();
      expect(sweeperRun.tags).toContain('sweeper:ai');
    } finally {
      cleanup();
    }
  });

  it('triggeredBy defaults to createdBy when opts.triggeredBy is absent', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot);
      const { sweeperRun } = castSweeperFromBlueprint(corpRoot, bp, {}, {
        scope: 'corp',
        createdBy: 'founder',
        // triggeredBy absent
      });
      const f = sweeperRun.fields['sweeper-run'] as SweeperRunFields;
      expect(f.triggeredBy).toBe('founder');
    } finally {
      cleanup();
    }
  });

  it('opts.triggeredBy overrides createdBy when both present', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot);
      const { sweeperRun } = castSweeperFromBlueprint(corpRoot, bp, {}, {
        scope: 'corp',
        createdBy: 'founder',
        triggeredBy: 'sexton',
      });
      const f = sweeperRun.fields['sweeper-run'] as SweeperRunFields;
      expect(f.triggeredBy).toBe('sexton');
    } finally {
      cleanup();
    }
  });

  it('Handlebars expansion in step.description lands verbatim in sweeper-run body (disk round-trip)', () => {
    // Cast hands a parsed.steps[0].description (already Handlebars-
    // expanded) to createChit as the body. If cast ever passes the raw
    // template through by mistake, the dispatcher would feed the AI
    // sweeper a prompt like "Decide what to do about {{target}}." —
    // the literal mustache. This test catches that by round-tripping
    // the sweeper-run chit through disk and asserting the body matches
    // the EXPANDED text, not the template source.
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot, {
        name: 'templated-sweeper',
        vars: [{ name: 'target', type: 'string' }],
        steps: [
          {
            id: 'judge',
            title: 'Judge',
            description: 'Decide what to do about {{target}}.',
            moduleRef: null,
          },
        ],
      });
      const { sweeperRun, parsed } = castSweeperFromBlueprint(
        corpRoot,
        bp,
        { target: 'orphan chits' },
        { scope: 'corp', createdBy: 'sexton' },
      );

      // Sanity: parsed snapshot has the expanded text — this is what
      // cast should have written to body.
      expect(parsed.steps[0]!.description).toBe('Decide what to do about orphan chits.');

      // Round-trip: read the chit back from disk. findChitById returns
      // both the chit record and the body (markdown under the YAML
      // frontmatter). Body must be the expanded text, not the template.
      const hit = findChitById(corpRoot, sweeperRun.id);
      expect(hit).not.toBeNull();
      expect(hit!.body.trim()).toBe('Decide what to do about orphan chits.');
      // Negative check — the raw template must NOT be in the body.
      expect(hit!.body).not.toMatch(/\{\{target\}\}/);
    } finally {
      cleanup();
    }
  });

  it('cast-produced sweeper-run inherits registry defaults: ephemeral=true + TTL ~7d', () => {
    // Load-bearing contract: sweeper-run is registered as defaultEphemeral
    // with a 7d TTL, so the chit-lifecycle scanner's destroy-if-not-
    // promoted policy kicks in for unreferenced runs. If createChit ever
    // stops honoring the registry's defaultEphemeral/defaultTTL for
    // this type — silently making runs permanent — stale sweeper-runs
    // would accumulate forever and the 1.9 "sweepers are transient
    // events" thesis would rot. This test catches that class of regression.
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot);
      const before = Date.now();
      const { sweeperRun } = castSweeperFromBlueprint(corpRoot, bp, {}, {
        scope: 'corp',
        createdBy: 'sexton',
      });
      const after = Date.now();

      expect(sweeperRun.ephemeral).toBe(true);
      expect(sweeperRun.ttl).toBeDefined();

      // TTL is an ISO timestamp 7 days out. Allow a day of slop on
      // either side so the test isn't flaky across timezone edges and
      // doesn't hard-code "exactly 604800000 ms."
      const ttlMs = Date.parse(sweeperRun.ttl!);
      expect(Number.isFinite(ttlMs)).toBe(true);
      const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
      expect(ttlMs - before).toBeGreaterThanOrEqual(SIX_DAYS_MS);
      expect(ttlMs - after).toBeLessThanOrEqual(EIGHT_DAYS_MS);
    } finally {
      cleanup();
    }
  });

  it('sweeper-run body is empty when step.description is absent', () => {
    // Code sweepers usually skip description (the module carries its
    // own logic). Body should be an empty string — not "undefined",
    // not the literal "null". Round-trip proves the write landed clean.
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot, {
        name: 'bodyless',
        steps: [
          {
            id: 'run',
            title: 'Run',
            // description absent
            moduleRef: 'session-gc',
          },
        ],
      });
      const { sweeperRun } = castSweeperFromBlueprint(corpRoot, bp, {}, {
        scope: 'corp',
        createdBy: 'sexton',
      });

      const hit = findChitById(corpRoot, sweeperRun.id);
      expect(hit).not.toBeNull();
      expect(hit!.body.trim()).toBe('');
      expect(hit!.body).not.toMatch(/undefined|null/);
    } finally {
      cleanup();
    }
  });
});

// ─── castSweeperFromBlueprint: error paths ──────────────────────────

describe('castSweeperFromBlueprint — error paths', () => {
  it('rejects a draft blueprint with a hint to validate', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot, {}, 'draft');
      expect(() =>
        castSweeperFromBlueprint(corpRoot, bp, {}, {
          scope: 'corp',
          createdBy: 'sexton',
        }),
      ).toThrowError(BlueprintCastError);
      try {
        castSweeperFromBlueprint(corpRoot, bp, {}, {
          scope: 'corp',
          createdBy: 'sexton',
        });
      } catch (err) {
        expect((err as Error).message).toMatch(/only 'active' blueprints can be cast/);
        expect((err as Error).message).toMatch(/validate/);
      }
    } finally {
      cleanup();
    }
  });

  it('rejects a closed blueprint', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot, {}, 'closed');
      expect(() =>
        castSweeperFromBlueprint(corpRoot, bp, {}, {
          scope: 'corp',
          createdBy: 'sexton',
        }),
      ).toThrowError(BlueprintCastError);
    } finally {
      cleanup();
    }
  });

  it('rejects a contract-kind blueprint with routing error', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot, {
        name: 'contract-not-sweeper',
        kind: 'contract',
        steps: [{ id: 's1', title: 'Step', assigneeRole: 'ceo' }],
      });
      expect(() =>
        castSweeperFromBlueprint(corpRoot, bp, {}, {
          scope: 'corp',
          createdBy: 'sexton',
        }),
      ).toThrowError(/castSweeperFromBlueprint requires kind: 'sweeper'/);
    } finally {
      cleanup();
    }
  });

  it('rejects an absent-kind blueprint (defaults to contract)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      // Construct without a `kind` field at all — YAML dump can't
      // serialize `kind: undefined`, and more importantly, the
      // "absent kind" case means the key isn't present, not that
      // it's explicitly the undefined value.
      const bp = createChit(corpRoot, {
        type: 'blueprint',
        scope: 'corp',
        createdBy: 'founder',
        status: 'active',
        fields: {
          blueprint: {
            name: 'absent-kind',
            origin: 'authored',
            steps: [{ id: 's1', title: 'Step', assigneeRole: 'ceo' }],
          },
        },
      });
      expect(() =>
        castSweeperFromBlueprint(corpRoot, bp, {}, {
          scope: 'corp',
          createdBy: 'sexton',
        }),
      ).toThrowError(/castSweeperFromBlueprint requires kind: 'sweeper'/);
    } finally {
      cleanup();
    }
  });

  it('rejects a multi-step sweeper blueprint', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot, {
        name: 'multi-step',
        steps: [
          { id: 'a', title: 'A', moduleRef: 'm1' },
          { id: 'b', title: 'B', moduleRef: 'm2' },
        ],
      });
      expect(() =>
        castSweeperFromBlueprint(corpRoot, bp, {}, {
          scope: 'corp',
          createdBy: 'sexton',
        }),
      ).toThrowError(/must have exactly one step/);
    } finally {
      cleanup();
    }
  });

  it('propagates BlueprintVarError from the parser (missing required var)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot, {
        name: 'needs-var',
        vars: [{ name: 'target', type: 'string' }],
        steps: [
          {
            id: 'judge',
            title: 'Judge {{target}}',
            moduleRef: null,
          },
        ],
      });
      expect(() =>
        castSweeperFromBlueprint(corpRoot, bp, {}, {
          scope: 'corp',
          createdBy: 'sexton',
        }),
      ).toThrowError(BlueprintVarError);
    } finally {
      cleanup();
    }
  });

  it('propagates BlueprintParseError from the parser (undeclared ref)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const bp = createActiveSweeperBlueprint(corpRoot, {
        name: 'bad-template',
        vars: [], // nothing declared
        steps: [
          {
            id: 'judge',
            title: 'Judge {{undeclared_var}}',
            moduleRef: null,
          },
        ],
      });
      expect(() =>
        castSweeperFromBlueprint(corpRoot, bp, {}, {
          scope: 'corp',
          createdBy: 'sexton',
        }),
      ).toThrowError(BlueprintParseError);
    } finally {
      cleanup();
    }
  });
});
