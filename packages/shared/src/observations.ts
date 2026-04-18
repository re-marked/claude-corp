/**
 * Observation Log — append-only daily activity records per agent.
 *
 * Borrowed from Claude Code's memdir/memdir.ts daily log system (lines 318-370).
 * Each agent gets: agents/<name>/observations/YYYY/MM/YYYY-MM-DD.md
 *
 * Observations are the raw signal that Dreams distill into BRAIN/ memory.
 * They're also the primary record of what agents did during SLUMBER sessions.
 *
 * Format: timestamped bullets with category tags:
 *   - 14:30 [TASK] Picked up cool-bay, reading competitor docs (files: research/competitors.md)
 *
 * Categories:
 *   [TASK]       — Working on a task
 *   [RESEARCH]   — Reading, exploring, investigating
 *   [DECISION]   — Made a choice or judgment call
 *   [BLOCKED]    — Hit a wall, can't proceed
 *   [LEARNED]    — Discovered new information
 *   [CREATED]    — Created a file, task, agent, or artifact
 *   [REVIEWED]   — Reviewed someone's work
 *   [CHECKPOINT] — Milestone reached, phase boundary
 *   [SLUMBER]    — SLUMBER session start/stop marker
 *   [ERROR]      — Something went wrong
 *   [HANDOFF]    — Delegated or received work from another agent
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
  /** Category tag */
  category: ObservationCategory;
  /** Human-readable description */
  description: string;
  /** Optional file paths involved */
  files?: string[];
  /** Optional agent who made this observation */
  agentId?: string;
}

export interface ObservationLogStats {
  /** Total entries in the log */
  entryCount: number;
  /** Categories with counts */
  categoryCounts: Partial<Record<ObservationCategory, number>>;
  /** First entry timestamp */
  firstEntry: string | null;
  /** Last entry timestamp */
  lastEntry: string | null;
  /** File path of the log */
  logPath: string;
}

// ── Path Helpers ─────────────────────────────────────────────────────

/** Get the observation log path for an agent on a specific date. */
export function getObservationLogPath(agentDir: string, date?: Date): string {
  const d = date ?? new Date();
  const year = d.getFullYear().toString();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return join(agentDir, 'observations', year, month, `${year}-${month}-${day}.md`);
}

/** Get the observations root directory for an agent. */
export function getObservationsDir(agentDir: string): string {
  return join(agentDir, 'observations');
}

// ── Write ────────────────────────────────────────────────────────────

/** Format a single observation entry as a markdown bullet. */
export function formatObservation(obs: Observation): string {
  const filesNote = obs.files?.length
    ? ` (files: ${obs.files.join(', ')})`
    : '';
  return `- ${obs.localTime} [${obs.category}] ${obs.description}${filesNote}`;
}

/**
 * Append an observation entry to today's log file.
 * Creates the directory structure if needed.
 * This is designed to be fast — append-only, no reads.
 */
export function appendObservation(agentDir: string, obs: Observation): void {
  const logPath = getObservationLogPath(agentDir);
  const dir = dirname(logPath);

  // Create directory tree if needed
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write header if new file
  if (!existsSync(logPath)) {
    const d = new Date(obs.timestamp);
    const header = `# Observations — ${d.toISOString().slice(0, 10)}\n\n`;
    appendFileSync(logPath, header, 'utf-8');
  }

  // Append the entry
  const line = formatObservation(obs) + '\n';
  appendFileSync(logPath, line, 'utf-8');
}

/**
 * Create and append an observation in one call.
 * Convenience wrapper for the common case.
 */
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

/** Read today's observation log as raw text. Returns empty string if no log. */
export function readTodaysObservations(agentDir: string): string {
  const logPath = getObservationLogPath(agentDir);
  if (!existsSync(logPath)) return '';
  return readFileSync(logPath, 'utf-8');
}

/** Read an observation log for a specific date. */
export function readObservationsForDate(agentDir: string, date: Date): string {
  const logPath = getObservationLogPath(agentDir, date);
  if (!existsSync(logPath)) return '';
  return readFileSync(logPath, 'utf-8');
}

/** Parse observation entries from a log file's raw text. */
export function parseObservations(content: string): Observation[] {
  const lines = content.split('\n').filter(l => l.startsWith('- '));
  return lines.map(line => {
    const match = line.match(
      /^- (\d{2}:\d{2}) \[(\w+)] (.+?)(?:\s*\(files: (.+?)\))?$/,
    );
    if (!match) return null;
    const obs: Observation = {
      timestamp: '', // Not available from log format — use date from filename
      localTime: match[1]!,
      category: match[2] as ObservationCategory,
      description: match[3]!.trim(),
      files: match[4]?.split(', ').map(f => f.trim()),
    };
    return obs;
  }).filter((o): o is Observation => o !== null);
}

/** Get stats for today's observation log. */
export function getObservationStats(agentDir: string): ObservationLogStats | null {
  const logPath = getObservationLogPath(agentDir);
  if (!existsSync(logPath)) return null;

  const content = readFileSync(logPath, 'utf-8');
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
    logPath,
  };
}

/**
 * List all observation log files for an agent, newest first.
 * Returns array of { date: string, path: string, size: number }.
 */
export function listObservationLogs(
  agentDir: string,
): Array<{ date: string; path: string; size: number }> {
  const obsDir = getObservationsDir(agentDir);
  if (!existsSync(obsDir)) return [];

  const logs: Array<{ date: string; path: string; size: number }> = [];

  // Walk observations/YYYY/MM/YYYY-MM-DD.md
  try {
    const years = readdirSync(obsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const year of years) {
      const yearDir = join(obsDir, year);
      const months = readdirSync(yearDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const month of months) {
        const monthDir = join(yearDir, month);
        const files = readdirSync(monthDir)
          .filter(f => f.endsWith('.md'));

        for (const file of files) {
          const filePath = join(monthDir, file);
          const date = file.replace('.md', '');
          try {
            const size = statSync(filePath).size;
            logs.push({ date, path: filePath, size });
          } catch {}
        }
      }
    }
  } catch {}

  // Sort newest first
  return logs.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Count total observations across all log files for an agent.
 * Useful for analytics and dream triggers.
 */
export function countRecentObservations(
  agentDir: string,
  sinceDaysAgo = 7,
): number {
  const logs = listObservationLogs(agentDir);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - sinceDaysAgo);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let total = 0;
  for (const log of logs) {
    if (log.date < cutoffStr) break; // Sorted newest first — stop when too old
    const content = readFileSync(log.path, 'utf-8');
    const observations = parseObservations(content);
    total += observations.length;
  }
  return total;
}
