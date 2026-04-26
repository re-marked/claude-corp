/**
 * Shared formatting helpers for human-facing strings.
 *
 * Single source so behavior stays consistent across:
 *   - cc-cli bacteria status / lineage / evict
 *   - Sexton's wake-prompt pool-activity section
 *   - any future consumer that wants the same units
 *
 * Adding helpers here is preferred over per-caller duplication —
 * one edge-case fix touches one file.
 */

/**
 * Render a millisecond duration as a compact human string.
 *
 * Units cascade — sub-second → ms, sub-minute → s, sub-hour → m,
 * otherwise h with optional remaining-minutes suffix.
 *
 * Floors at each step (not rounds), so `90s` → `"1m"` rather than
 * `"1m30s"`. That's intentional for compact list output; if a
 * caller ever wants the longer form, take an opts arg here rather
 * than re-floating a parallel implementation.
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
