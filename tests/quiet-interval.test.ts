import { describe, it, expect } from 'vitest';
import { humanize, QUIET_THRESHOLD_MS } from '../packages/tui/src/components/quiet-interval.tsx';

describe('QuietInterval.humanize', () => {
  it('sub-minute renders "a moment"', () => {
    expect(humanize(0)).toBe('a moment');
    expect(humanize(59_000)).toBe('a moment');
  });

  it('minutes only', () => {
    expect(humanize(10 * 60_000)).toBe('10m');
    expect(humanize(59 * 60_000)).toBe('59m');
  });

  it('whole hours drop the minute suffix', () => {
    expect(humanize(60 * 60_000)).toBe('1h');
    expect(humanize(3 * 3_600_000)).toBe('3h');
  });

  it('hours + minutes', () => {
    expect(humanize(90 * 60_000)).toBe('1h 30m');
    expect(humanize(4 * 3_600_000 + 15 * 60_000)).toBe('4h 15m');
  });

  it('whole days drop the hour suffix', () => {
    expect(humanize(24 * 3_600_000)).toBe('1d');
    expect(humanize(2 * 24 * 3_600_000)).toBe('2d');
  });

  it('days + remaining hours', () => {
    expect(humanize(25 * 3_600_000)).toBe('1d 1h');
    expect(humanize(3 * 24 * 3_600_000 + 7 * 3_600_000)).toBe('3d 7h');
  });
});

describe('QUIET_THRESHOLD_MS', () => {
  it('is 10 minutes', () => {
    expect(QUIET_THRESHOLD_MS).toBe(10 * 60 * 1000);
  });
});
