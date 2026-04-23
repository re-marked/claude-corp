/**
 * observations.ts — thin compatibility wrapper over the chit primitive.
 *
 * Post-0.5-migration, observations live as Chits of type=observation
 * under agent:<slug> scope. This module preserves the pre-chits external
 * API (appendObservation / observe / readTodaysObservations /
 * parseObservations / listObservationLogs / countRecentObservations)
 * so the 3 daemon callers (dreams.ts, morning-standup.ts) keep working
 * without edits. Same function signatures, new storage.
 *
 * Semantic preservation notes:
 *
 *   - The pre-chits `ObservationCategory` work-activity vocabulary stays
 *     intact at the external API boundary. Internally, `observe()` stores
 *     the chit with a translated category (per migrate-observations.ts
 *     mapping) but also tags it `from-log:<ORIGINAL>` so the original
 *     is round-trip recoverable.
 *
 *   - `readTodaysObservations(agentDir): string` synthesizes markdown
 *     bullets from today's chits, matching the old daily-log format
 *     so parseObservations and any consumer that string-searches the
 *     output keep working.
 *
 *   - `listObservationLogs(agentDir)` returns date-grouped entries
 *     derived from chit createdAt timestamps. The `path` field points
 *     at the agent's chit directory (no single per-day file anymore);
 *     it's kept populated for callers that want a location to display
 *     but should not be read directly.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createChit, queryChits } from './chits.js';
import type { Chit, ObservationFields } from './types/chit.js';

// ── Types ────────────────────────────────────────────────────────────

export type ObservationCategory =
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

export interface Observation {
  /** ISO timestamp */
  timestamp: string;
  /** Local time string (HH:MM) for display */
  localTime: string;
  /** Category tag (work-activity vocabulary) */
  category: ObservationCategory;
  /** Human-readable description */
  description: string;
  /** Optional file paths involved */
  files?: string[];
  /** Optional agent who made this observation */
  agentId?: string;
}

export interface ObservationLogStats {
  /** Total entries for today */
  entryCount: number;
  /** Categories with counts */
  categoryCounts: Partial<Record<ObservationCategory, number>>;
  /** First entry time (HH:MM) */
  firstEntry: string | null;
  /** Last entry time (HH:MM) */
  lastEntry: string | null;
  /** Display path — agent's chit directory (not a single file post-chits). */
  logPath: string;
}

// ── Path derivation ──────────────────────────────────────────────────

/**
 * Extract corpRoot + agent slug from an agentDir path.
 * Expected shape: <corpRoot>/agents/<slug>.
 */
function parseAgentDir(agentDir: string): { corpRoot: string; slug: string } {
  const slug = basename(agentDir);
  const agentsDir = dirname(agentDir);
  if (basename(agentsDir) !== 'agents') {
    throw new Error(`expected path to end in agents/<slug>: ${agentDir}`);
  }
  const corpRoot = dirname(agentsDir);
  return { corpRoot, slug };
}

/**
 * Pre-chits path helper — retained for API compatibility. Returns the
 * per-agent chit directory for observations (the closest single-location
 * analogue to the old daily-log file). The `date` parameter is ignored
 * since chits are individually filed; callers that need date-filtered
 * data should use readObservationsForDate / queryChits directly.
 */
export function getObservationLogPath(agentDir: string, _date?: Date): string {
  return getObservationsDir(agentDir);
}

/**
 * The agent's observation-chit directory. Replaces the old `observations/`
 * directory; agents-written raw files at the old path are migrated by
 * `cc-cli migrate observations` and don't accumulate going forward.
 */
export function getObservationsDir(agentDir: string): string {
  return join(agentDir, 'chits', 'observation');
}

// ── Category translation (lossy, matches migrate-observations.ts) ────

function mapToChitCategory(old: ObservationCategory): ObservationFields['category'] {
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
    default:
      // TASK, BLOCKED, CREATED, REVIEWED, CHECKPOINT, SLUMBER, HANDOFF.
      return 'NOTICE';
  }
}

// ── Format helpers ───────────────────────────────────────────────────

/** Format an Observation as a markdown bullet. Identical output to pre-chits. */
export function formatObservation(obs: Observation): string {
  const filesNote = obs.files?.length ? ` (files: ${obs.files.join(', ')})` : '';
  return `- ${obs.localTime} [${obs.category}] ${obs.description}${filesNote}`;
}

/** Parse observation bullets from markdown text. Pure; unchanged from pre-chits. */
export function parseObservations(content: string): Observation[] {
  const lines = content.split('\n').filter((l) => l.startsWith('- '));
  return lines
    .map((line) => {
      const match = line.match(
        /^- (\d{2}:\d{2}) \[(\w+)] (.+?)(?:\s*\(files: (.+?)\))?$/,
      );
      if (!match) return null;
      const obs: Observation = {
        timestamp: '',
        localTime: match[1]!,
        category: match[2] as ObservationCategory,
        description: match[3]!.trim(),
        files: match[4]?.split(',').map((f) => f.trim()),
      };
      return obs;
    })
    .filter((o): o is Observation => o !== null);
}

// ── Write ────────────────────────────────────────────────────────────

/**
 * Append an observation entry. Post-chits, this writes a chit of type=
 * observation at <corpRoot>/agents/<slug>/chits/observation/<id>.md
 * instead of appending to a daily-log file. Same call surface: callers
 * pass an Observation shape, the wrapper handles storage.
 */
export function appendObservation(agentDir: string, obs: Observation): void {
  const { corpRoot, slug } = parseAgentDir(agentDir);

  // Ensure target dir exists (atomicWriteSync handles this too but explicit
  // mkdirSync keeps the setup legible for callers debugging storage layout).
  mkdirSync(getObservationsDir(agentDir), { recursive: true });

  const mappedCategory = mapToChitCategory(obs.category);
  const fields: ObservationFields = {
    category: mappedCategory,
    subject: obs.agentId ?? slug,
    importance: 2, // Same default as migration; explicit scoring comes later.
    title: obs.description.slice(0, 80),
    context: obs.description,
  };

  const tags: string[] = [`from-log:${obs.category}`];
  if (obs.files && obs.files.length > 0) {
    for (const f of obs.files) tags.push(`file:${f}`);
  }

  createChit(corpRoot, {
    type: 'observation',
    scope: `agent:${slug}`,
    fields: { observation: fields },
    createdBy: obs.agentId ?? slug,
    tags,
    // Observation-chit ephemeral + ttl defaults come from the registry.
  });
}

/** Convenience wrapper: create + append in one call. */
export function observe(
  agentDir: string,
  category: ObservationCategory,
  description: string,
  files?: string[],
  agentId?: string,
): void {
  const now = new Date();
  appendObservation(agentDir, {
    timestamp: now.toISOString(),
    localTime: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    category,
    description,
    files,
    agentId,
  });
}

// ── Read ─────────────────────────────────────────────────────────────

/**
 * Convert a chit back to the legacy Observation shape so string-synthesis
 * matches the pre-chits daily-log format exactly. The original activity
 * category is recovered from the `from-log:<ORIG>` tag so the wire
 * format doesn't lose the work-activity vocabulary.
 */
function chitToObservation(chit: Chit<'observation'>): Observation {
  const fromLogTag = chit.tags.find((t) => t.startsWith('from-log:'));
  const originalCategory = fromLogTag
    ? fromLogTag.slice('from-log:'.length)
    : 'TASK'; // no-tag fallback (observation created outside observe() — rare)

  const files = chit.tags
    .filter((t) => t.startsWith('file:'))
    .map((t) => t.slice('file:'.length));

  const created = new Date(chit.createdAt);
  const localTime = `${String(created.getHours()).padStart(2, '0')}:${String(created.getMinutes()).padStart(2, '0')}`;

  return {
    timestamp: chit.createdAt,
    localTime,
    category: originalCategory as ObservationCategory,
    description:
      chit.fields.observation.context ?? chit.fields.observation.title ?? '(no description)',
    files: files.length > 0 ? files : undefined,
    agentId: chit.createdBy,
  };
}

/** Header line matching the pre-chits daily log format. */
function dailyLogHeader(date: Date): string {
  return `# Observations — ${date.toISOString().slice(0, 10)}\n\n`;
}

/**
 * Read today's observations as a markdown string. Synthesizes the
 * bullets from chit storage so consumers that string-search or pass
 * to parseObservations keep working.
 */
export function readTodaysObservations(agentDir: string): string {
  return readObservationsForDate(agentDir, new Date());
}

/** Read observations for a specific date. */
export function readObservationsForDate(agentDir: string, date: Date): string {
  const { corpRoot, slug } = parseAgentDir(agentDir);
  const dateStr = date.toISOString().slice(0, 10);
  const dayStart = `${dateStr}T00:00:00.000Z`;
  const dayEnd = `${dateStr}T23:59:59.999Z`;

  const { chits } = queryChits(corpRoot, {
    types: ['observation'],
    scopes: [`agent:${slug}`],
    // Slice by creation — "observations on date X" means "written on
    // that day," not "touched on that day." Lifecycle scanner cooling
    // bumps updatedAt, so the old updatedSince/updatedUntil pair made
    // a cooled-today observation vanish from its original day's log
    // and appear in today's — the daily-log contract broke silently
    // as chits aged. createdAt is immutable after initial write, so
    // the day window is stable for the life of the observation.
    createdSince: dayStart,
    createdUntil: dayEnd,
    sortBy: 'createdAt',
    sortOrder: 'asc',
    limit: 0,
    // Include cold observations: a caller asking for "observations on date X"
    // wants every observation from that date, regardless of whether the
    // lifecycle scanner has since cooled them. Cold preserves the data;
    // only the default query surface hides it.
    includeCold: true,
  });

  if (chits.length === 0) return '';

  let out = dailyLogHeader(date);
  for (const { chit } of chits) {
    const obs = chitToObservation(chit as Chit<'observation'>);
    out += formatObservation(obs) + '\n';
  }
  return out;
}

/** Stats for today's observations via chit query. */
export function getObservationStats(agentDir: string): ObservationLogStats | null {
  const content = readTodaysObservations(agentDir);
  if (!content) return null;
  const observations = parseObservations(content);
  const categoryCounts: Partial<Record<ObservationCategory, number>> = {};
  for (const obs of observations) {
    categoryCounts[obs.category] = (categoryCounts[obs.category] ?? 0) + 1;
  }
  return {
    entryCount: observations.length,
    categoryCounts,
    firstEntry: observations[0]?.localTime ?? null,
    lastEntry: observations.at(-1)?.localTime ?? null,
    logPath: getObservationsDir(agentDir),
  };
}

/**
 * List all dates with observation chits, newest first. Each entry:
 * { date, path, size }. `path` is the agent's chit directory (shared
 * across all dates — no single per-day file anymore); `size` is an
 * approximate sum of chit file sizes for that date, useful for
 * dashboard rendering.
 */
export function listObservationLogs(
  agentDir: string,
): Array<{ date: string; path: string; size: number }> {
  const obsDir = getObservationsDir(agentDir);
  if (!existsSync(obsDir)) return [];

  let chits: Array<{ chit: Chit; path: string }>;
  try {
    const { corpRoot, slug } = parseAgentDir(agentDir);
    const result = queryChits(corpRoot, {
      types: ['observation'],
      scopes: [`agent:${slug}`],
      sortBy: 'createdAt',
      sortOrder: 'desc',
      limit: 0,
      // listObservationLogs is the "all history" enumeration — cold
      // observations are part of that history and must not disappear.
      includeCold: true,
    });
    chits = result.chits;
  } catch {
    return [];
  }

  // Group by YYYY-MM-DD
  const byDate = new Map<string, number>(); // date → byte-size accumulator
  for (const { chit, path } of chits) {
    const date = chit.createdAt.slice(0, 10); // YYYY-MM-DD
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      /* non-fatal */
    }
    byDate.set(date, (byDate.get(date) ?? 0) + size);
  }

  return [...byDate.entries()]
    .map(([date, size]) => ({ date, path: obsDir, size }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Count observations made within the last N days. Goes direct to
 * queryChits for efficiency — skips the daily-log materialization path.
 */
export function countRecentObservations(agentDir: string, sinceDaysAgo = 7): number {
  let corpRoot: string;
  let slug: string;
  try {
    ({ corpRoot, slug } = parseAgentDir(agentDir));
  } catch {
    return 0;
  }

  const cutoff = new Date(Date.now() - sinceDaysAgo * 86_400_000).toISOString();
  const { chits } = queryChits(corpRoot, {
    types: ['observation'],
    scopes: [`agent:${slug}`],
    // "Recent" means authored-in-the-last-N-days, not touched-in-the-
    // last-N-days. Lifecycle cooling would otherwise falsely inflate
    // the count with stale observations whose updatedAt got bumped by
    // the scanner. Dreams read this count to decide whether an agent
    // has enough fresh material to distill — that call must track
    // genuine creative activity, not scanner churn.
    createdSince: cutoff,
    limit: 0,
    // Count every observation in the window regardless of lifecycle state.
    // Dreams use this count to decide whether to schedule an agent; a
    // heavily-cold agent still has work to distill from their history.
    includeCold: true,
  });
  return chits.length;
}
