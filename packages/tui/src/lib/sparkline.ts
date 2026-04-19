/**
 * Unicode block sparklines. Takes an array of numbers and returns a
 * tiny inline chart like `▁▂▃▅▇▅▃▁` that reads at a glance.
 *
 * Used by the ambient stack badges in PR 2b — a collapsed stack of
 * N cron ticks or heartbeats shows a sparkline of activity over time
 * so the founder can tell "quiet" from "busy" without expanding.
 *
 * Pure, synchronous, allocation-light. Safe to call on every render.
 */

/** The 8 block characters from empty → full. */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * Render an array of numeric samples as a sparkline string.
 *
 * - Normalizes to the max value in the input; the largest sample
 *   maps to the tallest block, zero maps to the shortest block.
 * - All-zero (or all-equal) input renders as a flat baseline.
 * - NaN / negative / non-finite samples are clamped to 0.
 * - When `values.length > width`, samples are binned (mean) so the
 *   result is always exactly `width` characters wide.
 */
export function sparkline(values: number[], width = 10): string {
  if (width <= 0) return '';
  if (values.length === 0) return BLOCKS[0]!.repeat(width);

  // Clean samples: non-finite/negative → 0
  const clean = values.map(v => (Number.isFinite(v) && v >= 0 ? v : 0));

  // Bin to exactly `width` samples. Each output bin is the mean of
  // its source window. If we have fewer samples than width, the
  // array is padded with zeros at the front so recent activity
  // aligns to the right edge (feels like a timeline).
  const binned: number[] = [];
  if (clean.length >= width) {
    const perBin = clean.length / width;
    for (let i = 0; i < width; i++) {
      const lo = Math.floor(i * perBin);
      const hi = Math.floor((i + 1) * perBin);
      let sum = 0;
      let n = 0;
      for (let j = lo; j < Math.max(hi, lo + 1) && j < clean.length; j++) {
        sum += clean[j]!;
        n++;
      }
      binned.push(n === 0 ? 0 : sum / n);
    }
  } else {
    const leadingZeros = width - clean.length;
    for (let i = 0; i < leadingZeros; i++) binned.push(0);
    binned.push(...clean);
  }

  const max = Math.max(...binned);
  if (max === 0) return BLOCKS[0]!.repeat(width);

  return binned
    .map(v => {
      const idx = Math.round((v / max) * (BLOCKS.length - 1));
      return BLOCKS[Math.min(BLOCKS.length - 1, Math.max(0, idx))]!;
    })
    .join('');
}

/**
 * Count-by-bin helper for the ambient stack case. Given an array of
 * timestamps (ms since epoch) and a time window, returns a fixed-
 * length array where each bucket = how many timestamps fell into it.
 * Feed the result to sparkline() for a time-density chart.
 */
export function binTimestamps(
  timestamps: number[],
  windowStartMs: number,
  windowEndMs: number,
  bins: number,
): number[] {
  if (bins <= 0 || windowEndMs <= windowStartMs) return [];
  const span = windowEndMs - windowStartMs;
  const counts = new Array<number>(bins).fill(0);
  for (const ts of timestamps) {
    if (ts < windowStartMs || ts > windowEndMs) continue;
    const frac = (ts - windowStartMs) / span;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(frac * bins)));
    counts[idx]! += 1;
  }
  return counts;
}
