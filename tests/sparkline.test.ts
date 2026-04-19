import { describe, it, expect } from 'vitest';
import { sparkline, binTimestamps } from '../packages/tui/src/lib/sparkline.ts';

// Pins the sparkline contract: fixed width, normalized-to-max,
// graceful on edges. The ambient badges are going to call this every
// render so small regressions (off-by-one bin size, accidental NaN
// propagation) would be obnoxious and silent.

describe('sparkline', () => {
  it('returns exactly `width` characters', () => {
    expect(sparkline([1, 2, 3]).length).toBe(10); // default width
    expect(sparkline([1, 2, 3], 5).length).toBe(5);
    expect(sparkline([1, 2, 3], 20).length).toBe(20);
  });

  it('empty input renders a flat baseline', () => {
    expect(sparkline([], 4)).toBe('▁▁▁▁');
  });

  it('all-zero input renders a flat baseline', () => {
    expect(sparkline([0, 0, 0, 0], 4)).toBe('▁▁▁▁');
  });

  it('all-equal nonzero input renders a flat top', () => {
    // Every bin has the max value → every char is the tallest block.
    expect(sparkline([5, 5, 5, 5], 4)).toBe('█'.repeat(4));
  });

  it('monotonic ascent renders ascending blocks', () => {
    const out = sparkline([1, 2, 3, 4, 5, 6, 7, 8], 8);
    const levels = out.split('').map(c => '▁▂▃▄▅▆▇█'.indexOf(c));
    // Climb is monotonic — normalize-to-max means the smallest sample
    // doesn't have to hit ▁ (we preserve density, not full dynamic range),
    // but each successive bar is ≥ the previous.
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]!);
    }
    expect(levels[levels.length - 1]).toBe(7); // max → █
  });

  it('pads short inputs to the right (recent activity right-aligned)', () => {
    // Three samples into a 6-wide sparkline → 3 leading zeros, then the samples.
    const out = sparkline([8, 8, 8], 6);
    expect(out).toBe('▁▁▁███');
  });

  it('bins long inputs down to width', () => {
    // 100 samples into a 4-wide sparkline → mean per quarter.
    const values = Array.from({ length: 100 }, (_, i) => (i < 50 ? 0 : 10));
    const out = sparkline(values, 4);
    // First half zero, second half 10 → sparkline is low-low-high-high.
    expect(out.slice(0, 2)).toBe('▁▁');
    expect(out.slice(2)).toBe('██');
  });

  it('clamps non-finite / negative samples to 0', () => {
    expect(sparkline([NaN, Infinity, -Infinity, -5], 4)).toBe('▁▁▁▁');
  });

  it('handles width=0 gracefully', () => {
    expect(sparkline([1, 2, 3], 0)).toBe('');
  });

  it('mixed real data produces a meaningful shape', () => {
    // Simulate a burst of cron activity then silence.
    const samples = [1, 3, 5, 2, 0, 0, 0, 0];
    const out = sparkline(samples, 8);
    const levels = out.split('').map(c => '▁▂▃▄▅▆▇█'.indexOf(c));
    // Peak must be at the earliest non-zero region.
    const maxLevel = Math.max(...levels);
    const maxIdx = levels.indexOf(maxLevel);
    expect(maxIdx).toBeLessThan(4); // peak in first half
    expect(levels[levels.length - 1]).toBe(0); // trailing silence = ▁
  });
});

describe('binTimestamps', () => {
  it('buckets timestamps into fixed-width bins', () => {
    const start = 0;
    const end = 100;
    // Bins are half-open [lo, hi): 0-20, 20-40, 40-60, 60-80, 80-100.
    // 10 → bin 0. 20 → bin 1 (lower boundary inclusive on next bin).
    // 30 → bin 1. 40 → bin 2. 95 → bin 4. 100 (inclusive upper) → bin 4.
    const ts = [10, 20, 30, 40, 95];
    const out = binTimestamps(ts, start, end, 5);
    expect(out).toHaveLength(5);
    expect(out).toEqual([1, 2, 1, 0, 1]);
  });

  it('ignores timestamps outside the window', () => {
    const out = binTimestamps([-50, 50, 500], 0, 100, 4);
    expect(out.reduce((s, n) => s + n, 0)).toBe(1);
  });

  it('zero-span window returns empty array', () => {
    expect(binTimestamps([1, 2, 3], 10, 10, 5)).toEqual([]);
    expect(binTimestamps([1, 2, 3], 100, 50, 5)).toEqual([]);
  });

  it('returns empty array for non-positive bins', () => {
    expect(binTimestamps([1, 2, 3], 0, 100, 0)).toEqual([]);
  });
});
