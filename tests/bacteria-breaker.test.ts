import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateBreakerTrigger,
  tripBreaker,
  closeBreakerForSlug,
  findActiveBreaker,
  listActiveBreakers,
  CRASH_LOOP_THRESHOLD_DEFAULT,
  CRASH_LOOP_WINDOW_MS_DEFAULT,
} from '../packages/shared/src/index.js';

/**
 * Coverage for bacteria-breaker.ts (Project 1.11). Pure detection
 * helper + idempotent trip lifecycle + close lifecycle + read
 * surface. Hot path is findActiveBreaker (every spawn calls it);
 * the trip writer's idempotency contract is the substrate spec.
 */

describe('bacteria-breaker substrate', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'bacteria-breaker-'));
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      /* Windows */
    }
  });

  // ─── evaluateBreakerTrigger (pure) ───────────────────────────────

  describe('evaluateBreakerTrigger', () => {
    const now = new Date('2026-04-25T12:00:00.000Z');

    it('null kink → no trip', () => {
      const decision = evaluateBreakerTrigger(null, 3, 5 * 60 * 1000, now);
      expect(decision.shouldTrip).toBe(false);
      expect(decision.count).toBe(0);
      expect(decision.ageMs).toBe(0);
    });

    it('count below threshold → no trip', () => {
      const decision = evaluateBreakerTrigger(
        { id: 'k1', createdAt: '2026-04-25T11:59:00.000Z', occurrenceCount: 2 },
        3,
        5 * 60 * 1000,
        now,
      );
      expect(decision.shouldTrip).toBe(false);
    });

    it('count meets threshold inside window → trip', () => {
      const decision = evaluateBreakerTrigger(
        { id: 'k1', createdAt: '2026-04-25T11:59:00.000Z', occurrenceCount: 3 },
        3,
        5 * 60 * 1000,
        now,
      );
      expect(decision.shouldTrip).toBe(true);
      expect(decision.count).toBe(3);
      expect(decision.ageMs).toBe(60_000);
    });

    it('count above threshold but outside window → no trip', () => {
      const decision = evaluateBreakerTrigger(
        { id: 'k1', createdAt: '2026-04-25T11:00:00.000Z', occurrenceCount: 5 },
        3,
        5 * 60 * 1000, // 5 min window
        now, // 60 min past createdAt
      );
      expect(decision.shouldTrip).toBe(false);
    });

    it('per-role threshold override honored', () => {
      // Default 3 would trip at count=3; override 10 means count=5 doesn't.
      const decision = evaluateBreakerTrigger(
        { id: 'k1', createdAt: '2026-04-25T11:59:00.000Z', occurrenceCount: 5 },
        10,
        5 * 60 * 1000,
        now,
      );
      expect(decision.shouldTrip).toBe(false);
    });

    it('unparseable createdAt → ageMs=0, no trip on stale-window check', () => {
      const decision = evaluateBreakerTrigger(
        { id: 'k1', createdAt: 'not a timestamp', occurrenceCount: 5 },
        3,
        5 * 60 * 1000,
        now,
      );
      // ageMs treated as 0 → within any window → would trip on count alone.
      expect(decision.shouldTrip).toBe(true);
      expect(decision.ageMs).toBe(0);
    });

    it('exposes the documented defaults', () => {
      expect(CRASH_LOOP_THRESHOLD_DEFAULT).toBe(3);
      expect(CRASH_LOOP_WINDOW_MS_DEFAULT).toBe(5 * 60 * 1000);
    });
  });

  // ─── tripBreaker idempotency ─────────────────────────────────────

  describe('tripBreaker', () => {
    it('first call writes a fresh trip with action=created', () => {
      const result = tripBreaker({
        corpRoot,
        slug: 'backend-engineer-aa',
        triggerThreshold: 3,
        triggerWindowMs: 300_000,
        triggerKinkId: 'chit-k-aaa',
        loopStartedAt: '2026-04-25T11:55:00.000Z',
        reason: 'first trip',
      });
      expect(result.action).toBe('created');
      expect(result.triggerCount).toBe(3);
      expect(result.chit.fields['breaker-trip'].slug).toBe('backend-engineer-aa');
      expect(result.chit.fields['breaker-trip'].recentSilentexitKinks).toEqual(['chit-k-aaa']);
      expect(result.chit.fields['breaker-trip'].spawnHistory).toEqual([
        '2026-04-25T11:55:00.000Z',
      ]);
      expect(result.chit.status).toBe('active');
    });

    it('second call on same slug bumps in place — action=bumped, triggerCount++', () => {
      tripBreaker({
        corpRoot,
        slug: 'backend-engineer-aa',
        triggerThreshold: 3,
        triggerWindowMs: 300_000,
        triggerKinkId: 'chit-k-aaa',
        loopStartedAt: '2026-04-25T11:55:00.000Z',
        reason: 'first',
      });
      const second = tripBreaker({
        corpRoot,
        slug: 'backend-engineer-aa',
        triggerThreshold: 3,
        triggerWindowMs: 300_000,
        triggerKinkId: 'chit-k-bbb',
        loopStartedAt: '2026-04-25T11:55:00.000Z',
        reason: 'second',
      });
      expect(second.action).toBe('bumped');
      expect(second.triggerCount).toBe(4);
      expect(second.chit.fields['breaker-trip'].recentSilentexitKinks).toEqual([
        'chit-k-aaa',
        'chit-k-bbb',
      ]);
      // trippedAt + spawnHistory[0] stable across re-trips
      expect(second.chit.fields['breaker-trip'].spawnHistory).toEqual([
        '2026-04-25T11:55:00.000Z',
      ]);

      // Only ONE active trip exists for the slug
      const active = listActiveBreakers(corpRoot);
      expect(active).toHaveLength(1);
    });

    it('re-trip with same kink id does not duplicate the kink reference', () => {
      tripBreaker({
        corpRoot,
        slug: 'backend-engineer-aa',
        triggerThreshold: 3,
        triggerWindowMs: 300_000,
        triggerKinkId: 'chit-k-aaa',
        loopStartedAt: '2026-04-25T11:55:00.000Z',
        reason: 'first',
      });
      const second = tripBreaker({
        corpRoot,
        slug: 'backend-engineer-aa',
        triggerThreshold: 3,
        triggerWindowMs: 300_000,
        triggerKinkId: 'chit-k-aaa',
        loopStartedAt: '2026-04-25T11:55:00.000Z',
        reason: 'duplicate',
      });
      expect(second.chit.fields['breaker-trip'].recentSilentexitKinks).toEqual(['chit-k-aaa']);
    });
  });

  // ─── findActiveBreaker / listActiveBreakers ──────────────────────

  describe('read surface', () => {
    it('findActiveBreaker returns null when no trip exists', () => {
      expect(findActiveBreaker(corpRoot, 'backend-engineer-aa')).toBeNull();
    });

    it('findActiveBreaker returns the active trip after tripBreaker', () => {
      tripBreaker({
        corpRoot,
        slug: 'backend-engineer-aa',
        triggerThreshold: 3,
        triggerWindowMs: 300_000,
        triggerKinkId: 'chit-k-aaa',
        loopStartedAt: '2026-04-25T11:55:00.000Z',
        reason: 'r',
      });
      const trip = findActiveBreaker(corpRoot, 'backend-engineer-aa');
      expect(trip).not.toBeNull();
      expect(trip!.fields['breaker-trip'].slug).toBe('backend-engineer-aa');
    });

    it('findActiveBreaker fails open on missing corp root (returns null)', () => {
      // Non-existent path — listActiveBreakers via queryChits should
      // throw or return empty; findActiveBreaker swallows either way.
      const trip = findActiveBreaker(join(corpRoot, 'does-not-exist'), 'x');
      expect(trip).toBeNull();
    });

    it('listActiveBreakers excludes cleared by default', () => {
      tripBreaker({
        corpRoot,
        slug: 'backend-engineer-aa',
        triggerThreshold: 3,
        triggerWindowMs: 300_000,
        triggerKinkId: 'chit-k-aaa',
        loopStartedAt: '2026-04-25T11:55:00.000Z',
        reason: 'r',
      });
      closeBreakerForSlug({
        corpRoot,
        slug: 'backend-engineer-aa',
        reason: 'reset',
      });
      expect(listActiveBreakers(corpRoot)).toHaveLength(0);
      expect(listActiveBreakers(corpRoot, { includeCleared: true })).toHaveLength(1);
    });
  });

  // ─── closeBreakerForSlug ─────────────────────────────────────────

  describe('closeBreakerForSlug', () => {
    it('closes an active trip — sets clearedAt + clearedBy + clearReason', () => {
      tripBreaker({
        corpRoot,
        slug: 'backend-engineer-aa',
        triggerThreshold: 3,
        triggerWindowMs: 300_000,
        triggerKinkId: 'chit-k-aaa',
        loopStartedAt: '2026-04-25T11:55:00.000Z',
        reason: 'r',
      });
      const closed = closeBreakerForSlug({
        corpRoot,
        slug: 'backend-engineer-aa',
        reason: 'founder reset',
        clearedBy: 'founder',
      });
      expect(closed).toHaveLength(1);
      expect(closed[0]!.status).toBe('closed');
      expect(closed[0]!.fields['breaker-trip'].clearedBy).toBe('founder');
      expect(closed[0]!.fields['breaker-trip'].clearReason).toBe('founder reset');
      expect(closed[0]!.fields['breaker-trip'].clearedAt).toBeDefined();
    });

    it('noop when no active trip — returns empty array, does not throw', () => {
      const closed = closeBreakerForSlug({
        corpRoot,
        slug: 'never-tripped',
        reason: 'speculative',
      });
      expect(closed).toEqual([]);
    });

    it('after close, fresh trip on same slug creates a NEW chit (not a re-open)', () => {
      tripBreaker({
        corpRoot,
        slug: 'backend-engineer-aa',
        triggerThreshold: 3,
        triggerWindowMs: 300_000,
        triggerKinkId: 'chit-k-aaa',
        loopStartedAt: '2026-04-25T11:55:00.000Z',
        reason: 'first incident',
      });
      closeBreakerForSlug({
        corpRoot,
        slug: 'backend-engineer-aa',
        reason: 'reset',
      });
      const second = tripBreaker({
        corpRoot,
        slug: 'backend-engineer-aa',
        triggerThreshold: 3,
        triggerWindowMs: 300_000,
        triggerKinkId: 'chit-k-bbb',
        loopStartedAt: '2026-04-25T13:00:00.000Z',
        reason: 'second incident',
      });
      expect(second.action).toBe('created');
      expect(second.triggerCount).toBe(3); // fresh start

      const all = listActiveBreakers(corpRoot, { includeCleared: true });
      expect(all).toHaveLength(2);
    });
  });
});
