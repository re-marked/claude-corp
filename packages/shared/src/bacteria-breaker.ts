/**
 * Crash-loop breaker helpers (Project 1.11).
 *
 * Three responsibilities, single source of truth:
 *
 * 1. **Detection math (`evaluateBreakerTrigger`)** — pure function the
 *    silent-exit sweeper composes with its kink query to decide
 *    whether a slug's loop has crossed the threshold. Pure so the
 *    decision logic is testable without spinning up the full sweeper
 *    or mocking the patrol cycle. Same pattern as decideBacteriaActions
 *    / checkRenameEligibility / computeRoleStats.
 *
 * 2. **Trip / close lifecycle (`tripBreaker`, `closeBreakerForSlug`)** —
 *    idempotent write surface for breaker-trip chits. tripBreaker is
 *    write-or-bump (mirrors writeOrBumpKink); closeBreakerForSlug is
 *    write-once-or-noop. Both stay quiet on "no work to do" so callers
 *    can invoke them speculatively (auto-cleanup on fire/evict, etc.).
 *
 * 3. **Read surface (`findActiveBreaker`, `listActiveBreakers`)** —
 *    queries the spawn refusal path + Sexton + TUI + CLI all share.
 *    findActiveBreaker is the hot path (called on every spawn);
 *    listActiveBreakers is the surface read.
 *
 * ### Why a helper module vs raw chits.ts
 *
 * Same three reasons as kinks.ts:
 *   1. Idempotency contracts (trip-or-bump, close-or-noop) live in
 *      one place rather than duplicated at every caller.
 *   2. The detection helper sits next to its consumers — sweeper
 *      composition stays one import away.
 *   3. Future non-silentexit trip writers (e.g. a future stuck-loop
 *      breaker) get the dedup behavior for free.
 *
 * ### Detection shape
 *
 * The silent-exit sweeper emits ONE active kink per slug at a time
 * (writeOrBumpKink keeps it deduped) and the sweeper runner auto-
 * resolves the kink the moment a clean pass sees the slot healthy
 * again. So an active silentexit kink with `occurrenceCount >= N`
 * is by construction N consecutive crashes within the patrol cadence.
 * The window check (now - createdAt <= triggerWindowMs) is a sanity
 * bound: a very-old kink that somehow accumulated occurrences without
 * an intervening clean pass shouldn't trip if the cadence has been
 * slow.
 *
 * ### Fail-open on corruption
 *
 * findActiveBreaker swallows malformed-chit errors and returns null.
 * Rationale (REFACTOR.md 1.11 robustness): a corrupted trip chit
 * should not permanently brick a slot. chit-hygiene flags the
 * corruption separately. Better to risk a missed trip than a silent
 * permanent block.
 */

import { queryChits, createChit, updateChit } from './chits.js';
import { ChitValidationError } from './chit-types.js';
import type { Chit } from './types/chit.js';

// ─── Defaults ────────────────────────────────────────────────────────

/**
 * Default crash-loop threshold — N consecutive silent-exits within
 * the window before tripping. RoleEntry.crashLoopThreshold overrides.
 *
 * Three is small enough to catch real loops fast (one bad spawn isn't
 * a loop; three is) and large enough to absorb a single transient
 * harness flake without paging the founder.
 */
export const CRASH_LOOP_THRESHOLD_DEFAULT = 3;

/**
 * Default crash-loop window in ms — 5 minutes. RoleEntry.crashLoopWindowMs
 * overrides. Three crashes spread across hours don't trip; three in
 * five minutes do.
 */
export const CRASH_LOOP_WINDOW_MS_DEFAULT = 5 * 60 * 1000;

// ─── Pure detection helper ───────────────────────────────────────────

/**
 * The silent-exit kink shape needed for evaluation. Subset of KinkFields
 * — keeps the helper decoupled from the full chit container so tests
 * can pass plain literals.
 */
export interface BreakerTriggerKink {
  /** Chit id of the kink. Becomes a member of recentSilentexitKinks on trip. */
  id: string;
  /** First-occurrence timestamp; used for the window-bound sanity check. */
  createdAt: string;
  /** Number of consecutive crashes the sweeper has bumped onto this kink. */
  occurrenceCount: number;
}

export interface BreakerTriggerDecision {
  /** True when the kink crossed the threshold inside the configured window. */
  readonly shouldTrip: boolean;
  /** Snapshot of occurrenceCount at decision time. */
  readonly count: number;
  /** Age of the active kink in ms (now - createdAt). 0 if createdAt unparseable. */
  readonly ageMs: number;
}

/**
 * Decide whether a slug's active silent-exit kink has crossed the trip
 * threshold. Pure — caller composes with kink query + tripBreaker write.
 *
 * Returns shouldTrip=true iff:
 *   - kink.occurrenceCount >= threshold
 *   - AND kink age (now - kink.createdAt) <= windowMs
 *
 * Both conditions matter. The threshold alone could fire on a slot
 * that crashed 3 times spread across hours (kink would auto-resolve
 * between, but defensive coding); the window alone could fire on a
 * single fresh crash. Combined: 3 crashes inside 5min == genuine loop.
 *
 * Returns shouldTrip=false when kink is null (no active loop signal).
 */
export function evaluateBreakerTrigger(
  kink: BreakerTriggerKink | null,
  threshold: number,
  windowMs: number,
  now: Date,
): BreakerTriggerDecision {
  if (!kink) return { shouldTrip: false, count: 0, ageMs: 0 };
  const created = Date.parse(kink.createdAt);
  const ageMs = Number.isFinite(created) ? Math.max(0, now.getTime() - created) : 0;
  const shouldTrip = kink.occurrenceCount >= threshold && ageMs <= windowMs;
  return { shouldTrip, count: kink.occurrenceCount, ageMs };
}

// ─── Trip writer (idempotent) ────────────────────────────────────────

export interface TripBreakerOpts {
  corpRoot: string;
  slug: string;
  /** Threshold the trip evaluated against (config snapshot at trip time). */
  triggerThreshold: number;
  /** Window the trip evaluated within (config snapshot at trip time). */
  triggerWindowMs: number;
  /** Chit id of the silent-exit kink whose threshold-cross fired this trip. */
  triggerKinkId: string;
  /** ISO timestamp of the kink's first crash — anchor for spawnHistory[0]. */
  loopStartedAt: string;
  /** Free-form summary written into reason. The detector composes this. */
  reason: string;
  /** Who's writing. Defaults to 'sweeper:silentexit'. */
  createdBy?: string;
}

export interface TripBreakerResult {
  readonly chit: Chit<'breaker-trip'>;
  /**
   * 'created' → no prior active trip for slug, fresh trip written.
   *             Caller should fire the Tier-3 inbox notification.
   * 'bumped'  → existing active trip, triggerCount++ and triggerKinkId
   *             appended to recentSilentexitKinks (if not already
   *             present). Caller should NOT spam another inbox-item.
   */
  readonly action: 'created' | 'bumped';
  readonly triggerCount: number;
}

/**
 * Trip the breaker for a slug, or bump an existing active trip.
 *
 * Mirrors writeOrBumpKink's contract:
 *   - active match by slug → UPDATE (triggerCount++, append kink id
 *     if new, refresh reason, leave trippedAt + spawnHistory[0]
 *     stable so audit reads see "started at X").
 *   - no match → CREATE fresh trip with triggerCount=triggerThreshold.
 *
 * Closed trips don't participate in dedup. A recurrence after a prior
 * close creates a new trip (new history for the new incident).
 */
export function tripBreaker(opts: TripBreakerOpts): TripBreakerResult {
  const writer = opts.createdBy ?? 'sweeper:silentexit';
  const trippedAt = new Date().toISOString();

  const result = queryChits<'breaker-trip'>(opts.corpRoot, {
    types: ['breaker-trip'],
    scopes: ['corp'],
    statuses: ['active'],
  });

  const matches = result.chits.filter((c) => c.chit.fields['breaker-trip'].slug === opts.slug);

  if (matches.length === 0) {
    const chit = createChit<'breaker-trip'>(opts.corpRoot, {
      type: 'breaker-trip',
      scope: 'corp',
      createdBy: writer,
      fields: {
        'breaker-trip': {
          slug: opts.slug,
          trippedAt,
          triggerCount: opts.triggerThreshold,
          triggerWindowMs: opts.triggerWindowMs,
          triggerThreshold: opts.triggerThreshold,
          recentSilentexitKinks: [opts.triggerKinkId],
          spawnHistory: [opts.loopStartedAt],
          reason: opts.reason,
        },
      },
    });
    return { chit, action: 'created', triggerCount: opts.triggerThreshold };
  }

  // Pick the most-recently-updated match if there are duplicates
  // (shouldn't happen; chit-hygiene would surface). Sort descending.
  const target = [...matches].sort((a, b) =>
    (b.chit.updatedAt ?? '').localeCompare(a.chit.updatedAt ?? ''),
  )[0]!;

  const existing = target.chit.fields['breaker-trip'];
  const newCount = existing.triggerCount + 1;
  const kinks = existing.recentSilentexitKinks.includes(opts.triggerKinkId)
    ? existing.recentSilentexitKinks
    : [...existing.recentSilentexitKinks, opts.triggerKinkId];

  const updated = updateChit<'breaker-trip'>(opts.corpRoot, 'corp', 'breaker-trip', target.chit.id, {
    updatedBy: writer,
    fields: {
      'breaker-trip': {
        slug: existing.slug,
        trippedAt: existing.trippedAt, // stable across re-trips
        triggerCount: newCount,
        triggerWindowMs: existing.triggerWindowMs,
        triggerThreshold: existing.triggerThreshold,
        recentSilentexitKinks: kinks,
        spawnHistory: existing.spawnHistory, // stable; first crash only
        reason: opts.reason,
      },
    },
  });

  return { chit: updated, action: 'bumped', triggerCount: newCount };
}

// ─── Close (founder reset / auto-cleanup) ────────────────────────────

export interface CloseBreakerOpts {
  corpRoot: string;
  slug: string;
  /** Why closing — stored in clearReason. e.g. 'founder reset', 'slot removed'. */
  reason: string;
  /** Who closed. Defaults to 'system'. e.g. 'founder', 'cli:fire', 'cli:evict'. */
  clearedBy?: string;
}

/**
 * Close any active breaker trip for a slug.
 *
 * Idempotent noop when no active trip exists — auto-cleanup paths
 * (fire-remove, bacteria evict) call this speculatively without first
 * checking. Returns the closed chit, or null if nothing to close.
 *
 * If multiple active trips exist for the same slug (shouldn't happen;
 * tripBreaker dedups), closes them all with the same resolution. Lets
 * a single caller undo prior dedup anomalies.
 */
export function closeBreakerForSlug(opts: CloseBreakerOpts): ReadonlyArray<Chit<'breaker-trip'>> {
  const writer = opts.clearedBy ?? 'system';
  const clearedAt = new Date().toISOString();

  const result = queryChits<'breaker-trip'>(opts.corpRoot, {
    types: ['breaker-trip'],
    scopes: ['corp'],
    statuses: ['active'],
  });

  const matches = result.chits.filter((c) => c.chit.fields['breaker-trip'].slug === opts.slug);

  if (matches.length === 0) return [];

  const closed: Chit<'breaker-trip'>[] = [];
  for (const target of matches) {
    try {
      const existing = target.chit.fields['breaker-trip'];
      const updated = updateChit<'breaker-trip'>(opts.corpRoot, 'corp', 'breaker-trip', target.chit.id, {
        status: 'closed',
        updatedBy: writer,
        fields: {
          'breaker-trip': {
            ...existing,
            clearedAt,
            clearedBy: writer,
            clearReason: opts.reason,
          },
        },
      });
      closed.push(updated);
    } catch (err) {
      // Validation errors are caller bugs — rethrow immediately.
      // Other errors (fs glitch, stale chit) skip this trip so the
      // rest of the loop still closes. chit-hygiene will surface the
      // anomaly on the next scan.
      if (err instanceof ChitValidationError) throw err;
      console.error(
        `[bacteria-breaker] closeBreakerForSlug: failed to close chit ${target.chit.id}:`,
        (err as Error).message,
      );
    }
  }
  return closed;
}

// ─── Read surface ────────────────────────────────────────────────────

/**
 * Find the active breaker trip for a slug, if any. Hot path — called
 * from ProcessManager.spawnAgent on every spawn. Fails open on
 * corruption: malformed trip chit returns null, log via chit-hygiene
 * later. Better miss a trip than permanently brick a slot.
 */
export function findActiveBreaker(
  corpRoot: string,
  slug: string,
): Chit<'breaker-trip'> | null {
  try {
    const result = queryChits<'breaker-trip'>(corpRoot, {
      types: ['breaker-trip'],
      scopes: ['corp'],
      statuses: ['active'],
    });
    const match = result.chits.find((c) => c.chit.fields['breaker-trip'].slug === slug);
    return match ? match.chit : null;
  } catch {
    return null;
  }
}

export interface ListActiveBreakersOpts {
  /** Filter by role (matches Member.role lookup at the caller — we only know the slug). Caller does role resolution. */
  includeRoles?: ReadonlyArray<string>;
  /** Include cleared trips for audit views. Default false. */
  includeCleared?: boolean;
}

/**
 * List breaker trips at corp scope. Active by default; pass
 * includeCleared for audit views (`cc-cli breaker list --include-cleared`).
 *
 * Role filtering happens at the caller boundary — this module doesn't
 * resolve slug→role. CLI layer reads members.json + filters the result
 * after this returns.
 */
export function listActiveBreakers(
  corpRoot: string,
  opts: ListActiveBreakersOpts = {},
): ReadonlyArray<Chit<'breaker-trip'>> {
  const statuses: ReadonlyArray<'active' | 'closed'> = opts.includeCleared
    ? ['active', 'closed']
    : ['active'];
  try {
    const result = queryChits<'breaker-trip'>(corpRoot, {
      types: ['breaker-trip'],
      scopes: ['corp'],
      statuses,
    });
    return result.chits.map((c) => c.chit);
  } catch {
    return [];
  }
}
