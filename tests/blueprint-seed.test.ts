import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  seedBuiltinBlueprints,
  queryChits,
} from '../packages/shared/src/index.js';

/**
 * seedBuiltinBlueprints is the load-bearing mechanism for 1.9.6 —
 * fresh corps get the shipped patrol blueprints at init. If the
 * shipped markdown files + parseFrontmatter + validateBlueprint +
 * createChit pipeline disagree on any axis, a user's fresh `cc-cli
 * init` silently lands with no patrols + Sexton hits "blueprint not
 * found" on her first wake.
 *
 * One test, end-to-end against the REAL bundled files at
 * `packages/shared/blueprints/patrol/`. The seed module resolves
 * them via its own import.meta.url so we don't mock the bundle
 * path — if the test passes here, the same resolution works for
 * a user running `cc-cli init` against a real install.
 */

describe('seedBuiltinBlueprints', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'seed-blueprints-'));
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      // best-effort; Windows fs-handle races shouldn't fail the test
    }
  });

  it('seeds the 3 shipped patrol blueprints as chits with origin=builtin', () => {
    seedBuiltinBlueprints(corpRoot);

    const result = queryChits<'blueprint'>(corpRoot, {
      types: ['blueprint'],
      scopes: ['corp'],
    });

    const names = result.chits.map((c) => c.chit.fields.blueprint.name).sort();
    expect(names).toEqual([
      'patrol/chit-hygiene',
      'patrol/corp-health',
      'patrol/health-check',
    ]);
  });

  it('every seeded blueprint has origin=builtin (forced by the seeder regardless of file claim)', () => {
    seedBuiltinBlueprints(corpRoot);

    const result = queryChits<'blueprint'>(corpRoot, {
      types: ['blueprint'],
      scopes: ['corp'],
    });

    for (const item of result.chits) {
      expect(item.chit.fields.blueprint.origin).toBe('builtin');
    }
  });

  it('seeded blueprints have non-empty steps (validator would have rejected empty)', () => {
    seedBuiltinBlueprints(corpRoot);

    const result = queryChits<'blueprint'>(corpRoot, {
      types: ['blueprint'],
      scopes: ['corp'],
    });

    for (const item of result.chits) {
      const steps = item.chit.fields.blueprint.steps;
      expect(steps.length).toBeGreaterThan(0);
      // Each step must carry at least id + title (BlueprintStep contract)
      for (const step of steps) {
        expect(step.id).toBeTruthy();
        expect(step.title).toBeTruthy();
      }
    }
  });

  it('seeded blueprints land with status=active (ready to show/walk)', () => {
    seedBuiltinBlueprints(corpRoot);

    const result = queryChits<'blueprint'>(corpRoot, {
      types: ['blueprint'],
      scopes: ['corp'],
      statuses: ['active'],
    });

    // All 3 should come back under status=active filter — if the
    // seeder landed them as 'draft' (the default for authored
    // blueprints), cc-cli blueprint show wouldn't find them.
    expect(result.chits.length).toBe(3);
  });

  it('runs without throwing even when invoked twice (not idempotent, but non-fatal)', () => {
    // The seeder is documented NOT idempotent — second call writes
    // fresh duplicate chits with new auto-generated ids. But it
    // shouldn't THROW; scaffoldCorp's try/catch around the call
    // relies on this behavior.
    seedBuiltinBlueprints(corpRoot);
    expect(() => seedBuiltinBlueprints(corpRoot)).not.toThrow();
  });
});
