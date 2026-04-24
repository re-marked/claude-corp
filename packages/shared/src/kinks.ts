/**
 * Kink lifecycle helpers — the dedup-aware write + auto-resolve
 * surface for the kink chit type.
 *
 * Callers (the sweeper runner, and any future daemon-internal
 * detectors that want to record operational findings) use these
 * instead of raw createChit/updateChit so the dedup contract
 * documented on KinkFields lives in one place.
 *
 * ### The dedup contract
 *
 * A kink's identity is the pair `(source, subject)` while it's in
 * the active state. Two active kinks with the same pair collapse:
 *   - writeOrBumpKink matches → UPDATE the existing kink
 *     (occurrenceCount++, refresh severity/title/body to the
 *      latest finding, bump updatedAt)
 *   - writeOrBumpKink no match → CREATE a new kink (occurrenceCount=1)
 *
 * The "refresh to latest" rule lets severity escalate or de-escalate
 * as the underlying condition changes (silentexit respawn
 * succeeded once, then failed on the next attempt — the kink
 * escalates info → error without losing the history count).
 *
 * Closed kinks don't participate in dedup. A recurrence after a
 * prior close creates a fresh kink (new history for the new
 * incident).
 *
 * ### Why a helper vs raw chits.ts
 *
 * Three reasons:
 *   1. The dedup logic is non-trivial and easy to get wrong
 *      (multiple-match case, validator compatibility of the
 *      fields-merge shape, scope choice). Single helper = single
 *      source of truth.
 *   2. Auto-resolve (resolveKink) mirrors the write path — lives
 *      next to its counterpart for readability.
 *   3. Future non-sweeper kink writers (daemon boot flagging
 *      missing config, harness flagging an overload loop, etc.)
 *      get the dedup behavior for free without having to know
 *      the contract.
 */

import { queryChits, createChit, updateChit } from './chits.js';
import { ChitValidationError } from './chit-types.js';
import type { Chit } from './types/chit.js';

// ─── writeOrBumpKink ────────────────────────────────────────────────

export interface WriteOrBumpKinkOpts {
  corpRoot: string;
  /** e.g. `sweeper:silentexit`. Half of the dedup key. */
  source: string;
  /** Typically a member id or chit id. Half of the dedup key. */
  subject: string;
  severity: 'info' | 'warn' | 'error';
  /** One-line summary. */
  title: string;
  /** Optional markdown body. Replaces existing body on bump. */
  body?: string;
  /** Who's writing. Defaults to `source` if absent. */
  createdBy?: string;
}

export interface WriteOrBumpKinkResult {
  readonly chit: Chit<'kink'>;
  /**
   * 'created' → no prior active kink matched, a new one was written.
   * 'bumped'  → existing active kink found, occurrenceCount++,
   *              severity/title/body refreshed to the latest values.
   */
  readonly action: 'created' | 'bumped';
  readonly occurrenceCount: number;
}

/**
 * Write a kink chit, or bump an existing active kink with the
 * same (source, subject). See module doc for the dedup contract.
 *
 * Defensive against the "multiple active matches" anomaly (a
 * previous writer raced, or a dedup bug slipped in): picks the
 * most-recently-updated match and proceeds. The others remain
 * active and will be visible in subsequent queries; a hygiene
 * sweeper can flag them separately.
 */
export function writeOrBumpKink(opts: WriteOrBumpKinkOpts): WriteOrBumpKinkResult {
  const writer = opts.createdBy ?? opts.source;

  // Scan all active corp-scope kinks, filter to (source, subject)
  // in memory. queryChits doesn't have a field-level predicate
  // (frontmatter fields aren't indexed), so this is the cleanest
  // path. At typical active-kink counts (tens, maybe low hundreds
  // on a bad day) this is instant.
  const result = queryChits<'kink'>(opts.corpRoot, {
    types: ['kink'],
    scopes: ['corp'],
    statuses: ['active'],
  });

  const matches = result.chits.filter(
    (c) => c.chit.fields.kink.source === opts.source && c.chit.fields.kink.subject === opts.subject,
  );

  if (matches.length === 0) {
    const chit = createChit<'kink'>(opts.corpRoot, {
      type: 'kink',
      scope: 'corp',
      createdBy: writer,
      fields: {
        kink: {
          source: opts.source,
          subject: opts.subject,
          severity: opts.severity,
          title: opts.title,
          occurrenceCount: 1,
        },
      },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    });
    return { chit, action: 'created', occurrenceCount: 1 };
  }

  // Pick the most-recently-updated match if there are duplicates
  // (shouldn't happen; log would surface repeated occurrences).
  // Sort descending by updatedAt.
  const target = [...matches].sort((a, b) =>
    (b.chit.updatedAt ?? '').localeCompare(a.chit.updatedAt ?? ''),
  )[0]!;

  const newCount = target.chit.fields.kink.occurrenceCount + 1;
  const updated = updateChit<'kink'>(opts.corpRoot, 'corp', 'kink', target.chit.id, {
    updatedBy: writer,
    fields: {
      kink: {
        source: opts.source,
        subject: opts.subject,
        severity: opts.severity,
        title: opts.title,
        occurrenceCount: newCount,
        // Preserve resolution as null/undefined while active —
        // validator allows that. If it was somehow set on an
        // active kink (shouldn't happen), don't clobber it here;
        // let the caller decide via resolveKink.
        ...(target.chit.fields.kink.resolution !== undefined && {
          resolution: target.chit.fields.kink.resolution,
        }),
      },
    },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });

  return { chit: updated, action: 'bumped', occurrenceCount: newCount };
}

// ─── resolveKink ────────────────────────────────────────────────────

export type KinkResolution = 'auto-resolved' | 'acknowledged' | 'dismissed';

export interface ResolveKinkOpts {
  corpRoot: string;
  /** e.g. `sweeper:silentexit`. */
  source: string;
  /** Typically a member id or chit id. */
  subject: string;
  /**
   * Why closing:
   *   auto-resolved — a subsequent sweeper run detected the
   *                   condition cleared.
   *   acknowledged  — Sexton or founder saw it, accepted as known.
   *   dismissed     — noise / false positive.
   */
  resolution: KinkResolution;
  /** Who's closing. Defaults to `source`. */
  updatedBy?: string;
}

/**
 * Close any active kink with the given (source, subject) pair.
 *
 * Returns the closed chit, or null if no active match was found
 * (common case for "the condition cleared before we started
 * tracking it" — idempotent-noop).
 *
 * If multiple active matches exist, closes all of them with the
 * same resolution. Lets a single caller undo its own dedup
 * anomalies.
 */
export function resolveKink(opts: ResolveKinkOpts): ReadonlyArray<Chit<'kink'>> {
  const writer = opts.updatedBy ?? opts.source;

  const result = queryChits<'kink'>(opts.corpRoot, {
    types: ['kink'],
    scopes: ['corp'],
    statuses: ['active'],
  });

  const matches = result.chits.filter(
    (c) => c.chit.fields.kink.source === opts.source && c.chit.fields.kink.subject === opts.subject,
  );

  if (matches.length === 0) return [];

  const closed: Chit<'kink'>[] = [];
  for (const target of matches) {
    try {
      const updated = updateChit<'kink'>(opts.corpRoot, 'corp', 'kink', target.chit.id, {
        status: 'closed',
        updatedBy: writer,
        fields: {
          kink: {
            source: target.chit.fields.kink.source,
            subject: target.chit.fields.kink.subject,
            severity: target.chit.fields.kink.severity,
            title: target.chit.fields.kink.title,
            occurrenceCount: target.chit.fields.kink.occurrenceCount,
            resolution: opts.resolution,
          },
        },
      });
      closed.push(updated);
    } catch (err) {
      if (err instanceof ChitValidationError) throw err;
      // Non-validation errors (I/O, concurrent mod) bubble up —
      // caller decides retry. Partial-close is allowed.
      throw err;
    }
  }
  return closed;
}
