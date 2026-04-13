import { describe, it, expect, beforeEach } from 'vitest';
import {
  createBrainFile,
  getBrainDir,
} from '../packages/shared/src/brain.js';
import {
  getCorpTags,
  getSharedTags,
  getAgentTagSignature,
  getAllAgentSignatures,
  getAgentOverlaps,
  suggestTagNormalization,
  getCultureHealth,
  getCorpCultureStats,
} from '../packages/shared/src/brain-culture.js';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CORP_ROOT = join(tmpdir(), 'claude-corp-test-culture');

function setupCorp(agents: Array<{ name: string; files: Array<{ name: string; tags: string[]; type?: string }> }>) {
  if (existsSync(CORP_ROOT)) rmSync(CORP_ROOT, { recursive: true });
  mkdirSync(CORP_ROOT, { recursive: true });

  // Create members.json
  const members = [
    { id: 'founder', displayName: 'Mark', rank: 'owner', status: 'active', type: 'user', scope: 'corp', scopeId: 'test', agentDir: null, port: null, spawnedBy: null, createdAt: '2026-01-01' },
  ];

  for (const agent of agents) {
    const agentDir = `agents/${agent.name}/`;
    members.push({
      id: `agent-${agent.name}`,
      displayName: agent.name,
      rank: 'worker' as any,
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: 'test',
      agentDir,
      port: null,
      spawnedBy: 'founder',
      createdAt: '2026-01-01',
    });

    const absDir = join(CORP_ROOT, agentDir);
    mkdirSync(join(absDir, 'BRAIN'), { recursive: true });

    for (const file of agent.files) {
      createBrainFile(absDir, file.name, `Content for ${file.name}`,
        (file.type || 'technical') as any, file.tags, 'observation');
    }
  }

  writeFileSync(join(CORP_ROOT, 'members.json'), JSON.stringify(members, null, 2), 'utf-8');
}

beforeEach(() => {
  if (existsSync(CORP_ROOT)) rmSync(CORP_ROOT, { recursive: true });
});

// ── Tag Aggregation ─────────────────────────────────────────────────

describe('getCorpTags', () => {
  it('aggregates tags across all agents', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'style', tags: ['code', 'typescript'] }] },
      { name: 'worker', files: [{ name: 'build', tags: ['code', 'devops'] }] },
    ]);

    const tags = getCorpTags(CORP_ROOT);
    const codeTag = tags.find(t => t.tag === 'code');
    expect(codeTag).toBeDefined();
    expect(codeTag!.agentCount).toBe(2);
    expect(codeTag!.totalUses).toBe(2);
    expect(codeTag!.shared).toBe(true);
  });

  it('identifies unique tags', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'style', tags: ['code'] }] },
      { name: 'worker', files: [{ name: 'build', tags: ['devops'] }] },
    ]);

    const tags = getCorpTags(CORP_ROOT);
    const devops = tags.find(t => t.tag === 'devops');
    expect(devops!.shared).toBe(false);
    expect(devops!.agentCount).toBe(1);
  });
});

describe('getSharedTags', () => {
  it('returns only tags used by 2+ agents', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'a', tags: ['shared', 'ceo-only'] }] },
      { name: 'worker', files: [{ name: 'b', tags: ['shared', 'worker-only'] }] },
    ]);

    const shared = getSharedTags(CORP_ROOT);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.tag).toBe('shared');
  });
});

// ── Agent Signatures ────────────────────────────────────────────────

describe('getAgentTagSignature', () => {
  it('computes unique vs shared breakdown', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'a', tags: ['shared', 'ceo-special'] }] },
      { name: 'worker', files: [{ name: 'b', tags: ['shared', 'worker-special'] }] },
    ]);

    const sig = getAgentTagSignature(CORP_ROOT, join(CORP_ROOT, 'agents/ceo/'));
    expect(sig.sharedTags).toContain('shared');
    expect(sig.uniqueTags).toContain('ceo-special');
    expect(sig.alignmentScore).toBe(50); // 1 shared out of 2 total
  });
});

describe('getAllAgentSignatures', () => {
  it('returns signatures for all agents', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'a', tags: ['x'] }] },
      { name: 'worker', files: [{ name: 'b', tags: ['y'] }] },
      { name: 'intern', files: [{ name: 'c', tags: ['z'] }] },
    ]);

    const sigs = getAllAgentSignatures(CORP_ROOT);
    expect(sigs).toHaveLength(3);
  });
});

// ── Overlap Analysis ────────────────────────────────────────────────

describe('getAgentOverlaps', () => {
  it('computes Jaccard similarity between agents', () => {
    setupCorp([
      { name: 'ceo', files: [
        { name: 'a', tags: ['code', 'style', 'arch'] },
      ]},
      { name: 'worker', files: [
        { name: 'b', tags: ['code', 'style', 'testing'] },
      ]},
    ]);

    const overlaps = getAgentOverlaps(CORP_ROOT);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.sharedTags).toContain('code');
    expect(overlaps[0]!.sharedTags).toContain('style');
    // Jaccard: 2 shared / 4 union = 50%
    expect(overlaps[0]!.overlapScore).toBe(50);
  });

  it('returns empty when no overlap', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'a', tags: ['x'] }] },
      { name: 'worker', files: [{ name: 'b', tags: ['y'] }] },
    ]);

    const overlaps = getAgentOverlaps(CORP_ROOT);
    expect(overlaps).toHaveLength(0);
  });
});

// ── Tag Normalization ───────────────────────────────────────────────

describe('suggestTagNormalization', () => {
  it('detects plural/singular variants', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'a', tags: ['pattern'] }] },
      { name: 'worker', files: [{ name: 'b', tags: ['patterns'] }] },
    ]);

    const suggestions = suggestTagNormalization(CORP_ROOT);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.reason).toContain('plural');
  });

  it('detects hyphenation variants', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'a', tags: ['code-style'] }] },
      { name: 'worker', files: [{ name: 'b', tags: ['codestyle'] }] },
    ]);

    const suggestions = suggestTagNormalization(CORP_ROOT);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.reason).toContain('hyphenation');
  });

  it('returns empty when tags are clean', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'a', tags: ['code', 'auth'] }] },
      { name: 'worker', files: [{ name: 'b', tags: ['testing', 'devops'] }] },
    ]);

    const suggestions = suggestTagNormalization(CORP_ROOT);
    expect(suggestions).toHaveLength(0);
  });
});

// ── Culture Health ──────────────────────────────────────────────────

describe('getCultureHealth', () => {
  it('returns absent when no BRAIN files', () => {
    setupCorp([
      { name: 'ceo', files: [] },
      { name: 'worker', files: [] },
    ]);

    const health = getCultureHealth(CORP_ROOT);
    expect(health.status).toBe('absent');
  });

  it('returns thin when agents have isolated vocabularies', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'a', tags: ['x', 'y'] }] },
      { name: 'worker', files: [{ name: 'b', tags: ['z', 'w'] }] },
    ]);

    const health = getCultureHealth(CORP_ROOT);
    expect(health.status).toBe('thin');
    expect(health.sharedTagCount).toBe(0);
  });

  it('returns healthy when some tags are shared', () => {
    setupCorp([
      { name: 'ceo', files: [
        { name: 'a', tags: ['code', 'style'] },
        { name: 'b', tags: ['arch', 'code'] },
      ]},
      { name: 'worker', files: [
        { name: 'c', tags: ['code', 'style'] },
        { name: 'd', tags: ['testing'] },
      ]},
    ]);

    const health = getCultureHealth(CORP_ROOT);
    expect(['healthy', 'thriving']).toContain(health.status);
    expect(health.sharedTagCount).toBeGreaterThanOrEqual(2);
    expect(health.averageAlignment).toBeGreaterThan(0);
  });

  it('warns when CEO tags are not inherited', () => {
    setupCorp([
      { name: 'ceo', files: [{ name: 'a', tags: ['leadership', 'vision'] }] },
      { name: 'worker', files: [{ name: 'b', tags: ['testing', 'bugs'] }] },
    ]);

    const health = getCultureHealth(CORP_ROOT);
    expect(health.warnings.some(w => w.includes('CEO'))).toBe(true);
  });
});

// ── Full Analysis ───────────────────────────────────────────────────

describe('getCorpCultureStats', () => {
  it('returns comprehensive analysis', () => {
    setupCorp([
      { name: 'ceo', files: [
        { name: 'style', tags: ['code', 'typescript', 'quality'], type: 'founder-preference' },
        { name: 'arch', tags: ['architecture', 'streaming'], type: 'decision' },
      ]},
      { name: 'worker-1', files: [
        { name: 'build', tags: ['code', 'devops'], type: 'technical' },
        { name: 'patterns', tags: ['typescript', 'patterns'], type: 'self-knowledge' },
      ]},
      { name: 'worker-2', files: [
        { name: 'testing', tags: ['code', 'testing'], type: 'technical' },
      ]},
    ]);

    const stats = getCorpCultureStats(CORP_ROOT);

    // Agents
    expect(stats.agents).toHaveLength(3);

    // Tags
    expect(stats.tags.length).toBeGreaterThan(0);
    const codeTag = stats.tags.find(t => t.tag === 'code');
    expect(codeTag!.agentCount).toBe(3); // all three use 'code'

    // Shared vocabulary
    expect(stats.sharedVocabulary.length).toBeGreaterThanOrEqual(2); // code, typescript at minimum

    // Overlaps
    expect(stats.overlaps.length).toBeGreaterThan(0);

    // Health
    expect(stats.health.status).not.toBe('absent');
  });
});
