/**
 * Blueprint name resolution — Project 1.8 PR 3.
 *
 * CLI surfaces (`cc-cli blueprint cast <name>`, `show`, `validate`) and
 * programmatic consumers (Sexton's patrol dispatch in 1.9 cooking
 * `patrol/health-check` by name) all share one lookup pattern:
 *   - resolve human-typeable name → Chit<'blueprint'>
 *   - respect scope precedence (project-specific overrides corp-wide)
 *   - accept either the blueprint `name` field or a raw chit id
 *
 * Centralizing the lookup here keeps every caller consistent and lets
 * future refinements (caching, index files, name-conflict reporting)
 * land in one place.
 *
 * Pure on top of queryChits / findChitById — no additional I/O.
 */

import type { ChitScope } from './types/chit.js';
import { queryChits, findChitById, isChitIdFormat, type ChitWithBody } from './chits.js';

// ─── Options ────────────────────────────────────────────────────────

export interface BlueprintLookupOpts {
  /**
   * Preferred scopes in precedence order. First scope that has a
   * matching blueprint wins. Absent → defaults to `['corp']` (corp-wide
   * only — the common case for founder-driven casts).
   *
   * Typical caller patterns:
   *   - Founder casting into a project:
   *       `['project:<name>', 'corp']`
   *   - Agent casting from their own authored blueprint:
   *       `['agent:<slug>', 'corp']`
   *   - Sexton's patrol cooking corp-wide:
   *       `['corp']` (default)
   */
  scopes?: readonly ChitScope[];
  /**
   * When true (default), only `status: 'active'` blueprints match —
   * draft blueprints aren't cookable yet, closed ones are retired.
   *
   * Pass `false` from `cc-cli blueprint show --include-draft` and from
   * `cc-cli blueprint validate` (which needs to see drafts to promote
   * them). The cast primitive itself also status-checks at write
   * time; the lookup just avoids surfacing drafts to the happy path.
   */
  activeOnly?: boolean;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Find a blueprint chit by its `name` field, respecting scope
 * precedence. Returns null if no match across any of the configured
 * scopes.
 *
 * Name-collision note: a blueprint name can legitimately exist in
 * multiple scopes (a project's `ship-feature` overriding the corp's).
 * Resolution stops at the first scope with a match — the most
 * specific scope in the caller's `scopes` list wins. Collision
 * DETECTION (flagging duplicates within a single scope) is a CLI
 * boundary concern enforced by `cc-cli blueprint new`.
 */
export function findBlueprintByName(
  corpRoot: string,
  name: string,
  opts: BlueprintLookupOpts = {},
): ChitWithBody<'blueprint'> | null {
  const scopes = opts.scopes ?? (['corp'] as const);
  const activeOnly = opts.activeOnly ?? true;

  for (const scope of scopes) {
    const result = queryChits<'blueprint'>(corpRoot, {
      types: ['blueprint'],
      scopes: [scope],
      includeArchive: false,
    });

    const match = result.chits.find((cwb) => {
      const bp = cwb.chit.fields.blueprint;
      if (bp.name !== name) return false;
      if (activeOnly && cwb.chit.status !== 'active') return false;
      return true;
    });

    if (match) return match;
  }

  return null;
}

/**
 * Resolve a reference that may be EITHER a blueprint name OR a raw
 * chit id (`chit-b-a1b2c3d4`). CLI commands accept either form so the
 * founder can paste an id from a log message without having to switch
 * to looking up the human name. isChitIdFormat decides the path.
 *
 * When the id path is taken, scope precedence is irrelevant — chit
 * ids are corp-wide unique, so `findChitById` walks all scopes and
 * returns the single match (or null).
 *
 * Returns null if the reference doesn't match a blueprint chit.
 */
export function resolveBlueprint(
  corpRoot: string,
  nameOrId: string,
  opts: BlueprintLookupOpts = {},
): ChitWithBody<'blueprint'> | null {
  if (isChitIdFormat(nameOrId)) {
    const hit = findChitById(corpRoot, nameOrId);
    if (!hit || hit.chit.type !== 'blueprint') return null;
    // activeOnly filter applied even on id-path so behavior is
    // consistent regardless of lookup form. Callers that want drafts
    // via id pass `activeOnly: false`.
    if (opts.activeOnly !== false && hit.chit.status !== 'active') {
      return null;
    }
    return hit as ChitWithBody<'blueprint'>;
  }
  return findBlueprintByName(corpRoot, nameOrId, opts);
}

// ─── Listing helper (for `cc-cli blueprint list`) ───────────────────

export interface BlueprintListOpts {
  /**
   * Filter to these scopes. Absent → walks every discoverable scope
   * (agent / project / corp). Useful for `cc-cli blueprint list` where
   * the founder wants a corp-wide view.
   */
  scopes?: readonly ChitScope[];
  /**
   * Include draft / closed blueprints in the result. Default false
   * (active only — the common case). `cc-cli blueprint list --all`
   * opts into seeing everything.
   */
  includeNonActive?: boolean;
}

/**
 * List all blueprint chits matching the filter. Unlike
 * findBlueprintByName this doesn't early-return on first match — it
 * collects every blueprint for surface rendering.
 *
 * Note: name-collisions across scopes are returned as separate
 * entries (same name, different scope). The CLI list command surfaces
 * the scope alongside the name so the collision is visible.
 */
export function listBlueprintChits(
  corpRoot: string,
  opts: BlueprintListOpts = {},
): ChitWithBody<'blueprint'>[] {
  const result = queryChits<'blueprint'>(corpRoot, {
    types: ['blueprint'],
    ...(opts.scopes ? { scopes: opts.scopes } : {}),
    includeArchive: false,
  });

  return result.chits.filter(
    (cwb) => opts.includeNonActive || cwb.chit.status === 'active',
  );
}
