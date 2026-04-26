/**
 * Shared formatting utilities. Centralizes helpers used across
 * packages so each caller doesn't maintain its own copy.
 */

/**
 * Format a millisecond duration as a human-readable string.
 * Examples: 500ms, 45s, 3m, 2h, 2h30m
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h${remM}m`;
}
