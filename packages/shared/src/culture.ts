/**
 * Corp Culture — feedback that compounded enough to become shared law.
 *
 * CULTURE.md lives at the corp root and holds rules that emerged from
 * repeated founder corrections/confirmations across the corp. Agents
 * read it on boot and on every dispatch (via a fragment), so lessons
 * paid for once by any agent accrue to every agent.
 *
 * Write path: CEO dream. CEO's dream prompt receives a pre-computed
 * list of candidates from `getCultureCandidates()` — feedback-sourced
 * BRAIN entries that show up across multiple agents or repeatedly for
 * one agent. CEO interprets them, decides which are load-bearing, and
 * appends to CULTURE.md in their own voice.
 *
 * Read path: bootstrap-agent template (new hires) + fragments/culture
 * (always-on for existing agents).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findAllAgentDirs } from './brain-culture.js';
import { listBrainFiles } from './brain.js';
import type { BrainFile, BrainMemoryType, BrainSource } from './types/brain.js';

// ── Constants ───────────────────────────────────────────────────────

export const CULTURE_MD_FILENAME = 'CULTURE.md';

/** Memory types that plausibly carry corp-wide rules. */
const CULTURAL_TYPES: ReadonlySet<BrainMemoryType> = new Set([
  'correction',
  'founder-preference',
]);

/** Sources that indicate the founder spoke — worth surfacing to CEO. */
const FEEDBACK_SOURCES: ReadonlySet<BrainSource> = new Set([
  'correction',
  'confirmation',
  'founder-direct',
]);

// ── Types ───────────────────────────────────────────────────────────

/** Strength tier — drives whether CEO should promote this cycle. */
export type CandidateStrength = 'strong' | 'moderate' | 'weak';

/** A single BRAIN entry contributing to a candidate cluster. */
export interface CandidateEntry {
  agent: string;
  file: string;
  type: BrainMemoryType;
  source: BrainSource;
  confidence: BrainFile['meta']['confidence'];
  timesHeard: number;
  updated: string;
  /** First ~200 chars of the body — enough for CEO to judge the theme. */
  excerpt: string;
  tags: string[];
}

/** A cluster of feedback entries that share a theme (tag overlap). */
export interface CultureCandidate {
  /** The tags common to the cluster — the theme fingerprint. */
  sharedTags: string[];
  /** Unique agents represented in this cluster. */
  agents: string[];
  /** The contributing entries, sorted by most-recently-updated. */
  entries: CandidateEntry[];
  /** Max times_heard across all entries. */
  maxTimesHeard: number;
  /** Total times_heard summed (how noisy / repeated overall). */
  totalTimesHeard: number;
  strength: CandidateStrength;
}

// ── IO ──────────────────────────────────────────────────────────────

export function getCulturePath(corpRoot: string): string {
  return join(corpRoot, CULTURE_MD_FILENAME);
}

/** Read CULTURE.md contents, or null if the file doesn't exist. */
export function readCulture(corpRoot: string): string | null {
  const p = getCulturePath(corpRoot);
  if (!existsSync(p)) return null;
  const content = readFileSync(p, 'utf-8');
  return content.trim().length === 0 ? null : content;
}

/** Write CULTURE.md with the given content. Caller owns formatting. */
export function writeCulture(corpRoot: string, content: string): void {
  writeFileSync(getCulturePath(corpRoot), content, 'utf-8');
}

// ── Candidate Synthesis ─────────────────────────────────────────────

/**
 * Scan all agents' BRAIN/ for feedback-sourced entries and cluster
 * them by tag overlap. Returns candidates CEO should consider for
 * promotion to CULTURE.md.
 *
 * Clustering rule (conservative): two entries are in the same cluster
 * if they share >= 2 tags AND at least one of them is not a generic
 * tag. This approximates "same theme" without LLM calls — the CEO's
 * dream makes the final semantic call.
 *
 * Only returns clusters with strength moderate or strong. Weak
 * clusters (single agent, single occurrence) are not yet load-bearing
 * enough for corp-wide law.
 */
export function getCultureCandidates(corpRoot: string): CultureCandidate[] {
  const agents = findAllAgentDirs(corpRoot);
  const entries: CandidateEntry[] = [];

  for (const agent of agents) {
    let files: BrainFile[];
    try {
      files = listBrainFiles(agent.dir);
    } catch {
      continue;
    }

    for (const f of files) {
      if (!CULTURAL_TYPES.has(f.meta.type)) continue;
      if (!FEEDBACK_SOURCES.has(f.meta.source)) continue;

      const timesHeard = typeof f.meta.times_heard === 'number'
        ? Math.max(1, f.meta.times_heard)
        : 1;

      entries.push({
        agent: agent.name,
        file: f.name,
        type: f.meta.type,
        source: f.meta.source,
        confidence: f.meta.confidence,
        timesHeard,
        updated: f.meta.updated,
        excerpt: f.body.trim().slice(0, 200),
        tags: f.meta.tags.map(t => t.toLowerCase()),
      });
    }
  }

  if (entries.length === 0) return [];

  // Cluster by tag overlap. Greedy union-find: merge any two entries
  // that share >=2 tags. Single-entry clusters are allowed (a single
  // agent with times_heard >= 2 is still a signal).
  const parent = new Array(entries.length).fill(0).map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
  const union = (i: number, j: number): void => {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const shared = entries[i]!.tags.filter(t => entries[j]!.tags.includes(t));
      if (shared.length >= 2) union(i, j);
    }
  }

  // Collect clusters.
  const clusterMap = new Map<number, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const root = find(i);
    const arr = clusterMap.get(root) ?? [];
    arr.push(i);
    clusterMap.set(root, arr);
  }

  const candidates: CultureCandidate[] = [];
  for (const idxs of clusterMap.values()) {
    const clusterEntries = idxs.map(i => entries[i]!);
    const agentSet = new Set(clusterEntries.map(e => e.agent));
    const maxTimesHeard = Math.max(...clusterEntries.map(e => e.timesHeard));
    const totalTimesHeard = clusterEntries.reduce((s, e) => s + e.timesHeard, 0);

    // Shared tags across ALL entries in cluster (the strongest signal).
    const sharedTags = clusterEntries.length === 1
      ? clusterEntries[0]!.tags
      : clusterEntries.reduce<string[]>((acc, e, idx) =>
          idx === 0 ? e.tags : acc.filter(t => e.tags.includes(t)), []);

    // Classify strength.
    let strength: CandidateStrength;
    if (agentSet.size >= 3 || maxTimesHeard >= 3) strength = 'strong';
    else if (agentSet.size >= 2 || maxTimesHeard >= 2) strength = 'moderate';
    else strength = 'weak';

    // Skip weak candidates — not corp-worthy yet.
    if (strength === 'weak') continue;

    clusterEntries.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));

    candidates.push({
      sharedTags,
      agents: Array.from(agentSet).sort(),
      entries: clusterEntries,
      maxTimesHeard,
      totalTimesHeard,
      strength,
    });
  }

  // Strong first, then by total times_heard (repetition is signal).
  candidates.sort((a, b) => {
    if (a.strength !== b.strength) return a.strength === 'strong' ? -1 : 1;
    return b.totalTimesHeard - a.totalTimesHeard;
  });

  return candidates;
}
