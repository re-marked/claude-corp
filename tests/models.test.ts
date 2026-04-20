import { describe, it, expect } from 'vitest';
import {
  isKnownModel,
  resolveModelAlias,
  KNOWN_MODELS,
} from '../packages/shared/src/models.js';

describe('isKnownModel — write-time validation for cc-cli models set', () => {
  it('accepts every canonical id in KNOWN_MODELS', () => {
    for (const m of KNOWN_MODELS) {
      expect(isKnownModel(m.id)).toBe(true);
    }
  });

  it('rejects the typo that broke CEO ("haiku5")', () => {
    expect(isKnownModel('haiku5')).toBe(false);
  });

  it('rejects other plausible typos (unknown aliases, wrong version)', () => {
    expect(isKnownModel('opuss')).toBe(false);
    expect(isKnownModel('claude-haiku-5')).toBe(false);
    expect(isKnownModel('sonnet-5')).toBe(false);
    expect(isKnownModel('')).toBe(false);
  });

  it('rejects BARE aliases (sonnet/opus/haiku) — caller must resolve first', () => {
    // isKnownModel is post-resolution. Bare aliases are legitimate user
    // input but resolveModelAlias('haiku') → 'claude-haiku-4-5'; THAT's
    // what should be checked. Exposes a misuse where the CLI forgets
    // to resolve before validating.
    expect(isKnownModel('haiku')).toBe(false);
    expect(isKnownModel('opus')).toBe(false);
    expect(isKnownModel('sonnet')).toBe(false);
  });

  it('round-trips with resolveModelAlias — resolved aliases are known', () => {
    // The real-world flow: user types 'haiku', CLI resolves to the full
    // id, validation accepts it. This test locks the contract: whatever
    // resolveModelAlias returns for a known alias must pass isKnownModel.
    for (const m of KNOWN_MODELS) {
      const resolved = resolveModelAlias(m.alias);
      expect(isKnownModel(resolved)).toBe(true);
    }
  });
});
