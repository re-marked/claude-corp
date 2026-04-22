/**
 * Chit lifecycle scanner — Project 0.6.
 *
 * Runs periodically (registered as a daemon Clock in daemon.ts) and
 * enacts the promotion / destruction / cold policy per chit type. The
 * pure decision logic lives in @claudecorp/shared/chit-promotion; this
 * file owns the I/O: reading chits from disk, maintaining the reference
 * index across the tick, applying the verdict (updateChit or unlinkSync),
 * and writing the lifecycle log.
 *
 * Design invariants:
 *
 *   - Scanner only visits chits with `ephemeral: true`. Non-ephemeral
 *     chits never age out regardless of their destructionPolicy
 *     (policy is a no-op for those types).
 *
 *   - Index-once-per-tick. We build a ReferenceIndex at the start of
 *     each tick by scanning every chit (permanent + ephemeral) and
 *     harvesting references[]/dependsOn[] + body-text mentions. Signal
 *     detectors then run as O(1) Set lookups. Avoids the O(N*M) trap
 *     of re-scanning on every detector call.
 *
 *   - Cold is the terminal state for keep-forever chits; scanner does
 *     NOT revisit them on subsequent ticks (they have ephemeral: false
 *     after the cool action, so the next tick's queryChits({ephemeral:true})
 *     skips them naturally). This is the mechanism that keeps per-tick
 *     scanner work bounded even as observations accumulate for months.
 *
 *   - Corrupted chit files are skipped + logged, not propagated as
 *     exceptions. One bad file can't starve the tick.
 *
 *   - Writes a single JSONL log entry per action to
 *     <corpRoot>/chits/_log/lifecycle.jsonl so a later audit ("what
 *     happened to chit X?") is a grep.
 */

import { existsSync, mkdirSync, unlinkSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  queryChits,
  readChit,
  updateChit,
  chitScopeFromPath,
  getChitType,
  computeVerdict,
  stringifyFrontmatter,
  type Chit,
  type ChitTypeId,
  type ReferenceIndex,
  type PromotionVerdict,
} from '@claudecorp/shared';

// ─── Log types ──────────────────────────────────────────────────────

/** Single log entry for an action the scanner took. Appended as JSONL. */
export interface LifecycleLogEntry {
  ts: string; // ISO timestamp
  action: 'promoted' | 'destroyed' | 'cooled' | 'skipped-parse-error';
  chitId: string;
  chitType?: ChitTypeId;
  path: string;
  reason?: string; // 'referenced' | 'mentioned' | 'tagged-keep' for promote; parse error message for skipped
}

/** Summary the scanner returns after a tick — useful for tests + operational metrics. */
export interface ScanResult {
  promoted: number;
  destroyed: number;
  cooled: number;
  skipped: number; // left alone — no signal, not aged
  parseErrors: number; // corrupted files skipped
  entries: LifecycleLogEntry[]; // detailed per-chit log (matches what was written to lifecycle.jsonl)
}

// ─── Reference index construction ──────────────────────────────────

/**
 * Build the ReferenceIndex for the current corp state. Walks every
 * chit once and harvests structured references + body-text mentions.
 * O(N) in total chit count, done once per tick.
 *
 * Body-text scan uses a chit-id regex (`chit-[a-z]+-[0-9a-f]{8}`) so
 * only well-formed chit ids count as mentions. Stray strings that
 * happen to look vaguely id-shaped don't trigger false promotions.
 */
export function buildReferenceIndex(corpRoot: string): ReferenceIndex {
  const referencedIds = new Set<string>();
  const mentionedIds = new Set<string>();

  // queryChits with no filter = every chit in every scope
  const { chits: allChits } = queryChits(corpRoot, { limit: 0 });

  for (const { chit, path } of allChits) {
    // Structured references — references[] + dependsOn[]
    for (const id of chit.references) referencedIds.add(id);
    for (const id of chit.dependsOn) referencedIds.add(id);

    // Body-text mentions — regex over the markdown body
    try {
      const raw = readFileSync(path, 'utf-8');
      // Strip frontmatter. Format is: ---\n<frontmatter>\n---\n<body>
      // Split on \n---\n gives [frontmatter-lead, body] — slice(1) is the body.
      // If the closing fence is absent, scan the whole file (still correct —
      // structured refs were already collected above from the parsed chit).
      const parts = raw.split(/\n---\n/);
      const body = parts.length >= 2 ? parts.slice(1).join('\n---\n') : raw;
      for (const match of body.matchAll(/chit-[a-z]+-[0-9a-f]{8}/g)) {
        mentionedIds.add(match[0]);
      }
    } catch {
      // unreadable file — skip body contribution, structured refs
      // already collected above from the parsed chit
    }
  }

  return { referencedIds, mentionedIds };
}

// ─── Scanner main entry ────────────────────────────────────────────

export interface ScanOpts {
  /** Clock override for testability. Defaults to new Date(). */
  now?: Date;
}

/**
 * Run one tick of the chit lifecycle scanner. Returns a ScanResult
 * summary + writes per-action entries to
 * <corpRoot>/chits/_log/lifecycle.jsonl.
 *
 * Idempotent: re-running immediately after a successful tick is a no-op
 * except for any new chits that slipped in. Long downtime recovery is
 * safe — the scanner processes the whole backlog in one tick.
 */
export function scanChitLifecycle(corpRoot: string, opts: ScanOpts = {}): ScanResult {
  const now = opts.now ?? new Date();
  const result: ScanResult = {
    promoted: 0,
    destroyed: 0,
    cooled: 0,
    skipped: 0,
    parseErrors: 0,
    entries: [],
  };

  const index = buildReferenceIndex(corpRoot);

  // Find all ephemeral chits — only these are candidates for any action.
  // queryChits returns malformed entries separately; we log those too.
  const { chits: ephemeralChits, malformed } = queryChits(corpRoot, {
    ephemeral: true,
    limit: 0,
  });

  // Parse-error files get a log entry + skip
  for (const bad of malformed) {
    const entry: LifecycleLogEntry = {
      ts: now.toISOString(),
      action: 'skipped-parse-error',
      chitId: 'unknown',
      path: bad.path,
      reason: bad.error,
    };
    result.entries.push(entry);
    result.parseErrors++;
  }

  for (const { chit, path } of ephemeralChits) {
    const typeEntry = getChitType(chit.type);
    if (!typeEntry) {
      // Shouldn't happen — queryChits already filtered to known types
      continue;
    }

    const verdict = computeVerdict(chit, index, now, typeEntry.destructionPolicy);
    const entry = applyVerdict(corpRoot, chit, path, verdict, now);
    if (entry) {
      result.entries.push(entry);
      if (entry.action === 'promoted') result.promoted++;
      else if (entry.action === 'destroyed') result.destroyed++;
      else if (entry.action === 'cooled') result.cooled++;
    } else {
      // skip verdict — no action taken, scanner revisits next tick
      result.skipped++;
    }
  }

  // Batch-append the log at end of tick so we don't spam syscalls mid-scan.
  appendLifecycleLog(corpRoot, result.entries);

  return result;
}

// ─── Action dispatch ────────────────────────────────────────────────

/**
 * Apply a verdict to a single chit. Returns the log entry describing
 * the action, or null for skip verdicts (no action taken).
 *
 * Wraps every write in try/catch — if updateChit or unlinkSync fails
 * for one chit, the scanner continues with the next. A single stuck
 * chit can't break the whole tick.
 */
function applyVerdict(
  corpRoot: string,
  chit: Chit,
  path: string,
  verdict: PromotionVerdict,
  now: Date,
): LifecycleLogEntry | null {
  const base = {
    ts: now.toISOString(),
    chitId: chit.id,
    chitType: chit.type,
    path,
  };

  try {
    switch (verdict.kind) {
      case 'promote': {
        const scope = chitScopeFromPath(corpRoot, path);
        updateChit(corpRoot, scope, chit.type, chit.id, {
          updatedBy: 'lifecycle-scanner',
          // updateChit doesn't expose ephemeral/ttl mutation directly;
          // we write them via a light passthrough below.
        });
        // Clear ephemeral + ttl by rewriting the file. The update above
        // bumped updatedAt; now we re-read and patch the shared fields.
        // This two-step exists because chits.ts intentionally gates
        // ephemeral/ttl mutation — lifecycle-scanner is the one caller
        // allowed to flip them, so it uses direct file rewrite.
        rewriteEphemeralFields(corpRoot, chit.type, chit.id, {
          ephemeral: false,
          ttl: undefined,
        });
        return { ...base, action: 'promoted', reason: verdict.reason };
      }
      case 'destroy': {
        unlinkSync(path);
        return { ...base, action: 'destroyed' };
      }
      case 'cold': {
        const scope = chitScopeFromPath(corpRoot, path);
        updateChit(corpRoot, scope, chit.type, chit.id, {
          status: 'cold',
          updatedBy: 'lifecycle-scanner',
        });
        // Same pattern as promote: clear ephemeral + ttl alongside the status flip
        rewriteEphemeralFields(corpRoot, chit.type, chit.id, {
          ephemeral: false,
          ttl: undefined,
        });
        return { ...base, action: 'cooled' };
      }
      case 'skip':
        return null;
    }
  } catch (err) {
    // One failure shouldn't starve the rest. Log and continue.
    return {
      ...base,
      action: 'skipped-parse-error',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Lifecycle-specific mutation of ephemeral + ttl. Rewrites the file
 * with the fields flipped. Not exposed on chits.ts's updateChit because
 * ordinary callers shouldn't be changing ephemeral status — only the
 * scanner gets to enact that transition.
 */
function rewriteEphemeralFields(
  corpRoot: string,
  type: ChitTypeId,
  id: string,
  patch: { ephemeral: boolean; ttl?: string | undefined },
): void {
  // Find the chit again (scope may not be in scope here — easier to re-find)
  const { chits } = queryChits(corpRoot, { types: [type], limit: 0 });
  const hit = chits.find((c) => c.chit.id === id);
  if (!hit) return;

  const current = readChit(corpRoot, chitScopeFromPath(corpRoot, hit.path), type, id);
  const updated = { ...current.chit, ephemeral: patch.ephemeral } as unknown as Record<string, unknown>;
  if (patch.ttl === undefined) delete updated.ttl;
  else updated.ttl = patch.ttl;

  // Rebuild the full file contents using the shared frontmatter
  // stringifier. updateChit above bumped updatedAt + updatedBy; this
  // rewrite only flips the lifecycle-specific ephemeral/ttl fields that
  // updateChit's public API intentionally doesn't expose.
  const full = stringifyFrontmatter(updated, current.body);
  writeFileSync(hit.path, full, 'utf-8');
}

// ─── Log writer ─────────────────────────────────────────────────────

/**
 * Append lifecycle log entries to <corpRoot>/chits/_log/lifecycle.jsonl.
 * Best-effort — log write failures don't crash the scanner.
 */
function appendLifecycleLog(corpRoot: string, entries: LifecycleLogEntry[]): void {
  if (entries.length === 0) return;
  try {
    const logDir = join(corpRoot, 'chits', '_log');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, 'lifecycle.jsonl');
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(logPath, lines, 'utf-8');
  } catch {
    // swallow — the scanner's entries are also returned in-memory via ScanResult
  }
}
