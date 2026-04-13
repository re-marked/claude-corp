/**
 * B.R.A.I.N. — Browseable, Reflective, Authored, Indexed Notes
 *
 * Claude Corp's authored memory framework. File-based, git-tracked,
 * human-readable. Uses YAML frontmatter for typed, tagged, time-aware
 * knowledge with [[wikilinks]] for cross-referencing.
 *
 * This module provides CRUD operations, wikilink parsing, tag search,
 * staleness detection, and stats — the building blocks for cc-cli brain
 * commands, dream consolidation, and the BRAIN system prompt fragment.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { parse as parseFrontmatter, stringify as stringifyFrontmatter } from './parsers/frontmatter.js';
import type {
  BrainFrontmatter,
  BrainMemoryType,
  BrainSource,
  BrainConfidence,
  BrainFile,
  BrainStats,
  BrainSearchResult,
} from './types/brain.js';

// ── Constants ───────────────────────────────────────────────────────

/** Directory name for BRAIN files within an agent workspace. */
export const BRAIN_DIR = 'BRAIN';

/** How many days before a memory is considered stale. */
export const STALENESS_THRESHOLD_DAYS = 30;

/** Maximum recommended lines per BRAIN file. */
export const MAX_BRAIN_FILE_LINES = 200;

/** Valid memory types for validation. */
export const VALID_TYPES: BrainMemoryType[] = [
  'founder-preference', 'technical', 'decision',
  'self-knowledge', 'correction', 'relationship',
];

/** Valid source types for validation. */
export const VALID_SOURCES: BrainSource[] = [
  'founder-direct', 'observation', 'dream',
  'correction', 'agent-secondhand',
];

/** Valid confidence levels for validation. */
export const VALID_CONFIDENCE: BrainConfidence[] = ['high', 'medium', 'low'];

// ── Path Helpers ────────────────────────────────────────────────────

/** Get the BRAIN directory path for an agent. */
export function getBrainDir(agentDir: string): string {
  return join(agentDir, BRAIN_DIR);
}

/** Get the full path for a BRAIN file by name (without extension). */
export function getBrainFilePath(agentDir: string, name: string): string {
  const cleanName = name.replace(/\.md$/, '');
  return join(getBrainDir(agentDir), `${cleanName}.md`);
}

/** Ensure the BRAIN directory exists. */
export function ensureBrainDir(agentDir: string): void {
  const dir = getBrainDir(agentDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Wikilink Parser ─────────────────────────────────────────────────

/**
 * Extract all [[wikilinks]] from markdown content.
 * Handles edge cases: ignores links inside code blocks and inline code.
 */
export function extractWikilinks(content: string): string[] {
  // Remove code blocks first (```...```)
  const withoutCodeBlocks = content.replace(/```[\s\S]*?```/g, '');
  // Remove inline code (`...`)
  const withoutInlineCode = withoutCodeBlocks.replace(/`[^`]+`/g, '');

  const links: string[] = [];
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(withoutInlineCode)) !== null) {
    const linkTarget = match[1].trim();
    if (linkTarget && !links.includes(linkTarget)) {
      links.push(linkTarget);
    }
  }

  return links;
}

/**
 * Resolve a wikilink name to a BRAIN file path.
 * Returns null if the file doesn't exist.
 */
export function resolveWikilink(name: string, agentDir: string): string | null {
  const path = getBrainFilePath(agentDir, name);
  return existsSync(path) ? path : null;
}

/**
 * Find all BRAIN files that contain a [[wikilink]] to the given target.
 * Returns an array of file names (without extension) that link TO this target.
 */
export function findBacklinks(targetName: string, agentDir: string): string[] {
  const brainDir = getBrainDir(agentDir);
  if (!existsSync(brainDir)) return [];

  const backlinks: string[] = [];
  const files = readdirSync(brainDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));

  for (const file of files) {
    const fileName = basename(file, '.md');
    if (fileName === targetName) continue; // skip self

    const content = readFileSync(join(brainDir, file), 'utf-8');
    const links = extractWikilinks(content);
    if (links.includes(targetName)) {
      backlinks.push(fileName);
    }
  }

  return backlinks;
}

// ── Frontmatter Helpers ─────────────────────────────────────────────

/** Get today's date as YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Create default frontmatter for a new BRAIN file. */
export function createFrontmatter(
  type: BrainMemoryType,
  tags: string[],
  source: BrainSource,
  confidence: BrainConfidence = 'medium',
): BrainFrontmatter {
  const now = today();
  return {
    type,
    tags,
    source,
    created: now,
    updated: now,
    last_validated: now,
    confidence,
  };
}

/**
 * Validate frontmatter fields. Returns an array of error strings.
 * Empty array = valid.
 */
export function validateFrontmatter(meta: Partial<BrainFrontmatter>): string[] {
  const errors: string[] = [];

  if (!meta.type) errors.push('Missing required field: type');
  else if (!VALID_TYPES.includes(meta.type)) errors.push(`Invalid type: ${meta.type}. Valid: ${VALID_TYPES.join(', ')}`);

  if (!meta.tags) errors.push('Missing required field: tags');
  else if (!Array.isArray(meta.tags)) errors.push('tags must be an array');

  if (!meta.source) errors.push('Missing required field: source');
  else if (!VALID_SOURCES.includes(meta.source)) errors.push(`Invalid source: ${meta.source}. Valid: ${VALID_SOURCES.join(', ')}`);

  if (!meta.confidence) errors.push('Missing required field: confidence');
  else if (!VALID_CONFIDENCE.includes(meta.confidence)) errors.push(`Invalid confidence: ${meta.confidence}. Valid: ${VALID_CONFIDENCE.join(', ')}`);

  if (!meta.created) errors.push('Missing required field: created');
  if (!meta.updated) errors.push('Missing required field: updated');
  if (!meta.last_validated) errors.push('Missing required field: last_validated');

  return errors;
}

// ── CRUD Operations ─────────────────────────────────────────────────

/**
 * Create a new BRAIN file with proper frontmatter.
 * Throws if the file already exists (use updateBrainFile for updates).
 */
export function createBrainFile(
  agentDir: string,
  name: string,
  body: string,
  type: BrainMemoryType,
  tags: string[],
  source: BrainSource,
  confidence: BrainConfidence = 'medium',
): BrainFile {
  ensureBrainDir(agentDir);
  const filePath = getBrainFilePath(agentDir, name);

  if (existsSync(filePath)) {
    throw new Error(`BRAIN file already exists: ${name}. Use updateBrainFile() to modify.`);
  }

  const meta = createFrontmatter(type, tags, source, confidence);
  const content = stringifyFrontmatter(meta as unknown as Record<string, unknown>, body);
  writeFileSync(filePath, content, 'utf-8');

  return {
    name,
    path: filePath,
    meta,
    body,
    links: extractWikilinks(body),
  };
}

/**
 * Read and parse a BRAIN file. Returns null if it doesn't exist.
 */
export function readBrainFile(agentDir: string, name: string): BrainFile | null {
  const filePath = getBrainFilePath(agentDir, name);
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter<BrainFrontmatter>(raw);

  return {
    name,
    path: filePath,
    meta,
    body,
    links: extractWikilinks(body),
  };
}

/**
 * Update an existing BRAIN file's content and/or frontmatter.
 * Bumps the `updated` timestamp automatically.
 * Throws if the file doesn't exist (use createBrainFile for new files).
 */
export function updateBrainFile(
  agentDir: string,
  name: string,
  body: string,
  metaUpdates?: Partial<BrainFrontmatter>,
): BrainFile {
  const existing = readBrainFile(agentDir, name);
  if (!existing) {
    throw new Error(`BRAIN file not found: ${name}. Use createBrainFile() to create.`);
  }

  const updatedMeta: BrainFrontmatter = {
    ...existing.meta,
    ...metaUpdates,
    updated: today(),
  };

  const filePath = getBrainFilePath(agentDir, name);
  const content = stringifyFrontmatter(updatedMeta as unknown as Record<string, unknown>, body);
  writeFileSync(filePath, content, 'utf-8');

  return {
    name,
    path: filePath,
    meta: updatedMeta,
    body,
    links: extractWikilinks(body),
  };
}

/**
 * Touch `last_validated` without changing content.
 * Use when re-encountering a fact and confirming it's still true.
 */
export function validateBrainFile(agentDir: string, name: string): BrainFile {
  const existing = readBrainFile(agentDir, name);
  if (!existing) {
    throw new Error(`BRAIN file not found: ${name}`);
  }

  const updatedMeta: BrainFrontmatter = {
    ...existing.meta,
    last_validated: today(),
  };

  const filePath = getBrainFilePath(agentDir, name);
  const content = stringifyFrontmatter(updatedMeta as unknown as Record<string, unknown>, existing.body);
  writeFileSync(filePath, content, 'utf-8');

  return {
    ...existing,
    meta: updatedMeta,
  };
}

/**
 * Delete a BRAIN file. Use for pruning contradicted or stale memories.
 * Returns true if the file existed and was deleted.
 */
export function deleteBrainFile(agentDir: string, name: string): boolean {
  const filePath = getBrainFilePath(agentDir, name);
  if (!existsSync(filePath)) return false;

  const { unlinkSync } = require('node:fs');
  unlinkSync(filePath);
  return true;
}

// ── List & Search ───────────────────────────────────────────────────

/**
 * List all BRAIN files for an agent, fully parsed.
 * Skips files starting with _ (metadata files like _graph.json).
 */
export function listBrainFiles(agentDir: string): BrainFile[] {
  const brainDir = getBrainDir(agentDir);
  if (!existsSync(brainDir)) return [];

  return readdirSync(brainDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .map(f => {
      const name = basename(f, '.md');
      return readBrainFile(agentDir, name);
    })
    .filter((f): f is BrainFile => f !== null);
}

/**
 * Search BRAIN files by tag. Returns all files that have the given tag.
 */
export function searchByTag(agentDir: string, tag: string): BrainFile[] {
  return listBrainFiles(agentDir).filter(f =>
    f.meta.tags.some(t => t.toLowerCase() === tag.toLowerCase()),
  );
}

/**
 * Search BRAIN files by memory type.
 */
export function searchByType(agentDir: string, type: BrainMemoryType): BrainFile[] {
  return listBrainFiles(agentDir).filter(f => f.meta.type === type);
}

/**
 * Search BRAIN files by source.
 */
export function searchBySource(agentDir: string, source: BrainSource): BrainFile[] {
  return listBrainFiles(agentDir).filter(f => f.meta.source === source);
}

/**
 * Search BRAIN files by confidence level.
 */
export function searchByConfidence(agentDir: string, confidence: BrainConfidence): BrainFile[] {
  return listBrainFiles(agentDir).filter(f => f.meta.confidence === confidence);
}

/**
 * Full-text search across BRAIN file bodies and tags.
 * Returns files where the query appears in the body, tags, or filename.
 */
export function searchBrain(agentDir: string, query: string): BrainSearchResult[] {
  const lowerQuery = query.toLowerCase();
  const results: BrainSearchResult[] = [];

  for (const file of listBrainFiles(agentDir)) {
    const reasons: string[] = [];

    // Check filename
    if (file.name.toLowerCase().includes(lowerQuery)) {
      reasons.push('filename');
    }

    // Check tags
    const matchingTags = file.meta.tags.filter(t => t.toLowerCase().includes(lowerQuery));
    if (matchingTags.length > 0) {
      reasons.push(`tags: ${matchingTags.join(', ')}`);
    }

    // Check body content
    if (file.body.toLowerCase().includes(lowerQuery)) {
      reasons.push('body content');
    }

    if (reasons.length > 0) {
      results.push({ file, matchReason: reasons.join('; ') });
    }
  }

  return results;
}

// ── Staleness Detection ─────────────────────────────────────────────

/**
 * Find BRAIN files that haven't been validated within the threshold.
 */
export function findStaleFiles(agentDir: string, thresholdDays: number = STALENESS_THRESHOLD_DAYS): BrainFile[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - thresholdDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return listBrainFiles(agentDir).filter(f => f.meta.last_validated < cutoffStr);
}

/**
 * Find BRAIN files with no inbound wikilinks (orphans).
 * Orphans are memories that nothing else references — candidates for pruning.
 */
export function findOrphans(agentDir: string): BrainFile[] {
  const allFiles = listBrainFiles(agentDir);
  const allLinkedNames = new Set<string>();

  // Collect all outbound wikilink targets
  for (const file of allFiles) {
    for (const link of file.links) {
      allLinkedNames.add(link);
    }
  }

  // Files that nobody links to
  return allFiles.filter(f => !allLinkedNames.has(f.name));
}

// ── Stats ───────────────────────────────────────────────────────────

/**
 * Generate comprehensive stats for an agent's BRAIN.
 */
export function getBrainStats(agentDir: string): BrainStats {
  const allFiles = listBrainFiles(agentDir);

  // Count by type
  const typeCounts: Partial<Record<BrainMemoryType, number>> = {};
  for (const file of allFiles) {
    typeCounts[file.meta.type] = (typeCounts[file.meta.type] || 0) + 1;
  }

  // Count tags
  const tagCounts = new Map<string, number>();
  for (const file of allFiles) {
    for (const tag of file.meta.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  // Find stale files
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - STALENESS_THRESHOLD_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const staleFiles = allFiles
    .filter(f => f.meta.last_validated < cutoffStr)
    .map(f => {
      const validated = new Date(f.meta.last_validated);
      const daysSince = Math.floor((Date.now() - validated.getTime()) / (1000 * 60 * 60 * 24));
      return { name: f.name, lastValidated: f.meta.last_validated, daysSinceValidation: daysSince };
    });

  // Find orphans
  const allLinkedNames = new Set<string>();
  for (const file of allFiles) {
    for (const link of file.links) {
      allLinkedNames.add(link);
    }
  }
  const orphanFiles = allFiles
    .filter(f => !allLinkedNames.has(f.name))
    .map(f => f.name);

  // Total links
  const totalLinks = allFiles.reduce((sum, f) => sum + f.links.length, 0);

  return {
    fileCount: allFiles.length,
    typeCounts,
    topTags,
    staleFiles,
    orphanFiles,
    totalLinks,
  };
}

// ── MEMORY.md Generation ────────────────────────────────────────────

/**
 * Generate a MEMORY.md index from all BRAIN files.
 * Uses [[wikilink]] format, grouped by type.
 */
export function generateMemoryIndex(agentDir: string): string {
  const files = listBrainFiles(agentDir);
  if (files.length === 0) return '';

  // Group by type
  const byType = new Map<BrainMemoryType, BrainFile[]>();
  for (const file of files) {
    const existing = byType.get(file.meta.type) || [];
    existing.push(file);
    byType.set(file.meta.type, existing);
  }

  // Render grouped index
  const typeLabels: Record<BrainMemoryType, string> = {
    'founder-preference': 'Founder',
    'technical': 'Technical',
    'decision': 'Decisions',
    'self-knowledge': 'Self',
    'correction': 'Corrections',
    'relationship': 'Relationships',
  };

  const sections: string[] = [];
  for (const [type, label] of Object.entries(typeLabels)) {
    const typeFiles = byType.get(type as BrainMemoryType);
    if (!typeFiles?.length) continue;

    sections.push(`## ${label}`);
    for (const file of typeFiles) {
      // First line of body as description, or first tag
      const desc = file.body.split('\n')[0]?.slice(0, 80) || file.meta.tags[0] || '';
      sections.push(`- [[${file.name}]] — ${desc}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

// ── Link Graph ──────────────────────────────────────────────────────

/** Edge in the BRAIN link graph. */
export interface BrainGraphEdge {
  from: string;
  to: string;
}

/** Full link graph of an agent's BRAIN. */
export interface BrainGraph {
  nodes: string[];
  edges: BrainGraphEdge[];
  /** Files grouped by connected component (clusters of related memories). */
  clusters: string[][];
}

/**
 * Build the full wikilink graph from an agent's BRAIN.
 * Identifies clusters of connected memories.
 */
export function buildBrainGraph(agentDir: string): BrainGraph {
  const files = listBrainFiles(agentDir);
  const nodes = files.map(f => f.name);
  const nodeSet = new Set(nodes);
  const edges: BrainGraphEdge[] = [];

  // Collect edges (only to existing files)
  for (const file of files) {
    for (const link of file.links) {
      if (nodeSet.has(link) && link !== file.name) {
        edges.push({ from: file.name, to: link });
      }
    }
  }

  // Find clusters via union-find
  const parent = new Map<string, string>();
  for (const node of nodes) parent.set(node, node);

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Build undirected connections for clustering
  for (const edge of edges) {
    union(edge.from, edge.to);
  }

  // Group into clusters
  const clusterMap = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(node);
    const cluster = clusterMap.get(root) || [];
    cluster.push(node);
    clusterMap.set(root, cluster);
  }

  const clusters = Array.from(clusterMap.values()).sort((a, b) => b.length - a.length);

  return { nodes, edges, clusters };
}
