/**
 * Bacteria event log — append-only stream of mitose + apoptose
 * events written by the daemon's executor, read by everything that
 * needs pool-activity stats (status command, lineage view, Sexton's
 * wake prompts, TUI sidebar aggregation, future Project 4 dreams).
 *
 * Why a JSONL log instead of querying observation chits:
 *
 *   The naming + obituary observation chits already capture each
 *   slot's birth/death moments, but reading them out for stats means
 *   scanning the chit store and parsing frontmatter for every
 *   observation in the corp every time. The events log is one
 *   filesystem read, one line per event, ms-precision timestamps,
 *   and a typed shape. Cheap for status; cheap for Sexton; cheap for
 *   future dreams that compound bacteria patterns into BRAIN entries.
 *
 *   Substrate, not duplication: the events log doesn't replace the
 *   observation chits. The chits are the agent-voice / soul layer
 *   (subject for dream distillation, queryable history). The events
 *   log is the mechanical-organism layer. Different audiences,
 *   different read patterns; both subjects of a slot's life get
 *   recorded for their respective consumers.
 *
 * File path: `<corpRoot>/bacteria-events.jsonl` — one JSON object per
 * line, terminated with `\n`. Open question deferred to a follow-up:
 * rotation when the file gets large (1000s of events). Same shape as
 * existing daemon log rotation will eventually handle it.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACTERIA_EVENTS_JSONL } from './constants.js';

// ─── Event shapes ───────────────────────────────────────────────────

/**
 * Slot birth — bacteria mitosed a new Employee for `role`. Captured
 * at the moment processManager.spawnAgent succeeds; the slot is
 * fully committed to disk before the event lands.
 */
export interface MitoseEvent {
  readonly kind: 'mitose';
  /** ISO timestamp the mitose committed (post-spawn). */
  readonly ts: string;
  readonly role: string;
  readonly slug: string;
  readonly generation: number;
  readonly parentSlug: string | null;
  readonly assignedChit: string;
}

/**
 * Slot death — bacteria apoptosed an idle Employee. Captured AFTER
 * the Member is removed from members.json so the lifetime metrics
 * (lifetimeMs, tasksCompleted, chosenName) reflect the slot's
 * complete lived state.
 *
 *   chosenName    — the displayName at apoptose time. null when the
 *                   slot apoptosed before naming itself (rare, but
 *                   possible for very short-lived slots that never
 *                   ran a session before the queue drained).
 *   lifetimeMs    — apoptose ts - Member.createdAt.
 *   tasksCompleted — count of task chits where assignee=slug AND
 *                   workflowStatus='completed' at apoptose time.
 *                   Single chit-store scan; acceptable cost for the
 *                   per-apoptose granularity.
 */
export interface ApoptoseEvent {
  readonly kind: 'apoptose';
  readonly ts: string;
  readonly role: string;
  readonly slug: string;
  readonly generation: number;
  readonly parentSlug: string | null;
  readonly chosenName: string | null;
  readonly reason: string;
  readonly idleSince: string;
  readonly lifetimeMs: number;
  readonly tasksCompleted: number;
}

export type BacteriaEvent = MitoseEvent | ApoptoseEvent;

// ─── Append ─────────────────────────────────────────────────────────

/**
 * Append a single event to the corp's bacteria-events.jsonl.
 * Synchronous + atomic for short JSON lines (POSIX appendFile is
 * atomic for writes ≤ PIPE_BUF). Writers are serialized by the
 * daemon's reactor mutex, so no concurrent-writer contention exists
 * in v1; multi-process bacteria would need a different strategy.
 *
 * Best-effort: a write failure is logged at the executor layer but
 * does not abort the upstream mutation (the slot was already
 * committed). The event log is a witness, not a transaction
 * participant.
 */
export function appendBacteriaEvent(
  corpRoot: string,
  event: BacteriaEvent,
): void {
  const path = join(corpRoot, BACTERIA_EVENTS_JSONL);
  appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8');
}

// ─── Read ───────────────────────────────────────────────────────────

export interface ReadBacteriaEventsOpts {
  /** Filter to events at or after this ISO timestamp. */
  readonly since?: string;
  /** Filter to events at or before this ISO timestamp. */
  readonly until?: string;
  /** Filter to events for this role only. */
  readonly role?: string;
  /** Filter to events of this kind only. */
  readonly kind?: 'mitose' | 'apoptose';
}

/**
 * Read events from the log, optionally filtered. Returns an empty
 * array when the file doesn't exist (fresh corp, never had any
 * bacteria activity yet) — never throws on missing.
 *
 * Malformed lines are skipped, not thrown. Defensive against a
 * partial-write or external mutation: a corrupted line shouldn't
 * blind every consumer.
 *
 * Order preserved: events come back in the order they were written
 * (chronological, since the log is append-only).
 */
export function readBacteriaEvents(
  corpRoot: string,
  opts: ReadBacteriaEventsOpts = {},
): BacteriaEvent[] {
  const path = join(corpRoot, BACTERIA_EVENTS_JSONL);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }

  const events: BacteriaEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isBacteriaEvent(parsed)) continue;

    if (opts.kind && parsed.kind !== opts.kind) continue;
    if (opts.role && parsed.role !== opts.role) continue;
    if (opts.since && parsed.ts < opts.since) continue;
    if (opts.until && parsed.ts > opts.until) continue;

    events.push(parsed);
  }
  return events;
}

/**
 * Type guard — defensive against external mutation of the log file.
 * A line that doesn't have the expected shape gets skipped silently
 * by readBacteriaEvents.
 */
function isBacteriaEvent(x: unknown): x is BacteriaEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  if (e.kind !== 'mitose' && e.kind !== 'apoptose') return false;
  if (typeof e.ts !== 'string') return false;
  if (typeof e.role !== 'string') return false;
  if (typeof e.slug !== 'string') return false;
  if (typeof e.generation !== 'number') return false;
  // Kind-specific required fields — prevents NaN in downstream numeric
  // aggregations when a truncated-write or external mutation omits them.
  if (e.kind === 'mitose') {
    if (typeof e.assignedChit !== 'string') return false;
  }
  if (e.kind === 'apoptose') {
    if (typeof e.lifetimeMs !== 'number') return false;
    if (typeof e.tasksCompleted !== 'number') return false;
    if (typeof e.idleSince !== 'string') return false;
  }
  return true;
}
