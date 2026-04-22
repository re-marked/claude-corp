/**
 * Chit promotion signal detectors — pure functions consumed by the
 * chit-lifecycle scanner (0.6, packages/daemon/src/chit-lifecycle.ts).
 *
 * The scanner walks all ephemeral chits once per tick and asks: does
 * this chit deserve to be promoted (made permanent)? The answer is
 * derived from 4 Gas-Town-inspired signals:
 *
 *   (a) referenced   — a permanent chit names this id in references[]
 *                      or dependsOn[]
 *   (b) mentioned    — another chit's body text literally contains this
 *                      id (regex match on the chit-id format)
 *   (c) tagged keep  — 'keep' appears in chit.tags
 *   (d) aged past TTL — createdAt + ttl < now. This is the tie-breaker,
 *                      not a promotion signal — see the lifecycle scanner
 *                      for how aged-out chits branch by destructionPolicy.
 *
 * Signals (a) and (b) each require knowing what other chits look like,
 * so they consume a precomputed `ReferenceIndex` instead of hitting
 * the filesystem on every call. The lifecycle scanner builds the index
 * once per tick via buildReferenceIndex (which lives in chit-lifecycle.ts
 * — kept there because it's I/O, not a pure predicate).
 *
 * Keeping the detectors pure makes them unit-testable with tiny
 * fixtures and means the scanner doesn't have to stub fs when it
 * wants to test a decision path.
 */

import type { Chit } from './types/chit.js';

// ─── Reference index (built by chit-lifecycle, consumed here) ───────

/**
 * Snapshot of reference / mention information across all chits in the
 * corp at a single scanner tick. Built once per tick by the lifecycle
 * scanner, passed to each detector call. Membership tests here are O(1).
 *
 * Both sets are populated from ALL chits encountered during the scan
 * (permanent + ephemeral, any type, any scope). The detector uses the
 * set to answer "is this id cited anywhere" without re-scanning.
 */
export interface ReferenceIndex {
  /**
   * Ids cited in `references[]` or `dependsOn[]` of any chit in the corp.
   * This is the "structured" reference signal — matches the cheap cases
   * where one chit's frontmatter explicitly points at another.
   */
  referencedIds: Set<string>;
  /**
   * Ids that appear as text in any chit's body. Captures the weaker
   * "someone mentioned this in their notes" case that isn't expressed
   * as a structured reference edge. Populated by regex-matching the
   * chit-id format in body strings during the scanner pass.
   */
  mentionedIds: Set<string>;
}

// ─── Pure detectors ─────────────────────────────────────────────────

/**
 * Signal (a). True when some other chit names this id in its
 * `references[]` or `dependsOn[]` arrays. Cheap — O(1) Set lookup
 * against the precomputed index.
 */
export function isReferenced(id: string, index: ReferenceIndex): boolean {
  return index.referencedIds.has(id);
}

/**
 * Signal (b). True when some other chit's body text contains this id.
 * O(1) Set lookup; the body-text regex scan happens once at index-build
 * time, not per-detector-call.
 *
 * Largely subsumed by (a) in practice — most real mentions are also
 * structured references. Kept separate because the semantics differ:
 * a body-text mention is evidence of informal awareness without a
 * formal edge, which is exactly the signal Gas Town's original
 * "commented" case was reaching for.
 */
export function isMentioned(id: string, index: ReferenceIndex): boolean {
  return index.mentionedIds.has(id);
}

/**
 * Signal (c). True when the chit carries a `keep` tag. The explicit
 * user/agent veto against destruction — "I looked at this and it
 * matters, don't let it age out."
 *
 * Case-insensitive match so agents can tag `Keep`, `KEEP`, etc.
 * without the signal silently missing.
 */
export function hasKeepTag(chit: Chit): boolean {
  return chit.tags.some((t) => t.toLowerCase() === 'keep');
}

/**
 * Signal (d). True when the chit's TTL has elapsed (createdAt + ttl < now).
 *
 * NOT a promotion signal — the tie-breaker path. The lifecycle scanner
 * treats this as "no promotion signal fired AND time has elapsed" and
 * branches on the type's destructionPolicy to decide destroy-vs-cold.
 *
 * Returns false when ttl is undefined (ephemeral-no-expiry chits, e.g.
 * dispatch-contexts that close on work-completion rather than time).
 * Returns false when ephemeral=false — non-ephemeral chits shouldn't
 * be aging out regardless of what the scanner does.
 */
export function hasAged(chit: Chit, now: Date): boolean {
  if (!chit.ephemeral) return false;
  if (!chit.ttl) return false;
  const ttlMs = Date.parse(chit.ttl);
  if (Number.isNaN(ttlMs)) return false;
  return ttlMs < now.getTime();
}

// ─── Combined decision helper ───────────────────────────────────────

/**
 * Promotion verdict for a chit — the terminal state the scanner will
 * drive it to on this tick.
 */
export type PromotionVerdict =
  /** (a)/(b)/(c) fired — flip ephemeral:false, clear ttl. */
  | { kind: 'promote'; reason: 'referenced' | 'mentioned' | 'tagged-keep' }
  /** TTL aged + destroy-if-not-promoted — remove file, log destruction. */
  | { kind: 'destroy' }
  /** TTL aged + keep-forever — flip status:'cold', ephemeral:false. */
  | { kind: 'cold' }
  /** No signal fired and not aged — leave untouched, scanner revisits next tick. */
  | { kind: 'skip' };

/**
 * Compute the verdict for a single chit given an index + policy + clock.
 * Pure function — no I/O, no side effects. Makes every decision path
 * trivially testable with hand-built fixtures.
 *
 * Signal priority: (c) tagged-keep wins over (a)(b) because explicit
 * agent intent beats inferred evidence. Within (a)/(b), (a) wins on
 * specificity. Ordering matters only for the reason field — the
 * verdict kind is 'promote' either way.
 */
export function computeVerdict(
  chit: Chit,
  index: ReferenceIndex,
  now: Date,
  destructionPolicy: 'destroy-if-not-promoted' | 'keep-forever',
): PromotionVerdict {
  // Promotion signals first — if any fires, the chit survives this tick.
  if (hasKeepTag(chit)) {
    return { kind: 'promote', reason: 'tagged-keep' };
  }
  if (isReferenced(chit.id, index)) {
    return { kind: 'promote', reason: 'referenced' };
  }
  if (isMentioned(chit.id, index)) {
    return { kind: 'promote', reason: 'mentioned' };
  }

  // No promotion signal. Tie-breaker on age.
  if (!hasAged(chit, now)) {
    return { kind: 'skip' };
  }

  // Aged out — branch on type policy.
  return destructionPolicy === 'destroy-if-not-promoted'
    ? { kind: 'destroy' }
    : { kind: 'cold' };
}
