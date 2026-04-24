/**
 * Seed built-in blueprint chits from bundled markdown files.
 *
 * At corp-init time, Claude Corp ships a small set of opinionated
 * built-in blueprints (patrols Sexton walks, and — later — the
 * shipped library like `ship-feature`, `fix-bug`, etc. from Project
 * 2.3). These live as markdown files under
 * `packages/shared/blueprints/` in source + in the published
 * package's dist tree, same as the `skills/` assets.
 *
 * At `cc-cli init`, this function walks the bundled directory,
 * reads each .md file, parses its YAML frontmatter into
 * `BlueprintFields`, and calls `createChit` to write a proper
 * blueprint chit into the new corp. From that moment on, the
 * built-ins are chits in the user's corp — same shape as anything
 * authored via `cc-cli blueprint new`, fully queryable,
 * castable, and editable with standard chit-store tools.
 *
 * ### `origin: 'builtin'` — the re-sync discriminator
 *
 * Every seeded chit lands with `fields.blueprint.origin =
 * 'builtin'`. User-authored blueprints (via `cc-cli blueprint
 * new`) get `origin: 'authored'`. A future `cc-cli update
 * --sync-builtins` command (out of scope here, deferred per
 * REFACTOR.md's 0.7.5 note) uses this discriminator to decide
 * what to refresh when a newer Claude Corp build ships an
 * updated built-in: re-seed `builtin` chits (respecting user
 * edits with a flag), leave `authored` ones untouched.
 *
 * ### Why markdown files on disk, not TypeScript constants
 *
 * Two reasons that matter once users arrive:
 *
 *   1. User-authored blueprints via `cc-cli blueprint new` are
 *      markdown-with-frontmatter chit files. If built-ins were
 *      TS constants, users editing a seeded built-in vs
 *      authoring a new one would experience two different worlds
 *      (one file in their corp vs "the TypeScript source which
 *      they can't edit because they don't have the repo"). The
 *      markdown-file model keeps both worlds the same.
 *
 *   2. Users don't modify Claude Corp's source. The bundled .md
 *      files are dev-owned; users only see the SEEDED chits in
 *      their corp. Same trust boundary as `skills/` — shipped by
 *      devs, owned by users once in their corp.
 *
 * ### Failure behavior
 *
 * Best-effort per blueprint: a single malformed .md in the
 * bundle logs + skips. Corp init does not abort on seed failures.
 * A missing bundle dir (which shouldn't happen in a proper
 * install but might in a frozen-dist edge case) returns early
 * without throwing. A missing built-in blueprint is an
 * observability gap, not a dealbreaker for the corp.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseFrontmatter } from './parsers/frontmatter.js';
import { createChit } from './chits.js';
import type { BlueprintFields } from './types/chit.js';

/**
 * Resolve the bundled blueprints directory shipped with the
 * package. Mirrors `getBundledSkillsDir` from skills.ts — works
 * both in source (src/ → ../../blueprints) and compiled
 * (dist/ → ../blueprints) contexts.
 */
function getBundledBlueprintsDir(): string | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const candidates = [
      resolve(thisFile, '..', '..', 'blueprints'),        // from dist/
      resolve(thisFile, '..', '..', '..', 'blueprints'),  // from src/
    ];
    for (const c of candidates) {
      if (existsSync(c) && isNonEmptyDir(c)) return c;
    }
  } catch {
    // File-url resolution failed (unusual ESM quirk). Treat as
    // "no bundle found" and let caller no-op.
  }
  return null;
}

function isNonEmptyDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/**
 * Recursively collect .md files under a directory. We walk shallowly
 * enough (blueprints/category/file.md) that we don't need a
 * full-tree walker, but the recursive shape handles arbitrary
 * sub-categories as the bundle grows (patrol/, library/, sweeper/,
 * ...).
 */
function findMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        stack.push(full);
      } else if (entry.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * Seed built-in blueprint chits from bundled .md files into a
 * freshly-scaffolded corp. No-op if the bundle dir is missing
 * (frozen-dist edge case, best-effort). Best-effort per file:
 * a single parse failure logs (via console.error) + skips,
 * doesn't abort the seed pass.
 *
 * Idempotency: this function does NOT check for pre-existing
 * blueprint chits. It's intended to run ONCE at corp-init,
 * when the corp's chit store is empty. Calling it again on an
 * existing corp would produce duplicate chit IDs if blueprint
 * ids are auto-generated, or conflict errors if they're not.
 * The future `cc-cli update --sync-builtins` command handles
 * the update-existing-corp path with explicit idempotency.
 */
export function seedBuiltinBlueprints(corpRoot: string): void {
  const bundled = getBundledBlueprintsDir();
  if (!bundled) return;

  const files = findMarkdownFiles(bundled);
  for (const filePath of files) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const { meta, body } = parseFrontmatter<Partial<BlueprintFields>>(raw);

      // Validation guardrails on frontmatter. If a bundled blueprint
      // is missing required fields, that's a dev-side bug worth
      // surfacing at seed time — but as a log line, not a corp-
      // init abort.
      if (!meta || typeof meta.name !== 'string' || !Array.isArray(meta.steps)) {
        // eslint-disable-next-line no-console
        console.error(
          `[seed-blueprints] skipping ${filePath}: missing required frontmatter (name, steps)`,
        );
        continue;
      }

      // Force origin='builtin' regardless of what the file claims —
      // the bundle is dev-shipped; anything seeded FROM it is
      // builtin-by-definition. Defensive: catches a bundled file
      // accidentally shipped with origin='authored'.
      const fields: BlueprintFields = {
        name: meta.name,
        steps: meta.steps,
        origin: 'builtin',
        ...(meta.kind !== undefined && { kind: meta.kind }),
        ...(meta.vars !== undefined && { vars: meta.vars }),
        ...(meta.title !== undefined && { title: meta.title }),
        ...(meta.summary !== undefined && { summary: meta.summary }),
      };

      createChit(corpRoot, {
        type: 'blueprint',
        scope: 'corp',
        createdBy: 'system',
        status: 'active',
        fields: { blueprint: fields },
        ...(body.length > 0 && { body }),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[seed-blueprints] failed to seed ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
