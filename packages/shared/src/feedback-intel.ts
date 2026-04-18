/**
 * Feedback Intel — read-only introspection of the feedback pipeline.
 *
 * Powers `cc-cli feedback` and the `/feedback` TUI view. Reads from the
 * filesystem only — no mutations. Aggregates:
 *
 *   - `.pending-feedback.md` the router stamped on each agent (raw
 *     corrections/confirmations not yet consumed by dreams).
 *   - BRAIN/ entries that were promoted from feedback — `source:
 *     correction | confirmation | founder-direct` — with `times_heard`
 *     counters showing how often the theme has compounded.
 *   - Corp-wide `CULTURE.md` and the pending promotion candidates
 *     (via `getCultureCandidates`).
 *
 * The pipeline is otherwise invisible. This module is the window into
 * "what has Mark actually taught the corp, and what's about to become
 * law next dream cycle."
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findAllAgentDirs } from './brain-culture.js';
import { listBrainFiles } from './brain.js';
import {
  getCultureCandidates,
  getCulturePath,
  readCulture,
  type CultureCandidate,
} from './culture.js';
import type { BrainFile, BrainSource } from './types/brain.js';

// ── Types ───────────────────────────────────────────────────────────

/** Sources we treat as "the founder spoke" — worth showing in intel. */
const FEEDBACK_SOURCES: ReadonlySet<BrainSource> = new Set([
  'correction',
  'confirmation',
  'founder-direct',
]);

/** One entry inside `.pending-feedback.md`, pre-interpretation. */
export interface PendingFeedbackEntry {
  /** ISO timestamp from the entry header. Null if unparseable. */
  timestamp: string | null;
  /** Channel label the router recorded (e.g., "DM (dm-alice)" or "#general"). */
  channel: string | null;
  /** `correction | confirmation | mixed` as detected by the router. */
  polarity: 'correction' | 'confirmation' | 'mixed' | 'unknown';
  /** Named regex patterns that matched, best-effort parsed. */
  matchedPatterns: string[];
  /** The founder's quoted message. */
  quote: string;
  /** The agent's prior message, if the router captured one. */
  priorContext: string;
  /** Raw entry text — useful when UIs want to show the untouched block. */
  raw: string;
}

/** BRAIN entry shaped for feedback intel display. */
export interface FeedbackBrainEntry {
  name: string;
  path: string;
  type: BrainFile['meta']['type'];
  source: BrainSource;
  confidence: BrainFile['meta']['confidence'];
  tags: string[];
  timesHeard: number;
  updated: string;
  lastValidated: string;
  excerpt: string;
}

/** Full per-agent feedback snapshot. */
export interface AgentFeedbackIntel {
  agentName: string;
  agentDir: string;
  /** Pending file path (may not exist). */
  pendingPath: string;
  /** True if the pending file exists AND has at least one entry. */
  hasPending: boolean;
  /** Parsed pending-feedback entries, most recent first. */
  pending: PendingFeedbackEntry[];
  /** Raw unparsed pending-feedback body (for debug / raw display). */
  pendingRaw: string | null;
  /** mtime of the pending file in ms since epoch (for freshness UIs). */
  pendingMtimeMs: number | null;
  /** BRAIN entries sourced from feedback, sorted by timesHeard desc. */
  brainEntries: FeedbackBrainEntry[];
  /** Totals for at-a-glance UIs. */
  stats: {
    pendingCount: number;
    correctionCount: number;
    confirmationCount: number;
    totalTimesHeard: number;
    repeatedEntryCount: number;
  };
}

/** Corp-level aggregated intel, for the TUI overview and cc-cli. */
export interface CorpFeedbackIntel {
  agents: AgentFeedbackIntel[];
  culturePath: string;
  cultureContent: string | null;
  cultureSizeChars: number;
  /** Candidates queued up for the next CEO dream (via culture.ts). */
  candidates: CultureCandidate[];
  totals: {
    agentsWithPending: number;
    totalPendingEntries: number;
    totalCorrectionPending: number;
    totalConfirmationPending: number;
    totalFeedbackBrainEntries: number;
    totalTimesHeard: number;
    strongCandidates: number;
    moderateCandidates: number;
  };
}

// ── Pending-feedback parser ─────────────────────────────────────────

const ENTRY_SEPARATOR = /\n---\s*\n/;

/**
 * Parse a `.pending-feedback.md` body into structured entries.
 *
 * The router writes a fixed shape (see `router.maybeCaptureFeedback`).
 * We split on `\n---\n`, skip the header block, and extract each
 * section's fields with forgiving regexes. If a field is missing we
 * fall back to sensible defaults; the raw entry is always preserved
 * for UIs that want to show the original block.
 */
export function parsePendingFeedback(body: string): PendingFeedbackEntry[] {
  if (!body || body.trim().length === 0) return [];

  // Drop the file header (everything up to and including the first ---).
  const bodyWithoutHeader = body.replace(/^#[^\n]*\n[\s\S]*?\n---\s*\n/, '');

  const segments = bodyWithoutHeader.split(ENTRY_SEPARATOR)
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.startsWith('## '));

  const entries: PendingFeedbackEntry[] = [];
  for (const raw of segments) {
    const tsMatch = raw.match(/^##\s+(\S+)/);
    const channelMatch = raw.match(/^\*\*Channel:\*\*\s+(.+)$/m);
    const signalMatch = raw.match(/^\*\*Signal:\*\*\s+(\w+)\s*\(matched:\s*([^)]*)\)/m);

    // Quote — lines after "**Quote:**" that start with "> "
    let quote = '';
    const quoteIdx = raw.indexOf('**Quote:**');
    if (quoteIdx !== -1) {
      const afterQuote = raw.slice(quoteIdx + '**Quote:**'.length);
      // Stop at the next section marker
      const stopIdx = afterQuote.search(/\n\*\*Prior context:\*\*/);
      const quoteBlock = stopIdx === -1 ? afterQuote : afterQuote.slice(0, stopIdx);
      quote = quoteBlock
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('>'))
        .map(l => l.replace(/^>\s?/, ''))
        .join('\n')
        .trim();
    }

    // Prior context — lines after "**Prior context:**" until end of entry
    let priorContext = '';
    const priorIdx = raw.indexOf('**Prior context:**');
    if (priorIdx !== -1) {
      priorContext = raw
        .slice(priorIdx + '**Prior context:**'.length)
        .trim();
    }

    const polarityRaw = (signalMatch?.[1] ?? '').toLowerCase();
    const polarity: PendingFeedbackEntry['polarity'] =
      polarityRaw === 'correction' || polarityRaw === 'confirmation' || polarityRaw === 'mixed'
        ? polarityRaw
        : 'unknown';

    const matchedPatterns = (signalMatch?.[2] ?? '')
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0 && !/^\+\d+\s+more$/.test(p));

    entries.push({
      timestamp: tsMatch?.[1] ?? null,
      channel: channelMatch?.[1]?.trim() ?? null,
      polarity,
      matchedPatterns,
      quote,
      priorContext,
      raw,
    });
  }

  // Newest first — the router appends chronologically, so reverse.
  return entries.reverse();
}

// ── Per-agent intel ─────────────────────────────────────────────────

export function getAgentFeedbackIntel(
  corpRoot: string,
  agentName: string,
  agentDir: string,
): AgentFeedbackIntel {
  const pendingPath = join(agentDir, '.pending-feedback.md');
  let pendingRaw: string | null = null;
  let pendingMtimeMs: number | null = null;
  let pending: PendingFeedbackEntry[] = [];

  if (existsSync(pendingPath)) {
    try {
      pendingRaw = readFileSync(pendingPath, 'utf-8');
      pendingMtimeMs = statSync(pendingPath).mtimeMs;
      pending = parsePendingFeedback(pendingRaw);
    } catch {
      // Corrupt/unreadable — leave as empty
    }
  }

  let brainFiles: BrainFile[] = [];
  try {
    brainFiles = listBrainFiles(agentDir);
  } catch {
    // Missing BRAIN dir is fine
  }

  const brainEntries: FeedbackBrainEntry[] = [];
  for (const f of brainFiles) {
    if (!FEEDBACK_SOURCES.has(f.meta.source)) continue;
    const timesHeard = typeof f.meta.times_heard === 'number'
      ? Math.max(1, f.meta.times_heard)
      : 1;
    brainEntries.push({
      name: f.name,
      path: f.path,
      type: f.meta.type,
      source: f.meta.source,
      confidence: f.meta.confidence,
      tags: f.meta.tags,
      timesHeard,
      updated: f.meta.updated,
      lastValidated: f.meta.last_validated,
      excerpt: f.body.trim().replace(/\n+/g, ' ').slice(0, 200),
    });
  }
  brainEntries.sort((a, b) => b.timesHeard - a.timesHeard || b.updated.localeCompare(a.updated));

  const correctionCount = pending.filter(e => e.polarity === 'correction').length;
  const confirmationCount = pending.filter(e => e.polarity === 'confirmation').length;
  const totalTimesHeard = brainEntries.reduce((s, e) => s + e.timesHeard, 0);
  const repeatedEntryCount = brainEntries.filter(e => e.timesHeard >= 2).length;

  return {
    agentName,
    agentDir,
    pendingPath,
    hasPending: pending.length > 0,
    pending,
    pendingRaw,
    pendingMtimeMs,
    brainEntries,
    stats: {
      pendingCount: pending.length,
      correctionCount,
      confirmationCount,
      totalTimesHeard,
      repeatedEntryCount,
    },
  };
}

// ── Corp-wide intel ─────────────────────────────────────────────────

export function getCorpFeedbackIntel(corpRoot: string): CorpFeedbackIntel {
  const agentDirs = findAllAgentDirs(corpRoot);

  const agents: AgentFeedbackIntel[] = agentDirs.map(a =>
    getAgentFeedbackIntel(corpRoot, a.name, a.dir),
  );
  // Most-recent-pending first so the TUI's left column surfaces urgency.
  agents.sort((a, b) => {
    const am = a.pendingMtimeMs ?? 0;
    const bm = b.pendingMtimeMs ?? 0;
    if (am !== bm) return bm - am;
    return b.stats.totalTimesHeard - a.stats.totalTimesHeard;
  });

  const cultureContent = readCulture(corpRoot);
  const cultureSizeChars = cultureContent?.length ?? 0;

  let candidates: CultureCandidate[] = [];
  try {
    candidates = getCultureCandidates(corpRoot);
  } catch {
    // If scan fails, intel still works without promotion queue
  }

  const agentsWithPending = agents.filter(a => a.hasPending).length;
  const totalPendingEntries = agents.reduce((s, a) => s + a.stats.pendingCount, 0);
  const totalCorrectionPending = agents.reduce((s, a) => s + a.stats.correctionCount, 0);
  const totalConfirmationPending = agents.reduce((s, a) => s + a.stats.confirmationCount, 0);
  const totalFeedbackBrainEntries = agents.reduce((s, a) => s + a.brainEntries.length, 0);
  const totalTimesHeard = agents.reduce((s, a) => s + a.stats.totalTimesHeard, 0);
  const strongCandidates = candidates.filter(c => c.strength === 'strong').length;
  const moderateCandidates = candidates.filter(c => c.strength === 'moderate').length;

  return {
    agents,
    culturePath: getCulturePath(corpRoot),
    cultureContent,
    cultureSizeChars,
    candidates,
    totals: {
      agentsWithPending,
      totalPendingEntries,
      totalCorrectionPending,
      totalConfirmationPending,
      totalFeedbackBrainEntries,
      totalTimesHeard,
      strongCandidates,
      moderateCandidates,
    },
  };
}
