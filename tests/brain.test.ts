import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractWikilinks,
  resolveWikilink,
  findBacklinks,
  createFrontmatter,
  validateFrontmatter,
  createBrainFile,
  readBrainFile,
  updateBrainFile,
  validateBrainFile,
  deleteBrainFile,
  listBrainFiles,
  searchByTag,
  searchByType,
  searchBySource,
  searchByConfidence,
  searchBrain,
  findStaleFiles,
  findOrphans,
  getBrainStats,
  generateMemoryIndex,
  buildBrainGraph,
  getBrainDir,
} from '../packages/shared/src/brain.js';
import type { BrainFrontmatter } from '../packages/shared/src/types/brain.js';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'claude-corp-test-brain');

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

// ── Wikilink Extraction ─────────────────────────────────────────────

describe('extractWikilinks', () => {
  it('extracts a single [[link]]', () => {
    expect(extractWikilinks('See [[auth-system]] for details')).toEqual(['auth-system']);
  });

  it('extracts multiple links', () => {
    const links = extractWikilinks('Uses [[auth-system]] and [[build-commands]] together');
    expect(links).toEqual(['auth-system', 'build-commands']);
  });

  it('deduplicates repeated links', () => {
    const links = extractWikilinks('See [[foo]] then later [[foo]] again');
    expect(links).toEqual(['foo']);
  });

  it('handles pipe syntax [[target|display]]', () => {
    const links = extractWikilinks('The [[founder-style|coding style]] is minimal');
    expect(links).toEqual(['founder-style']);
  });

  it('ignores links inside code blocks', () => {
    const content = 'Normal [[kept]]\n```\n[[ignored-in-code]]\n```\nAlso [[kept-too]]';
    const links = extractWikilinks(content);
    expect(links).toEqual(['kept', 'kept-too']);
    expect(links).not.toContain('ignored-in-code');
  });

  it('ignores links inside inline code', () => {
    const content = 'Use `[[not-a-link]]` but [[real-link]] works';
    const links = extractWikilinks(content);
    expect(links).toEqual(['real-link']);
  });

  it('trims whitespace in link targets', () => {
    expect(extractWikilinks('See [[ spaced-link ]] here')).toEqual(['spaced-link']);
  });

  it('returns empty array when no links', () => {
    expect(extractWikilinks('No links here')).toEqual([]);
  });

  it('ignores empty brackets [[]]', () => {
    expect(extractWikilinks('Empty [[]] brackets')).toEqual([]);
  });

  it('handles mixed code and real links correctly', () => {
    const content = [
      'Start with [[real-1]]',
      '```typescript',
      'const x = "[[fake-in-code]]";',
      '```',
      'Then `[[fake-inline]]` and [[real-2]]',
    ].join('\n');
    const links = extractWikilinks(content);
    expect(links).toEqual(['real-1', 'real-2']);
  });
});

// ── Wikilink Resolution ─────────────────────────────────────────────

describe('resolveWikilink', () => {
  it('returns path when file exists', () => {
    const brainDir = getBrainDir(TEST_DIR);
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(join(brainDir, 'auth-system.md'), '# Auth', 'utf-8');

    const resolved = resolveWikilink('auth-system', TEST_DIR);
    expect(resolved).toBe(join(brainDir, 'auth-system.md'));
  });

  it('returns null when file does not exist', () => {
    expect(resolveWikilink('nonexistent', TEST_DIR)).toBeNull();
  });
});

// ── Backlinks ───────────────────────────────────────────────────────

describe('findBacklinks', () => {
  it('finds files that link to a target', () => {
    createBrainFile(TEST_DIR, 'overview', 'Links to [[auth-system]]', 'technical', ['overview'], 'observation');
    createBrainFile(TEST_DIR, 'auth-system', 'The auth system details', 'technical', ['auth'], 'observation');
    createBrainFile(TEST_DIR, 'unrelated', 'No links here', 'technical', ['other'], 'observation');

    const backlinks = findBacklinks('auth-system', TEST_DIR);
    expect(backlinks).toEqual(['overview']);
    expect(backlinks).not.toContain('unrelated');
  });

  it('returns empty when BRAIN dir missing', () => {
    expect(findBacklinks('anything', TEST_DIR)).toEqual([]);
  });

  it('excludes self-references', () => {
    createBrainFile(TEST_DIR, 'self-ref', 'I link to [[self-ref]]', 'technical', ['meta'], 'observation');
    expect(findBacklinks('self-ref', TEST_DIR)).toEqual([]);
  });
});

// ── Frontmatter Helpers ─────────────────────────────────────────────

describe('createFrontmatter', () => {
  it('creates correct shape with today date', () => {
    const today = new Date().toISOString().slice(0, 10);
    const meta = createFrontmatter('founder-preference', ['style', 'code'], 'founder-direct', 'high');

    expect(meta.type).toBe('founder-preference');
    expect(meta.tags).toEqual(['style', 'code']);
    expect(meta.source).toBe('founder-direct');
    expect(meta.confidence).toBe('high');
    expect(meta.created).toBe(today);
    expect(meta.updated).toBe(today);
    expect(meta.last_validated).toBe(today);
  });

  it('defaults confidence to medium', () => {
    const meta = createFrontmatter('technical', ['build'], 'observation');
    expect(meta.confidence).toBe('medium');
  });
});

describe('validateFrontmatter', () => {
  it('returns empty array for valid frontmatter', () => {
    const meta = createFrontmatter('technical', ['build'], 'observation', 'high');
    expect(validateFrontmatter(meta)).toEqual([]);
  });

  it('catches missing type', () => {
    const errors = validateFrontmatter({ tags: [], source: 'observation', confidence: 'high', created: '2026-01-01', updated: '2026-01-01', last_validated: '2026-01-01' } as Partial<BrainFrontmatter>);
    expect(errors.some(e => e.includes('type'))).toBe(true);
  });

  it('catches invalid type', () => {
    const errors = validateFrontmatter({ type: 'invalid' as any, tags: [], source: 'observation', confidence: 'high', created: '2026-01-01', updated: '2026-01-01', last_validated: '2026-01-01' });
    expect(errors.some(e => e.includes('Invalid type'))).toBe(true);
  });

  it('catches missing tags', () => {
    const errors = validateFrontmatter({ type: 'technical', source: 'observation', confidence: 'high', created: '2026-01-01', updated: '2026-01-01', last_validated: '2026-01-01' } as Partial<BrainFrontmatter>);
    expect(errors.some(e => e.includes('tags'))).toBe(true);
  });

  it('catches non-array tags', () => {
    const errors = validateFrontmatter({ type: 'technical', tags: 'not-array' as any, source: 'observation', confidence: 'high', created: '2026-01-01', updated: '2026-01-01', last_validated: '2026-01-01' });
    expect(errors.some(e => e.includes('array'))).toBe(true);
  });
});

// ── CRUD Operations ─────────────────────────────────────────────────

describe('CRUD', () => {
  it('createBrainFile creates a file with frontmatter and body', () => {
    const file = createBrainFile(TEST_DIR, 'test-memory', 'Some content here', 'technical', ['testing'], 'observation');

    expect(file.name).toBe('test-memory');
    expect(file.meta.type).toBe('technical');
    expect(file.meta.tags).toEqual(['testing']);
    expect(file.body).toBe('Some content here');
    expect(existsSync(file.path)).toBe(true);
  });

  it('createBrainFile extracts wikilinks from body', () => {
    const file = createBrainFile(TEST_DIR, 'linker', 'See [[other-memory]] for details', 'decision', ['refs'], 'observation');
    expect(file.links).toEqual(['other-memory']);
  });

  it('createBrainFile throws if file already exists', () => {
    createBrainFile(TEST_DIR, 'existing', 'First version', 'technical', ['test'], 'observation');
    expect(() => createBrainFile(TEST_DIR, 'existing', 'Duplicate', 'technical', ['test'], 'observation')).toThrow('already exists');
  });

  it('readBrainFile reads and parses correctly', () => {
    createBrainFile(TEST_DIR, 'readable', 'Body text with [[link]]', 'founder-preference', ['style'], 'founder-direct', 'high');

    const file = readBrainFile(TEST_DIR, 'readable');
    expect(file).not.toBeNull();
    expect(file!.meta.type).toBe('founder-preference');
    expect(file!.meta.confidence).toBe('high');
    expect(file!.body).toBe('Body text with [[link]]');
    expect(file!.links).toEqual(['link']);
  });

  it('readBrainFile returns null for nonexistent file', () => {
    expect(readBrainFile(TEST_DIR, 'ghost')).toBeNull();
  });

  it('updateBrainFile updates body and bumps updated date', () => {
    createBrainFile(TEST_DIR, 'updatable', 'Old content', 'technical', ['build'], 'observation');

    const updated = updateBrainFile(TEST_DIR, 'updatable', 'New content');
    expect(updated.body).toBe('New content');
    expect(updated.meta.updated).toBe(new Date().toISOString().slice(0, 10));
  });

  it('updateBrainFile merges meta updates', () => {
    createBrainFile(TEST_DIR, 'meta-update', 'Content', 'technical', ['old-tag'], 'observation', 'low');

    const updated = updateBrainFile(TEST_DIR, 'meta-update', 'Content', {
      tags: ['new-tag', 'another'],
      confidence: 'high',
    });
    expect(updated.meta.tags).toEqual(['new-tag', 'another']);
    expect(updated.meta.confidence).toBe('high');
    expect(updated.meta.type).toBe('technical'); // preserved
  });

  it('updateBrainFile throws for nonexistent file', () => {
    expect(() => updateBrainFile(TEST_DIR, 'ghost', 'content')).toThrow('not found');
  });

  it('validateBrainFile touches last_validated without changing content', () => {
    const original = createBrainFile(TEST_DIR, 'validatable', 'Body', 'technical', ['test'], 'observation');

    // Backdate last_validated
    updateBrainFile(TEST_DIR, 'validatable', 'Body', { last_validated: '2024-01-01' });

    const validated = validateBrainFile(TEST_DIR, 'validatable');
    expect(validated.meta.last_validated).toBe(new Date().toISOString().slice(0, 10));
    expect(validated.body).toBe('Body'); // content unchanged
  });

  it('deleteBrainFile removes existing file', () => {
    createBrainFile(TEST_DIR, 'doomed', 'Goodbye', 'correction', ['mistake'], 'correction');
    expect(deleteBrainFile(TEST_DIR, 'doomed')).toBe(true);
    expect(readBrainFile(TEST_DIR, 'doomed')).toBeNull();
  });

  it('deleteBrainFile returns false for nonexistent file', () => {
    expect(deleteBrainFile(TEST_DIR, 'ghost')).toBe(false);
  });
});

// ── List & Search ───────────────────────────────────────────────────

describe('list and search', () => {
  beforeEach(() => {
    createBrainFile(TEST_DIR, 'founder-style', 'Prefers concise code', 'founder-preference', ['code', 'style'], 'founder-direct', 'high');
    createBrainFile(TEST_DIR, 'build-commands', 'pnpm build && pnpm test', 'technical', ['build', 'devops'], 'observation');
    createBrainFile(TEST_DIR, 'auth-decision', 'Chose JWT over sessions. See [[founder-style]]', 'decision', ['auth', 'architecture'], 'observation');
    createBrainFile(TEST_DIR, 'my-patterns', 'I prefer functional patterns', 'self-knowledge', ['style', 'patterns'], 'dream');
  });

  it('listBrainFiles returns all files', () => {
    const files = listBrainFiles(TEST_DIR);
    expect(files).toHaveLength(4);
  });

  it('listBrainFiles skips _ prefixed files', () => {
    const brainDir = getBrainDir(TEST_DIR);
    writeFileSync(join(brainDir, '_graph.json'), '{}', 'utf-8');
    expect(listBrainFiles(TEST_DIR)).toHaveLength(4); // still 4
  });

  it('searchByTag finds matching files (case-insensitive)', () => {
    const results = searchByTag(TEST_DIR, 'Style');
    expect(results).toHaveLength(2);
    expect(results.map(r => r.name).sort()).toEqual(['founder-style', 'my-patterns']);
  });

  it('searchByType finds matching files', () => {
    const results = searchByType(TEST_DIR, 'decision');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('auth-decision');
  });

  it('searchBySource finds matching files', () => {
    const results = searchBySource(TEST_DIR, 'founder-direct');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('founder-style');
  });

  it('searchByConfidence finds matching files', () => {
    const results = searchByConfidence(TEST_DIR, 'high');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('founder-style');
  });

  it('searchBrain full-text matches filename, tags, and body', () => {
    const byFilename = searchBrain(TEST_DIR, 'auth-decision');
    expect(byFilename).toHaveLength(1);
    expect(byFilename[0]!.matchReason).toContain('filename');

    const byTag = searchBrain(TEST_DIR, 'devops');
    expect(byTag).toHaveLength(1);
    expect(byTag[0]!.matchReason).toContain('tags');

    const byBody = searchBrain(TEST_DIR, 'functional patterns');
    expect(byBody).toHaveLength(1);
    expect(byBody[0]!.matchReason).toContain('body');
  });
});

// ── Staleness & Orphans ─────────────────────────────────────────────

describe('staleness and orphans', () => {
  it('findStaleFiles detects old last_validated', () => {
    createBrainFile(TEST_DIR, 'fresh', 'Recent', 'technical', ['test'], 'observation');
    createBrainFile(TEST_DIR, 'stale', 'Old memory', 'technical', ['test'], 'observation');

    // Backdate the stale file
    updateBrainFile(TEST_DIR, 'stale', 'Old memory', { last_validated: '2024-01-01' });

    const stale = findStaleFiles(TEST_DIR, 30);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.name).toBe('stale');
  });

  it('findOrphans detects files with no inbound links', () => {
    createBrainFile(TEST_DIR, 'linked-to', 'Target', 'technical', ['test'], 'observation');
    createBrainFile(TEST_DIR, 'linker', 'See [[linked-to]]', 'decision', ['test'], 'observation');
    createBrainFile(TEST_DIR, 'orphan', 'Nobody links here', 'technical', ['test'], 'observation');

    const orphans = findOrphans(TEST_DIR);
    const orphanNames = orphans.map(o => o.name);
    expect(orphanNames).toContain('orphan');
    expect(orphanNames).toContain('linker'); // linker links OUT but nothing links TO it
    expect(orphanNames).not.toContain('linked-to'); // linked-to has an inbound link
  });
});

// ── Stats ───────────────────────────────────────────────────────────

describe('getBrainStats', () => {
  beforeEach(() => {
    createBrainFile(TEST_DIR, 'pref-1', 'Preference one', 'founder-preference', ['style', 'code'], 'founder-direct', 'high');
    createBrainFile(TEST_DIR, 'pref-2', 'Preference two', 'founder-preference', ['style', 'ui'], 'founder-direct', 'high');
    createBrainFile(TEST_DIR, 'tech-1', 'Build info. See [[pref-1]]', 'technical', ['build', 'code'], 'observation');
    createBrainFile(TEST_DIR, 'self-1', 'My own patterns', 'self-knowledge', ['patterns'], 'dream');
  });

  it('returns correct file count', () => {
    expect(getBrainStats(TEST_DIR).fileCount).toBe(4);
  });

  it('returns correct type distribution', () => {
    const stats = getBrainStats(TEST_DIR);
    expect(stats.typeCounts['founder-preference']).toBe(2);
    expect(stats.typeCounts['technical']).toBe(1);
    expect(stats.typeCounts['self-knowledge']).toBe(1);
  });

  it('returns tags sorted by frequency', () => {
    const stats = getBrainStats(TEST_DIR);
    // 'style' and 'code' appear in 2 files each
    expect(stats.topTags[0]!.count).toBe(2);
    expect(['style', 'code']).toContain(stats.topTags[0]!.tag);
  });

  it('returns correct total links', () => {
    expect(getBrainStats(TEST_DIR).totalLinks).toBe(1); // only tech-1 links to pref-1
  });
});

// ── MEMORY.md Generation ────────────────────────────────────────────

describe('generateMemoryIndex', () => {
  it('returns empty string for no files', () => {
    expect(generateMemoryIndex(TEST_DIR)).toBe('');
  });

  it('groups by type with [[wikilink]] format', () => {
    createBrainFile(TEST_DIR, 'founder-code', 'Prefers TypeScript', 'founder-preference', ['ts'], 'founder-direct');
    createBrainFile(TEST_DIR, 'build-cmd', 'pnpm build', 'technical', ['build'], 'observation');

    const index = generateMemoryIndex(TEST_DIR);
    expect(index).toContain('## Founder');
    expect(index).toContain('## Technical');
    expect(index).toContain('[[founder-code]]');
    expect(index).toContain('[[build-cmd]]');
  });
});

// ── Link Graph ──────────────────────────────────────────────────────

describe('buildBrainGraph', () => {
  it('builds correct nodes and edges', () => {
    createBrainFile(TEST_DIR, 'a', 'Links to [[b]]', 'technical', ['test'], 'observation');
    createBrainFile(TEST_DIR, 'b', 'Links to [[c]]', 'technical', ['test'], 'observation');
    createBrainFile(TEST_DIR, 'c', 'No outbound links', 'technical', ['test'], 'observation');
    createBrainFile(TEST_DIR, 'isolated', 'Alone', 'technical', ['test'], 'observation');

    const graph = buildBrainGraph(TEST_DIR);
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(2); // a→b, b→c
  });

  it('groups connected nodes into clusters', () => {
    createBrainFile(TEST_DIR, 'a', '[[b]]', 'technical', ['test'], 'observation');
    createBrainFile(TEST_DIR, 'b', '[[a]]', 'technical', ['test'], 'observation');
    createBrainFile(TEST_DIR, 'isolated', 'Alone', 'technical', ['test'], 'observation');

    const graph = buildBrainGraph(TEST_DIR);
    expect(graph.clusters).toHaveLength(2); // {a,b} and {isolated}
    // Largest cluster first
    expect(graph.clusters[0]).toHaveLength(2);
    expect(graph.clusters[1]).toHaveLength(1);
  });

  it('ignores edges to nonexistent files', () => {
    createBrainFile(TEST_DIR, 'a', 'Links to [[ghost]]', 'technical', ['test'], 'observation');

    const graph = buildBrainGraph(TEST_DIR);
    expect(graph.edges).toHaveLength(0); // ghost doesn't exist
  });
});
