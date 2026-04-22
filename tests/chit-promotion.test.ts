import { describe, it, expect } from 'vitest';
import {
  isReferenced,
  isMentioned,
  hasKeepTag,
  hasAged,
  computeVerdict,
  type ReferenceIndex,
  type Chit,
} from '../packages/shared/src/index.js';

/**
 * Unit tests for the pure promotion-signal detectors + computeVerdict.
 * Pure functions, so fixtures are hand-built — no fs, no daemon.
 */

function makeChit(overrides: Partial<Chit> = {}): Chit {
  return {
    id: 'chit-o-12345678',
    type: 'observation',
    status: 'active',
    ephemeral: true,
    ttl: '2026-04-25T00:00:00.000Z',
    createdBy: 'ceo',
    createdAt: '2026-04-22T00:00:00.000Z',
    updatedAt: '2026-04-22T00:00:00.000Z',
    references: [],
    dependsOn: [],
    tags: [],
    fields: {
      observation: {
        category: 'NOTICE',
        subject: 'mark',
        importance: 2,
      },
    },
    ...overrides,
  } as Chit;
}

function emptyIndex(): ReferenceIndex {
  return { referencedIds: new Set(), mentionedIds: new Set() };
}

describe('isReferenced', () => {
  it('returns true when the id is in the referencedIds set', () => {
    const index: ReferenceIndex = {
      referencedIds: new Set(['chit-o-12345678']),
      mentionedIds: new Set(),
    };
    expect(isReferenced('chit-o-12345678', index)).toBe(true);
  });

  it('returns false when the id is absent', () => {
    expect(isReferenced('chit-o-12345678', emptyIndex())).toBe(false);
  });
});

describe('isMentioned', () => {
  it('returns true when the id is in the mentionedIds set', () => {
    const index: ReferenceIndex = {
      referencedIds: new Set(),
      mentionedIds: new Set(['chit-o-12345678']),
    };
    expect(isMentioned('chit-o-12345678', index)).toBe(true);
  });

  it('returns false when the id is absent', () => {
    expect(isMentioned('chit-o-12345678', emptyIndex())).toBe(false);
  });

  it('is independent from isReferenced (an id can be one without the other)', () => {
    const index: ReferenceIndex = {
      referencedIds: new Set(['chit-o-12345678']),
      mentionedIds: new Set(),
    };
    expect(isReferenced('chit-o-12345678', index)).toBe(true);
    expect(isMentioned('chit-o-12345678', index)).toBe(false);
  });
});

describe('hasKeepTag', () => {
  it('returns true when `keep` is in tags', () => {
    expect(hasKeepTag(makeChit({ tags: ['keep'] }))).toBe(true);
  });

  it('is case-insensitive (Keep / KEEP / keep all fire)', () => {
    expect(hasKeepTag(makeChit({ tags: ['Keep'] }))).toBe(true);
    expect(hasKeepTag(makeChit({ tags: ['KEEP'] }))).toBe(true);
    expect(hasKeepTag(makeChit({ tags: ['kEeP'] }))).toBe(true);
  });

  it('returns false when tags is empty', () => {
    expect(hasKeepTag(makeChit({ tags: [] }))).toBe(false);
  });

  it('returns false when tags contains other values but no keep', () => {
    expect(hasKeepTag(makeChit({ tags: ['urgent', 'founder-feedback'] }))).toBe(false);
  });
});

describe('hasAged', () => {
  it('returns true when now > createdAt + ttl (as determined by parsing ttl as an absolute ISO timestamp)', () => {
    const chit = makeChit({
      ttl: '2026-04-22T10:00:00.000Z',
    });
    const now = new Date('2026-04-22T11:00:00.000Z');
    expect(hasAged(chit, now)).toBe(true);
  });

  it('returns false when now < ttl (not yet aged)', () => {
    const chit = makeChit({ ttl: '2026-04-22T10:00:00.000Z' });
    const now = new Date('2026-04-22T09:00:00.000Z');
    expect(hasAged(chit, now)).toBe(false);
  });

  it('returns false when chit is not ephemeral', () => {
    const chit = makeChit({ ephemeral: false, ttl: '2026-04-22T10:00:00.000Z' });
    const now = new Date('2026-04-22T11:00:00.000Z');
    expect(hasAged(chit, now)).toBe(false);
  });

  it('returns false when ttl is missing (ephemeral-no-expiry, e.g. dispatch-context)', () => {
    const chit = makeChit({ ttl: undefined });
    const now = new Date('2099-01-01T00:00:00.000Z');
    expect(hasAged(chit, now)).toBe(false);
  });

  it('returns false when ttl is garbage (non-ISO string)', () => {
    const chit = makeChit({ ttl: 'not-a-date' });
    const now = new Date('2099-01-01T00:00:00.000Z');
    expect(hasAged(chit, now)).toBe(false);
  });
});

describe('computeVerdict', () => {
  const now = new Date('2026-04-22T11:00:00.000Z');
  const agedTtl = '2026-04-22T10:00:00.000Z'; // before now
  const freshTtl = '2026-04-22T12:00:00.000Z'; // after now

  describe('promotion signals (any one fires → promote)', () => {
    it('tagged-keep wins even when nothing else fires', () => {
      const chit = makeChit({ tags: ['keep'], ttl: agedTtl });
      const verdict = computeVerdict(chit, emptyIndex(), now, 'destroy-if-not-promoted');
      expect(verdict).toEqual({ kind: 'promote', reason: 'tagged-keep' });
    });

    it('tagged-keep wins over destruction even if aged — explicit intent beats age', () => {
      const chit = makeChit({ tags: ['keep'], ttl: agedTtl });
      const verdict = computeVerdict(chit, emptyIndex(), now, 'destroy-if-not-promoted');
      expect(verdict.kind).toBe('promote');
    });

    it('referenced signal fires when id is in the index', () => {
      const index: ReferenceIndex = {
        referencedIds: new Set(['chit-o-12345678']),
        mentionedIds: new Set(),
      };
      const verdict = computeVerdict(makeChit({ ttl: freshTtl }), index, now, 'keep-forever');
      expect(verdict).toEqual({ kind: 'promote', reason: 'referenced' });
    });

    it('mentioned signal fires when id is in the mentions index', () => {
      const index: ReferenceIndex = {
        referencedIds: new Set(),
        mentionedIds: new Set(['chit-o-12345678']),
      };
      const verdict = computeVerdict(makeChit({ ttl: freshTtl }), index, now, 'keep-forever');
      expect(verdict).toEqual({ kind: 'promote', reason: 'mentioned' });
    });

    it('tagged-keep beats referenced when both fire', () => {
      const index: ReferenceIndex = {
        referencedIds: new Set(['chit-o-12345678']),
        mentionedIds: new Set(),
      };
      const verdict = computeVerdict(
        makeChit({ tags: ['keep'], ttl: agedTtl }),
        index,
        now,
        'destroy-if-not-promoted',
      );
      expect(verdict.reason).toBe('tagged-keep');
    });

    it('referenced beats mentioned when both fire (structured beats informal)', () => {
      const index: ReferenceIndex = {
        referencedIds: new Set(['chit-o-12345678']),
        mentionedIds: new Set(['chit-o-12345678']),
      };
      const verdict = computeVerdict(makeChit({ ttl: agedTtl }), index, now, 'keep-forever');
      expect(verdict.reason).toBe('referenced');
    });
  });

  describe('no signal + not aged → skip', () => {
    it('fresh chit with no signal is skipped (scanner revisits next tick)', () => {
      const verdict = computeVerdict(
        makeChit({ ttl: freshTtl }),
        emptyIndex(),
        now,
        'destroy-if-not-promoted',
      );
      expect(verdict).toEqual({ kind: 'skip' });
    });

    it('ephemeral-no-ttl chit with no signal is skipped (never ages, keep scanning)', () => {
      const verdict = computeVerdict(
        makeChit({ ttl: undefined }),
        emptyIndex(),
        now,
        'destroy-if-not-promoted',
      );
      expect(verdict).toEqual({ kind: 'skip' });
    });
  });

  describe('no signal + aged → branch on policy', () => {
    it('destroy-if-not-promoted → destroy', () => {
      const verdict = computeVerdict(
        makeChit({ ttl: agedTtl }),
        emptyIndex(),
        now,
        'destroy-if-not-promoted',
      );
      expect(verdict).toEqual({ kind: 'destroy' });
    });

    it('keep-forever → cold (the whole point of the 0.6 split)', () => {
      const verdict = computeVerdict(
        makeChit({ ttl: agedTtl }),
        emptyIndex(),
        now,
        'keep-forever',
      );
      expect(verdict).toEqual({ kind: 'cold' });
    });
  });
});
