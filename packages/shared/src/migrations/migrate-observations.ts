/**
 * Migration: convert pre-chits daily observation logs to Chit files.
 *
 * Pre-chits format: <corpRoot>/agents/<slug>/observations/YYYY/MM/YYYY-MM-DD.md
 * Each file holds N observations as markdown bullets:
 *   - HH:MM [CATEGORY] description (files: a.md, b.md)
 *
 * Post-migration: each bullet becomes its own chit of type=observation at
 *   <corpRoot>/agents/<slug>/chits/observation/<id>.md
 * with scope agent:<slug>. The daily log file is deleted once all its
 * bullets are migrated.
 *
 * One-to-many: a single daily log file typically produces 10-50 chits.
 * This is the main structural difference from the task/contract migrations
 * which were 1:1 record→chit.
 *
 * Lossy category mapping. Pre-chits ObservationCategory is a work-activity
 * vocabulary (TASK/RESEARCH/BLOCKED/LEARNED/CREATED/REVIEWED/CHECKPOINT/
 * SLUMBER/ERROR/HANDOFF/FEEDBACK/DECISION). Chit ObservationFields.category
 * is a dream-distillation vocabulary (FEEDBACK/DECISION/DISCOVERY/PREFERENCE/
 * NOTICE/CORRECTION). The mapping loses granularity — activity categories
 * collapse to NOTICE-or-nearest, with the original preserved as a tag
 * `from-log:<ORIGINAL>` so it's queryable without cluttering the
 * ObservationFields schema. Bullet text preserved verbatim in chit body.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Chit, ObservationFields } from '../types/chit.js';
import { atomicWriteSync } from '../atomic-write.js';
import { stringify as stringifyFrontmatter } from '../parsers/frontmatter.js';
import { chitId, chitPath } from '../chits.js';

export interface ObservationMigrationResult {
  /** Number of daily log files processed. */
  filesProcessed: number;
  /** Total bullets migrated across all files. */
  migrated: number;
  /** Lines that couldn't be parsed (malformed bullets in otherwise valid files). */
  skipped: number;
  /** Per-file errors that prevented migration. */
  errors: Array<{ sourcePath: string; error: string }>;
  /** Planned migrations (populated when dryRun=true). */
  planned: Array<{ sourcePath: string; chitCount: number }>;
}

export interface ObservationMigrationOpts {
  dryRun?: boolean;
  /** If true, migrate even if the chit count in an existing target dir already matches — rare; default false. */
  overwrite?: boolean;
}

/** Pre-chits ObservationCategory (copied here to avoid import coupling). */
type LogCategory =
  | 'TASK'
  | 'RESEARCH'
  | 'DECISION'
  | 'BLOCKED'
  | 'LEARNED'
  | 'CREATED'
  | 'REVIEWED'
  | 'CHECKPOINT'
  | 'SLUMBER'
  | 'ERROR'
  | 'HANDOFF'
  | 'FEEDBACK';

/** Chit ObservationFields category values. */
type ChitObsCategory = ObservationFields['category'];

/**
 * Translate the pre-chits work-activity category into the chit dream-
 * distillation vocabulary. Lossy — multiple activity categories collapse
 * to NOTICE. The original is preserved as a tag downstream.
 */
function mapCategory(old: LogCategory | string): ChitObsCategory {
  switch (old) {
    case 'DECISION':
      return 'DECISION';
    case 'FEEDBACK':
      return 'FEEDBACK';
    case 'RESEARCH':
    case 'LEARNED':
      return 'DISCOVERY';
    case 'ERROR':
      return 'CORRECTION';
    // TASK, BLOCKED, CREATED, REVIEWED, CHECKPOINT, SLUMBER, HANDOFF
    // and anything unknown → NOTICE (most neutral).
    default:
      return 'NOTICE';
  }
}

/** Parse a daily observation log bullet line. Returns null if malformed. */
function parseBulletLine(
  line: string,
): { localTime: string; category: string; description: string; files: string[] } | null {
  const match = line.match(
    /^- (\d{2}:\d{2}) \[(\w+)] (.+?)(?:\s*\(files: (.+?)\))?$/,
  );
  if (!match) return null;
  return {
    localTime: match[1]!,
    category: match[2]!,
    description: match[3]!.trim(),
    files: match[4] ? match[4].split(',').map((f) => f.trim()) : [],
  };
}

/** Combine a YYYY-MM-DD filename date + HH:MM bullet time → full ISO timestamp. */
function combineToIso(dateFromFilename: string, localTime: string): string {
  // dateFromFilename = "2026-04-20", localTime = "14:32" → "2026-04-20T14:32:00.000Z"
  return `${dateFromFilename}T${localTime}:00.000Z`;
}

/**
 * Convert a parsed bullet + context into a Chit of type=observation.
 * Pure function — no I/O. Exported for unit tests.
 */
export function bulletToChit(opts: {
  agentSlug: string;
  dateFromFilename: string; // YYYY-MM-DD
  bullet: {
    localTime: string;
    category: string;
    description: string;
    files: string[];
  };
}): Chit<'observation'> {
  const mappedCategory = mapCategory(opts.bullet.category);
  const timestamp = combineToIso(opts.dateFromFilename, opts.bullet.localTime);

  const fields: ObservationFields = {
    category: mappedCategory,
    subject: opts.agentSlug, // best effort: observation author is the subject of its own log
    importance: 2, // Activity-log observations default to medium-low; explicit noticings can rate higher.
    title: opts.bullet.description.slice(0, 80),
    context: opts.bullet.description,
  };

  // Preserve the original log category in tags so the info isn't lost after
  // the lossy category translation. File references become tag entries too.
  const tags = [`from-log:${opts.bullet.category}`];
  for (const f of opts.bullet.files) tags.push(`file:${f}`);

  return {
    id: chitId('observation'),
    type: 'observation',
    status: 'active',
    ephemeral: true, // Observations default ephemeral per chit-types.ts registry.
    // TTL omitted — createChit wasn't called, so we need to hand-set. Registry
    // default is 7d but for migrated historical observations, leave ttl undefined
    // so they don't get swept by the lifecycle scanner immediately. The promoted-
    // by-4-signal mechanism (0.6) can still elevate them to permanent later.
    createdBy: opts.agentSlug,
    createdAt: timestamp,
    updatedAt: timestamp,
    references: [],
    dependsOn: [],
    tags,
    fields: { observation: fields },
  } as Chit<'observation'>;
}

/**
 * Walk <corpRoot>/agents/*\/observations/YYYY/MM/*.md and migrate every
 * bullet to its own chit. Files get deleted after all their bullets are
 * successfully migrated; partial migration leaves the source untouched
 * so the user can re-run.
 */
export function migrateObservationsToChits(
  corpRoot: string,
  opts: ObservationMigrationOpts = {},
): ObservationMigrationResult {
  const result: ObservationMigrationResult = {
    filesProcessed: 0,
    migrated: 0,
    skipped: 0,
    errors: [],
    planned: [],
  };

  const agentsDir = join(corpRoot, 'agents');
  if (!existsSync(agentsDir)) return result;

  for (const agentEntry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agentEntry.isDirectory()) continue;
    const agentSlug = agentEntry.name;
    const obsDir = join(agentsDir, agentSlug, 'observations');
    if (!existsSync(obsDir)) continue;

    // Walk YYYY/MM/YYYY-MM-DD.md
    try {
      for (const year of readdirSync(obsDir, { withFileTypes: true })) {
        if (!year.isDirectory()) continue;
        const yearDir = join(obsDir, year.name);
        for (const month of readdirSync(yearDir, { withFileTypes: true })) {
          if (!month.isDirectory()) continue;
          const monthDir = join(yearDir, month.name);
          for (const file of readdirSync(monthDir)) {
            if (!file.endsWith('.md')) continue;
            const sourcePath = join(monthDir, file);
            const dateFromFilename = file.replace(/\.md$/, '');
            migrateObservationFile(
              corpRoot,
              agentSlug,
              sourcePath,
              dateFromFilename,
              opts,
              result,
            );
          }
        }
      }
    } catch (err) {
      result.errors.push({ sourcePath: obsDir, error: (err as Error).message });
    }
  }

  return result;
}

/**
 * Inner helper: migrate all bullets in a single daily log file. Writes a
 * chit per bullet, deletes the source if all bullets migrated (or the
 * file was empty). Partial failure (e.g. mid-way through writes) leaves
 * the source intact and errors recorded — re-running will pick up from
 * the same state because createChit idempotency isn't available for
 * observations (each run generates fresh ids), so we skip files where
 * existing chits for the same (agent,date) already cover the bullets.
 */
function migrateObservationFile(
  corpRoot: string,
  agentSlug: string,
  sourcePath: string,
  dateFromFilename: string,
  opts: ObservationMigrationOpts,
  result: ObservationMigrationResult,
): void {
  let content: string;
  try {
    content = readFileSync(sourcePath, 'utf-8');
  } catch (err) {
    result.errors.push({ sourcePath, error: (err as Error).message });
    return;
  }

  // Idempotency: if a chits/observation/ dir for this agent already has
  // chits whose createdAt falls on this date, assume the file was migrated
  // previously. Skip unless --overwrite.
  if (!opts.overwrite && hasExistingObservationsForDate(corpRoot, agentSlug, dateFromFilename)) {
    return;
  }

  result.filesProcessed++;

  const bulletLines = content.split('\n').filter((l) => l.startsWith('- '));
  const parsed = bulletLines
    .map((line) => ({ line, parsed: parseBulletLine(line) }))
    .filter((x) => {
      if (x.parsed === null) {
        result.skipped++;
        return false;
      }
      return true;
    });

  if (parsed.length === 0) {
    // Empty or all-malformed file — delete the source so it doesn't keep
    // showing up in future migration runs.
    if (!opts.dryRun) {
      try {
        rmSync(sourcePath);
      } catch {
        /* non-fatal — the file may be locked on Windows */
      }
    }
    return;
  }

  if (opts.dryRun) {
    result.planned.push({ sourcePath, chitCount: parsed.length });
    return;
  }

  // Write one chit per parsed bullet. Composes the body as the original
  // markdown bullet so the raw text is preserved verbatim.
  let anyFailed = false;
  for (const { line, parsed: bullet } of parsed) {
    if (!bullet) continue;
    try {
      const chit = bulletToChit({
        agentSlug,
        dateFromFilename,
        bullet,
      });
      const targetPath = chitPath(corpRoot, `agent:${agentSlug}`, 'observation', chit.id);
      const body = `Migrated from ${sourcePath}:\n\n\`\`\`\n${line}\n\`\`\`\n`;
      const frontmatterContent = stringifyFrontmatter(
        chit as unknown as Record<string, unknown>,
        body,
      );
      atomicWriteSync(targetPath, frontmatterContent);
      result.migrated++;
    } catch (err) {
      result.errors.push({ sourcePath, error: (err as Error).message });
      anyFailed = true;
    }
  }

  // Delete source only if every bullet migrated cleanly.
  if (!anyFailed) {
    try {
      rmSync(sourcePath);
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Idempotency check: do any observation chits for this agent have
 * createdAt falling on the given YYYY-MM-DD? Cheap enough to do per-file
 * since chit paths are predictable — read the agent's observation
 * directory and check any file's createdAt prefix.
 */
function hasExistingObservationsForDate(
  corpRoot: string,
  agentSlug: string,
  dateFromFilename: string,
): boolean {
  const obsDir = join(corpRoot, 'agents', agentSlug, 'chits', 'observation');
  if (!existsSync(obsDir)) return false;

  try {
    const files = readdirSync(obsDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const p = join(obsDir, file);
      try {
        // Only read the first ~200 bytes — enough for the frontmatter
        // createdAt line. Avoid full-parse cost for the idempotency check.
        const head = readFileSync(p, 'utf-8').slice(0, 400);
        if (head.includes(`createdAt: '${dateFromFilename}T`) || head.includes(`createdAt: ${dateFromFilename}T`)) {
          return true;
        }
      } catch {
        // Skip unreadable files
        statSync; // keep import used
      }
    }
  } catch {
    /* non-fatal */
  }
  return false;
}
