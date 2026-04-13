/**
 * B.R.A.I.N. Culture Analysis — Cross-agent tag intelligence.
 *
 * Culture in Claude Corp is "the accumulated voice of all the text the corp
 * contains." This module makes culture VISIBLE by analyzing tags across all
 * agents' BRAINs, detecting shared vocabulary, individual idiosyncrasy,
 * cultural drift, and suggesting tag normalization.
 *
 * Shared tags = cultural vocabulary (what the corp collectively cares about)
 * Unique tags = idiosyncrasy (krasis — what only this agent cares about)
 * Tag overlap = cultural coherence (are agents speaking the same language?)
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from './parsers/config.js';
import { listBrainFiles, getBrainStats } from './brain.js';
import { MEMBERS_JSON } from './constants.js';
import type { Member } from './types/member.js';
import type { BrainFile, BrainMemoryType } from './types/brain.js';

// ── Types ───────────────────────────────────────────────────────────

/** A single tag's presence across the corp. */
export interface CorpTag {
  tag: string;
  /** Total number of BRAIN files using this tag across all agents. */
  totalUses: number;
  /** Number of distinct agents using this tag. */
  agentCount: number;
  /** Names of agents using this tag. */
  agents: string[];
  /** Whether this is shared (2+ agents) or unique to one agent. */
  shared: boolean;
}

/** An individual agent's tag fingerprint. */
export interface AgentTagSignature {
  agentName: string;
  agentDir: string;
  /** Total BRAIN files for this agent. */
  fileCount: number;
  /** All tags this agent uses. */
  allTags: string[];
  /** Tags shared with other agents in the corp. */
  sharedTags: string[];
  /** Tags only this agent uses — their idiosyncrasy. */
  uniqueTags: string[];
  /** Cultural alignment: % of agent's tags that are shared. 0–100. */
  alignmentScore: number;
  /** Tag count by memory type. */
  tagsByType: Partial<Record<BrainMemoryType, string[]>>;
}

/** Overlap between two agents. */
export interface AgentOverlap {
  agentA: string;
  agentB: string;
  sharedTags: string[];
  overlapScore: number; // Jaccard similarity: |intersection| / |union|
}

/** Potential tag normalization (near-duplicate tags). */
export interface TagNormalizationSuggestion {
  tags: string[];
  reason: string;
  suggestedCanonical: string;
}

/** Culture health assessment. */
export interface CultureHealth {
  /** Overall health: 'thriving' | 'healthy' | 'thin' | 'absent' */
  status: 'thriving' | 'healthy' | 'thin' | 'absent';
  /** Total unique tags across the corp. */
  totalUniqueTags: number;
  /** Tags shared by 2+ agents. */
  sharedTagCount: number;
  /** Average cultural alignment across agents. */
  averageAlignment: number;
  /** Agent with lowest alignment (potential drift). */
  leastAligned: { name: string; score: number } | null;
  /** Agent with highest unique tags (most idiosyncratic). */
  mostIdiosyncratic: { name: string; uniqueCount: number } | null;
  /** Tag diversity: ratio of unique tags to total tag uses. Higher = more diverse. */
  diversityRatio: number;
  /** Warnings about culture health. */
  warnings: string[];
}

/** Full cross-agent culture analysis. */
export interface CorpCultureStats {
  /** All agents analyzed. */
  agents: AgentTagSignature[];
  /** All tags in the corp with usage stats. */
  tags: CorpTag[];
  /** Shared tags only (cultural vocabulary). */
  sharedVocabulary: CorpTag[];
  /** Pairwise agent overlaps. */
  overlaps: AgentOverlap[];
  /** Tag normalization suggestions. */
  normalizationSuggestions: TagNormalizationSuggestion[];
  /** Overall health assessment. */
  health: CultureHealth;
}

// ── Agent Discovery ─────────────────────────────────────────────────

/**
 * Find all agent directories in a corp by reading members.json.
 * Returns array of { name, dir } for agents that have BRAIN directories.
 */
export function findAllAgentDirs(corpRoot: string): Array<{ name: string; dir: string }> {
  let members: Member[] = [];
  try {
    members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  } catch {
    return [];
  }

  const agents: Array<{ name: string; dir: string }> = [];

  for (const member of members) {
    if (member.type !== 'agent' || !member.agentDir) continue;

    const absoluteDir = join(corpRoot, member.agentDir);
    if (existsSync(absoluteDir)) {
      agents.push({
        name: member.displayName,
        dir: absoluteDir,
      });
    }
  }

  return agents;
}

// ── Tag Aggregation ─────────────────────────────────────────────────

/**
 * Aggregate all tags across all agents in the corp.
 */
export function getCorpTags(corpRoot: string): CorpTag[] {
  const agents = findAllAgentDirs(corpRoot);
  const tagMap = new Map<string, { totalUses: number; agents: Set<string> }>();

  for (const agent of agents) {
    const files = listBrainFiles(agent.dir);
    for (const file of files) {
      for (const tag of file.meta.tags) {
        const lower = tag.toLowerCase();
        const entry = tagMap.get(lower) || { totalUses: 0, agents: new Set<string>() };
        entry.totalUses++;
        entry.agents.add(agent.name);
        tagMap.set(lower, entry);
      }
    }
  }

  return Array.from(tagMap.entries())
    .map(([tag, data]) => ({
      tag,
      totalUses: data.totalUses,
      agentCount: data.agents.size,
      agents: Array.from(data.agents),
      shared: data.agents.size >= 2,
    }))
    .sort((a, b) => b.totalUses - a.totalUses);
}

/**
 * Get only the shared tags (used by 2+ agents) — the cultural vocabulary.
 */
export function getSharedTags(corpRoot: string): CorpTag[] {
  return getCorpTags(corpRoot).filter(t => t.shared);
}

// ── Agent Signatures ────────────────────────────────────────────────

/**
 * Compute an agent's tag signature — their unique vs shared breakdown.
 */
export function getAgentTagSignature(corpRoot: string, agentDir: string): AgentTagSignature {
  const agentName = agentDir.split(/[/\\]/).filter(Boolean).pop() || 'unknown';
  const files = listBrainFiles(agentDir);
  const corpTags = getCorpTags(corpRoot);
  const sharedTagSet = new Set(corpTags.filter(t => t.shared).map(t => t.tag));

  // Collect agent's tags
  const agentTagSet = new Set<string>();
  const tagsByType: Partial<Record<BrainMemoryType, string[]>> = {};

  for (const file of files) {
    for (const tag of file.meta.tags) {
      agentTagSet.add(tag.toLowerCase());
    }
    const existing = tagsByType[file.meta.type] || [];
    existing.push(...file.meta.tags.map(t => t.toLowerCase()));
    tagsByType[file.meta.type] = [...new Set(existing)];
  }

  const allTags = Array.from(agentTagSet);
  const sharedTags = allTags.filter(t => sharedTagSet.has(t));
  const uniqueTags = allTags.filter(t => !sharedTagSet.has(t));

  const alignmentScore = allTags.length > 0
    ? Math.round((sharedTags.length / allTags.length) * 100)
    : 0;

  return {
    agentName,
    agentDir,
    fileCount: files.length,
    allTags,
    sharedTags,
    uniqueTags,
    alignmentScore,
    tagsByType,
  };
}

/**
 * Get signatures for ALL agents in the corp.
 */
export function getAllAgentSignatures(corpRoot: string): AgentTagSignature[] {
  return findAllAgentDirs(corpRoot).map(a => getAgentTagSignature(corpRoot, a.dir));
}

// ── Overlap Analysis ────────────────────────────────────────────────

/**
 * Compute pairwise tag overlap between all agents.
 * Uses Jaccard similarity: |intersection| / |union|.
 */
export function getAgentOverlaps(corpRoot: string): AgentOverlap[] {
  const signatures = getAllAgentSignatures(corpRoot);
  const overlaps: AgentOverlap[] = [];

  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const a = signatures[i]!;
      const b = signatures[j]!;

      const setA = new Set(a.allTags);
      const setB = new Set(b.allTags);

      const intersection = a.allTags.filter(t => setB.has(t));
      const unionSize = new Set([...a.allTags, ...b.allTags]).size;

      const overlapScore = unionSize > 0
        ? Math.round((intersection.length / unionSize) * 100)
        : 0;

      if (intersection.length > 0) {
        overlaps.push({
          agentA: a.agentName,
          agentB: b.agentName,
          sharedTags: intersection,
          overlapScore,
        });
      }
    }
  }

  return overlaps.sort((a, b) => b.overlapScore - a.overlapScore);
}

// ── Tag Normalization ───────────────────────────────────────────────

/**
 * Find potential tag normalization opportunities.
 * Detects near-duplicate tags using simple heuristics:
 * - Plural/singular variants (e.g., "pattern" / "patterns")
 * - Hyphenation variants (e.g., "code-style" / "codestyle" / "code_style")
 * - Substring containment (e.g., "auth" / "authentication")
 */
export function suggestTagNormalization(corpRoot: string): TagNormalizationSuggestion[] {
  const corpTags = getCorpTags(corpRoot);
  const tagNames = corpTags.map(t => t.tag);
  const suggestions: TagNormalizationSuggestion[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < tagNames.length; i++) {
    for (let j = i + 1; j < tagNames.length; j++) {
      const a = tagNames[i]!;
      const b = tagNames[j]!;
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;

      // Plural/singular
      if (a + 's' === b || b + 's' === a) {
        const shorter = a.length < b.length ? a : b;
        suggestions.push({ tags: [a, b], reason: 'plural/singular variant', suggestedCanonical: shorter });
        seen.add(key);
        continue;
      }

      // Hyphenation normalization
      const normalizeA = a.replace(/[-_]/g, '');
      const normalizeB = b.replace(/[-_]/g, '');
      if (normalizeA === normalizeB && a !== b) {
        // Prefer hyphenated version
        const canonical = a.includes('-') ? a : b.includes('-') ? b : a;
        suggestions.push({ tags: [a, b], reason: 'hyphenation variant', suggestedCanonical: canonical });
        seen.add(key);
        continue;
      }

      // Short tag contained in longer tag (only if short tag is 4+ chars)
      if (a.length >= 4 && b.includes(a) && b.length > a.length + 3) {
        suggestions.push({ tags: [a, b], reason: `"${a}" is contained in "${b}"`, suggestedCanonical: a });
        seen.add(key);
      } else if (b.length >= 4 && a.includes(b) && a.length > b.length + 3) {
        suggestions.push({ tags: [b, a], reason: `"${b}" is contained in "${a}"`, suggestedCanonical: b });
        seen.add(key);
      }
    }
  }

  return suggestions;
}

// ── Culture Health ──────────────────────────────────────────────────

/**
 * Assess the overall health of the corp's culture.
 */
export function getCultureHealth(corpRoot: string): CultureHealth {
  const signatures = getAllAgentSignatures(corpRoot);
  const corpTags = getCorpTags(corpRoot);
  const sharedTags = corpTags.filter(t => t.shared);
  const warnings: string[] = [];

  // Edge case: no agents or no BRAIN files
  if (signatures.length === 0 || signatures.every(s => s.fileCount === 0)) {
    return {
      status: 'absent',
      totalUniqueTags: 0,
      sharedTagCount: 0,
      averageAlignment: 0,
      leastAligned: null,
      mostIdiosyncratic: null,
      diversityRatio: 0,
      warnings: ['No BRAIN files found across any agents. Culture hasn\'t started forming yet.'],
    };
  }

  // Active agents (those with BRAIN files)
  const activeSignatures = signatures.filter(s => s.fileCount > 0);

  // Average alignment
  const avgAlignment = activeSignatures.length > 0
    ? Math.round(activeSignatures.reduce((sum, s) => sum + s.alignmentScore, 0) / activeSignatures.length)
    : 0;

  // Least aligned agent
  const leastAligned = activeSignatures.length > 0
    ? activeSignatures.reduce((min, s) => s.alignmentScore < min.alignmentScore ? s : min)
    : null;

  // Most idiosyncratic agent
  const mostIdiosyncratic = activeSignatures.length > 0
    ? activeSignatures.reduce((max, s) => s.uniqueTags.length > max.uniqueTags.length ? s : max)
    : null;

  // Tag diversity: unique tags / total tag uses
  const totalUses = corpTags.reduce((sum, t) => sum + t.totalUses, 0);
  const diversityRatio = totalUses > 0
    ? Math.round((corpTags.length / totalUses) * 100) / 100
    : 0;

  // Warnings
  if (sharedTags.length === 0 && activeSignatures.length >= 2) {
    warnings.push('No shared tags between agents. Agents may not be developing a common vocabulary.');
  }

  if (leastAligned && leastAligned.alignmentScore < 20 && activeSignatures.length >= 2) {
    warnings.push(`${leastAligned.agentName} has very low cultural alignment (${leastAligned.alignmentScore}%). May be drifting from the corp's vocabulary.`);
  }

  if (activeSignatures.length >= 3 && avgAlignment < 30) {
    warnings.push(`Average alignment is ${avgAlignment}% — agents are developing isolated vocabularies. Consider dream-time tag normalization.`);
  }

  // Check if CEO's tags are being inherited
  const ceoSig = activeSignatures.find(s =>
    s.agentName.toLowerCase() === 'ceo' || s.agentDir.includes('/ceo/') || s.agentDir.includes('\\ceo\\'),
  );
  if (ceoSig && activeSignatures.length >= 2) {
    const ceoTagSet = new Set(ceoSig.allTags);
    const nonCeo = activeSignatures.filter(s => s !== ceoSig);
    const ceoTagsAdopted = nonCeo.some(s => s.allTags.some(t => ceoTagSet.has(t)));
    if (!ceoTagsAdopted) {
      warnings.push('No other agents share any of the CEO\'s tags. Culture may not be transmitting from the founding.');
    }
  }

  // Determine status
  let status: CultureHealth['status'];
  if (sharedTags.length >= 5 && avgAlignment >= 40) {
    status = 'thriving';
  } else if (sharedTags.length >= 2 && avgAlignment >= 20) {
    status = 'healthy';
  } else if (activeSignatures.length >= 2 && corpTags.length > 0) {
    status = 'thin';
  } else {
    status = 'absent';
  }

  return {
    status,
    totalUniqueTags: corpTags.length,
    sharedTagCount: sharedTags.length,
    averageAlignment: avgAlignment,
    leastAligned: leastAligned
      ? { name: leastAligned.agentName, score: leastAligned.alignmentScore }
      : null,
    mostIdiosyncratic: mostIdiosyncratic && mostIdiosyncratic.uniqueTags.length > 0
      ? { name: mostIdiosyncratic.agentName, uniqueCount: mostIdiosyncratic.uniqueTags.length }
      : null,
    diversityRatio,
    warnings,
  };
}

// ── Full Analysis ───────────────────────────────────────────────────

/**
 * Run the full cross-agent culture analysis.
 */
export function getCorpCultureStats(corpRoot: string): CorpCultureStats {
  const agents = getAllAgentSignatures(corpRoot);
  const tags = getCorpTags(corpRoot);
  const sharedVocabulary = tags.filter(t => t.shared);
  const overlaps = getAgentOverlaps(corpRoot);
  const normalizationSuggestions = suggestTagNormalization(corpRoot);
  const health = getCultureHealth(corpRoot);

  return {
    agents,
    tags,
    sharedVocabulary,
    overlaps,
    normalizationSuggestions,
    health,
  };
}
