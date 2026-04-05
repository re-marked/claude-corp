import { describe, it, expect } from 'vitest';

// The jitter function is private in crons.ts, so we recreate it here
// to verify the FNV-1a hash is deterministic and within bounds.
function computeJitter(clockId: string, maxMs = 30_000): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < clockId.length; i++) {
    hash ^= clockId.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash % maxMs;
}

describe('cron jitter', () => {
  it('produces deterministic output for the same ID', () => {
    const j1 = computeJitter('cron-daily-audit');
    const j2 = computeJitter('cron-daily-audit');
    expect(j1).toBe(j2);
  });

  it('produces different output for different IDs', () => {
    const j1 = computeJitter('cron-daily-audit');
    const j2 = computeJitter('cron-weekly-review');
    expect(j1).not.toBe(j2);
  });

  it('stays within 0 to maxMs bounds', () => {
    const ids = ['a', 'b', 'cron-1', 'cron-test-long-name', 'x'.repeat(100)];
    for (const id of ids) {
      const jitter = computeJitter(id);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(30_000);
    }
  });

  it('spreads values across the range', () => {
    const jitters = new Set<number>();
    for (let i = 0; i < 20; i++) {
      jitters.add(computeJitter(`cron-${i}`));
    }
    // At least 15 unique values out of 20 (good spread)
    expect(jitters.size).toBeGreaterThanOrEqual(15);
  });
});
