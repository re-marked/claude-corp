/**
 * Schedule Parser — zero-dependency utilities for parsing loop intervals
 * and cron expressions into normalized formats.
 *
 * Supports:
 *   "@every 5m"         → interval (300,000 ms)
 *   "@every 30s"        → interval (30,000 ms)
 *   "@every 2h"         → interval (7,200,000 ms)
 *   "@every 1h30m"      → interval (5,400,000 ms)
 *   "5m" / "30s" / "2h" → shorthand intervals (no @every prefix)
 *   "@daily"            → cron (0 0 * * *)
 *   "@hourly"           → cron (0 * * * *)
 *   "@weekly"           → cron (0 0 * * 0)
 *   "@monthly"          → cron (0 0 1 * *)
 *   "@yearly"           → cron (0 0 1 1 *)
 *   "0 9 * * 1"         → raw cron expression
 */

// ── Interval Parsing ────────────────────────────────────────────────

const DURATION_RE = /^(?:@every\s+)?(\d+h)?(\d+m)?(\d+s)?$/i;

/**
 * Parse an interval expression into milliseconds.
 * Accepts: "@every 5m", "5m", "@every 1h30m", "30s", "@every 2h"
 * Returns null if the input is not a valid interval expression.
 */
export function parseIntervalExpression(input: string): number | null {
  const trimmed = input.trim();
  const match = trimmed.match(DURATION_RE);
  if (!match) return null;

  const hours = match[1] ? parseInt(match[1]) : 0;
  const minutes = match[2] ? parseInt(match[2]) : 0;
  const seconds = match[3] ? parseInt(match[3]) : 0;

  const ms = (hours * 3600 + minutes * 60 + seconds) * 1000;
  return ms > 0 ? ms : null;
}

/** Check if input is an interval expression (@every Xm, or bare Xm/Xs/Xh). */
export function isIntervalExpression(input: string): boolean {
  return parseIntervalExpression(input) !== null;
}

// ── Cron Presets ────────────────────────────────────────────────────

const CRON_PRESETS: Record<string, string> = {
  '@yearly':   '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly':  '0 0 1 * *',
  '@weekly':   '0 0 * * 0',
  '@daily':    '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly':   '0 * * * *',
};

/** Check if input is a cron preset (@daily, @hourly, @weekly, etc.) */
export function isCronPreset(input: string): boolean {
  return input.trim().toLowerCase() in CRON_PRESETS;
}

/** Convert a cron preset to its 5-field expression. Returns null if not a preset. */
export function cronPresetToExpression(input: string): string | null {
  return CRON_PRESETS[input.trim().toLowerCase()] ?? null;
}

// ── Raw Cron Detection ──────────────────────────────────────────────

const CRON_FIELD_RE = /^(\S+\s+){4}\S+$/;

/** Check if input looks like a raw 5-field cron expression. */
export function isRawCronExpression(input: string): boolean {
  return CRON_FIELD_RE.test(input.trim());
}

// ── Unified Schedule Normalization ──────────────────────────────────

export type NormalizedSchedule =
  | { type: 'interval'; intervalMs: number }
  | { type: 'cron'; expression: string };

/**
 * Normalize any schedule input into either an interval (ms) or a cron expression.
 * This is the main entry point — call this to determine loop vs cron.
 *
 * Examples:
 *   "@every 5m"       → { type: 'interval', intervalMs: 300000 }
 *   "5m"              → { type: 'interval', intervalMs: 300000 }
 *   "@daily"          → { type: 'cron', expression: '0 0 * * *' }
 *   "0 9 * * 1"       → { type: 'cron', expression: '0 9 * * 1' }
 *
 * Returns null if the input can't be parsed as either type.
 */
export function normalizeScheduleInput(input: string): NormalizedSchedule | null {
  const trimmed = input.trim();

  // Try interval first (@every 5m, 5m, 30s, 2h, 1h30m)
  const intervalMs = parseIntervalExpression(trimmed);
  if (intervalMs !== null) {
    return { type: 'interval', intervalMs };
  }

  // Try cron preset (@daily, @hourly, @weekly)
  const presetExpr = cronPresetToExpression(trimmed);
  if (presetExpr) {
    return { type: 'cron', expression: presetExpr };
  }

  // Try raw cron expression (5 fields separated by spaces)
  if (isRawCronExpression(trimmed)) {
    return { type: 'cron', expression: trimmed };
  }

  return null;
}

// ── Display Formatting ──────────────────────────────────────────────

/**
 * Format milliseconds into a human-readable interval string.
 * 300000 → "5m", 3600000 → "1h", 5400000 → "1h30m", 30000 → "30s"
 */
export function formatIntervalMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 && h === 0) parts.push(`${s}s`); // Only show seconds if < 1h
  return parts.join('') || '0s';
}

/**
 * Format a remaining time in milliseconds to a countdown string.
 * Used in /clock view and CLI list output.
 *
 * 180000 → "3m 0s", 45000 → "45s", 7200000 → "2h 0m"
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Format a relative time for display (used in cron list).
 * Positive ms = future ("in 3m"), negative ms = past ("3m ago").
 */
export function formatRelativeTime(ms: number): string {
  const abs = Math.abs(ms);
  const totalMin = Math.round(abs / 60000);
  const totalHr = Math.round(abs / 3600000);
  const totalDays = Math.round(abs / 86400000);

  let label: string;
  if (totalMin < 1) label = '<1m';
  else if (totalMin < 60) label = `${totalMin}m`;
  else if (totalHr < 24) label = `${totalHr}h`;
  else label = `${totalDays}d`;

  return ms >= 0 ? `in ${label}` : `${label} ago`;
}
