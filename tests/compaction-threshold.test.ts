import { describe, it, expect } from 'vitest';
import {
  calculateCompactionThreshold,
  formatThresholdSummary,
} from '../packages/shared/src/compaction-threshold.js';

/**
 * Pure helper — exhaustive coverage of the threshold math. Every branch
 * of the state machine (below signal, in signal window, past autocompact)
 * across both context-window classes (200k standard, 1M extended).
 */

describe('calculateCompactionThreshold — 200k standard window', () => {
  // effectiveWindow = 200_000 - 20_000 = 180_000
  // autoCompactAt   = 180_000 - 13_000 = 167_000
  // ourSignalAt     = 180_000 - 30_000 = 150_000
  const model = 'claude-haiku-4-5-20251001';

  it('computes the canonical thresholds', () => {
    const s = calculateCompactionThreshold(0, model);
    expect(s.contextWindow).toBe(200_000);
    expect(s.effectiveWindow).toBe(180_000);
    expect(s.autoCompactAt).toBe(167_000);
    expect(s.ourSignalAt).toBe(150_000);
  });

  it('well below signal — neither flag set', () => {
    const s = calculateCompactionThreshold(50_000, model);
    expect(s.inSignalWindow).toBe(false);
    expect(s.pastAutoCompact).toBe(false);
    expect(s.tokensUntilAutoCompact).toBe(117_000);
    expect(s.fractionFull).toBeCloseTo(50_000 / 180_000, 5);
  });

  it('exactly at ourSignalAt → inSignalWindow=true', () => {
    const s = calculateCompactionThreshold(150_000, model);
    expect(s.inSignalWindow).toBe(true);
    expect(s.pastAutoCompact).toBe(false);
  });

  it('between ourSignalAt and autoCompactAt → inSignalWindow=true', () => {
    const s = calculateCompactionThreshold(160_000, model);
    expect(s.inSignalWindow).toBe(true);
    expect(s.pastAutoCompact).toBe(false);
    expect(s.tokensUntilAutoCompact).toBe(7_000);
  });

  it('exactly at autoCompactAt → pastAutoCompact=true, inSignalWindow=false', () => {
    const s = calculateCompactionThreshold(167_000, model);
    expect(s.inSignalWindow).toBe(false);
    expect(s.pastAutoCompact).toBe(true);
    expect(s.tokensUntilAutoCompact).toBe(0);
  });

  it('past autoCompactAt → pastAutoCompact=true, fractionFull > 0.9', () => {
    const s = calculateCompactionThreshold(175_000, model);
    expect(s.pastAutoCompact).toBe(true);
    expect(s.inSignalWindow).toBe(false);
    expect(s.fractionFull).toBeGreaterThan(0.9);
  });

  it('result is frozen — mutation attempts throw in strict mode', () => {
    const s = calculateCompactionThreshold(100_000, model);
    expect(() => {
      (s as unknown as { tokens: number }).tokens = 999;
    }).toThrow();
  });
});

describe('calculateCompactionThreshold — 1M extended window', () => {
  // effectiveWindow = 1_000_000 - 20_000 = 980_000
  // autoCompactAt   = 980_000 - 13_000 = 967_000
  // ourSignalAt     = 980_000 - 30_000 = 950_000

  it('opus-4-7 resolves to 1M window', () => {
    const s = calculateCompactionThreshold(0, 'claude-opus-4-7');
    expect(s.contextWindow).toBe(1_000_000);
    expect(s.ourSignalAt).toBe(950_000);
    expect(s.autoCompactAt).toBe(967_000);
  });

  it('opus-4 with [1m] tag resolves to 1M', () => {
    const s = calculateCompactionThreshold(0, 'claude-opus-4-6[1m]');
    expect(s.contextWindow).toBe(1_000_000);
  });

  it('sonnet-4-6 with 1m resolves to 1M', () => {
    const s = calculateCompactionThreshold(0, 'claude-sonnet-4-6-1m');
    expect(s.contextWindow).toBe(1_000_000);
  });

  it('50k tokens in a 1M model → nowhere near signal', () => {
    const s = calculateCompactionThreshold(50_000, 'claude-opus-4-7');
    expect(s.inSignalWindow).toBe(false);
    expect(s.pastAutoCompact).toBe(false);
  });

  it('955k in 1M model → signal fires', () => {
    const s = calculateCompactionThreshold(955_000, 'claude-opus-4-7');
    expect(s.inSignalWindow).toBe(true);
    expect(s.pastAutoCompact).toBe(false);
  });
});

describe('calculateCompactionThreshold — unknown model fallback', () => {
  it('unknown model id → 200k conservative default', () => {
    const s = calculateCompactionThreshold(0, 'some-future-model');
    expect(s.contextWindow).toBe(200_000);
  });
});

describe('formatThresholdSummary', () => {
  it('renders the canonical format with rounded k values', () => {
    const s = calculateCompactionThreshold(47_000, 'claude-haiku-4-5-20251001');
    const out = formatThresholdSummary(s);
    expect(out).toMatch(/47k \/ 180k tokens/);
    expect(out).toMatch(/\d+% full/);
    expect(out).toMatch(/until autocompact/);
  });

  it('past autocompact shows 0k remaining', () => {
    const s = calculateCompactionThreshold(200_000, 'claude-haiku-4-5-20251001');
    const out = formatThresholdSummary(s);
    expect(out).toContain('0k until autocompact');
  });
});
