import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getCultureCandidates,
  readCulture,
  writeCulture,
  getCulturePath,
  CULTURE_MD_FILENAME,
} from '../packages/shared/src/culture.js';
import { createBrainFile, getBrainFilePath } from '../packages/shared/src/brain.js';
import type { BrainMemoryType, BrainSource } from '../packages/shared/src/types/brain.js';
import { parse as parseFrontmatter, stringify as stringifyFrontmatter } from '../packages/shared/src/parsers/frontmatter.js';

let CORP_ROOT = join(tmpdir(), 'claude-corp-test-culture-synthesis');

interface SeedFile {
  name: string;
  tags: string[];
  type?: BrainMemoryType;
  source?: BrainSource;
  timesHeard?: number;
}

function seedCorp(agents: Array<{ name: string; files: SeedFile[] }>) {
  if (existsSync(CORP_ROOT)) rmSync(CORP_ROOT, { recursive: true });
  mkdirSync(CORP_ROOT, { recursive: true });

  const members: Array<Record<string, unknown>> = [
    {
      id: 'founder', displayName: 'Mark', rank: 'owner', status: 'active',
      type: 'user', scope: 'corp', scopeId: 'test', agentDir: null,
      port: null, spawnedBy: null, createdAt: '2026-01-01',
    },
  ];

  for (const agent of agents) {
    const agentDir = `agents/${agent.name}/`;
    members.push({
      id: `agent-${agent.name}`,
      displayName: agent.name,
      rank: 'worker',
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
      const source = file.source ?? 'correction';
      const type = file.type ?? 'correction';
      createBrainFile(absDir, file.name, `Body for ${file.name}`, type, file.tags, source, 'medium');

      // Inject times_heard if specified — edit frontmatter in-place.
      // Clone meta before mutating: gray-matter may return a cached
      // reference that subsequent parses would also see mutated.
      if (file.timesHeard && file.timesHeard > 1) {
        const p = getBrainFilePath(absDir, file.name);
        const raw = readFileSync(p, 'utf-8');
        const { meta, body } = parseFrontmatter<Record<string, unknown>>(raw);
        const newMeta = { ...meta, times_heard: file.timesHeard };
        writeFileSync(p, stringifyFrontmatter(newMeta, body), 'utf-8');
      }
    }
  }

  writeFileSync(join(CORP_ROOT, 'members.json'), JSON.stringify(members, null, 2), 'utf-8');
}

let testCounter = 0;
beforeEach(() => {
  // Unique per-test path — Windows rmSync is flaky on recursive dirs with
  // recently-written files. Avoid any state leak by isolating each test.
  CORP_ROOT = join(tmpdir(), `claude-corp-test-culture-synthesis-${process.pid}-${++testCounter}`);
  if (existsSync(CORP_ROOT)) rmSync(CORP_ROOT, { recursive: true, force: true });
});

describe('culture: IO', () => {
  it('readCulture returns null when file missing', () => {
    mkdirSync(CORP_ROOT, { recursive: true });
    expect(readCulture(CORP_ROOT)).toBeNull();
  });

  it('readCulture returns null when file is empty', () => {
    mkdirSync(CORP_ROOT, { recursive: true });
    writeFileSync(getCulturePath(CORP_ROOT), '   \n  \n', 'utf-8');
    expect(readCulture(CORP_ROOT)).toBeNull();
  });

  it('writeCulture + readCulture round-trip', () => {
    mkdirSync(CORP_ROOT, { recursive: true });
    const content = '# Corp Culture\n\n## no summaries\n\nMark reads the diff.';
    writeCulture(CORP_ROOT, content);
    expect(readCulture(CORP_ROOT)).toBe(content);
  });

  it('getCulturePath uses CULTURE.md at corp root', () => {
    const p = getCulturePath('/tmp/some-corp');
    expect(p.endsWith(CULTURE_MD_FILENAME)).toBe(true);
  });
});

describe('culture: candidates', () => {
  it('returns empty when no agents exist', () => {
    mkdirSync(CORP_ROOT, { recursive: true });
    writeFileSync(join(CORP_ROOT, 'members.json'), JSON.stringify([]), 'utf-8');
    expect(getCultureCandidates(CORP_ROOT)).toEqual([]);
  });

  it('returns empty when agents have no feedback-sourced BRAIN entries', () => {
    seedCorp([
      { name: 'alice', files: [{ name: 'auth', tags: ['auth', 'jwt'], type: 'technical', source: 'observation' }] },
    ]);
    expect(getCultureCandidates(CORP_ROOT)).toEqual([]);
  });

  it('ignores correction-type entries with non-feedback source', () => {
    // type is correction but source is dream — not from founder
    seedCorp([
      { name: 'alice', files: [{ name: 'mistake', tags: ['style', 'verbose'], type: 'correction', source: 'dream', timesHeard: 5 }] },
    ]);
    expect(getCultureCandidates(CORP_ROOT)).toEqual([]);
  });

  it('returns weak clusters filtered out (single agent, times_heard=1)', () => {
    seedCorp([
      { name: 'alice', files: [{ name: 'short', tags: ['style', 'verbose'], type: 'correction', source: 'correction' }] },
    ]);
    expect(getCultureCandidates(CORP_ROOT)).toEqual([]);
  });

  it('promotes to moderate when times_heard >= 2 for one agent', () => {
    seedCorp([
      { name: 'alice', files: [{ name: 'short', tags: ['style', 'verbose'], type: 'correction', source: 'correction', timesHeard: 2 }] },
    ]);
    const candidates = getCultureCandidates(CORP_ROOT);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.strength).toBe('moderate');
    expect(candidates[0]!.maxTimesHeard).toBe(2);
  });

  it('promotes to moderate when 2 agents share the theme', () => {
    seedCorp([
      { name: 'alice', files: [{ name: 'short', tags: ['style', 'verbose'], type: 'correction', source: 'correction' }] },
      { name: 'bob',   files: [{ name: 'brief', tags: ['style', 'verbose'], type: 'correction', source: 'correction' }] },
    ]);
    const candidates = getCultureCandidates(CORP_ROOT);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.strength).toBe('moderate');
    expect(candidates[0]!.agents.sort()).toEqual(['alice', 'bob']);
    expect(candidates[0]!.entries).toHaveLength(2);
  });

  it('promotes to strong when 3+ agents share the theme', () => {
    seedCorp([
      { name: 'alice',   files: [{ name: 'a', tags: ['style', 'verbose'], type: 'correction', source: 'correction' }] },
      { name: 'bob',     files: [{ name: 'b', tags: ['style', 'verbose'], type: 'correction', source: 'correction' }] },
      { name: 'charlie', files: [{ name: 'c', tags: ['style', 'verbose'], type: 'correction', source: 'correction' }] },
    ]);
    const candidates = getCultureCandidates(CORP_ROOT);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.strength).toBe('strong');
    expect(candidates[0]!.agents.length).toBe(3);
  });

  it('promotes to strong when times_heard >= 3 even for one agent', () => {
    seedCorp([
      { name: 'alice', files: [{ name: 'a', tags: ['style', 'verbose'], type: 'correction', source: 'correction', timesHeard: 3 }] },
    ]);
    const candidates = getCultureCandidates(CORP_ROOT);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.strength).toBe('strong');
  });

  it('does NOT cluster entries sharing only one tag', () => {
    seedCorp([
      { name: 'alice', files: [{ name: 'a', tags: ['style', 'verbose'], type: 'correction', source: 'correction' }] },
      { name: 'bob',   files: [{ name: 'b', tags: ['style', 'concise'], type: 'correction', source: 'correction' }] },
    ]);
    // Only one tag ('style') shared — below the 2-tag threshold, so no cluster.
    // Both entries are weak (1 agent, 1 time) → filtered out.
    expect(getCultureCandidates(CORP_ROOT)).toEqual([]);
  });

  it('sorts strong clusters before moderate', () => {
    seedCorp([
      // Moderate: 2 agents on 'style'+'testing'
      { name: 'alice', files: [{ name: 'a', tags: ['style', 'testing'], source: 'correction' }] },
      { name: 'bob',   files: [{ name: 'b', tags: ['style', 'testing'], source: 'correction' }] },
      // Strong: 3 agents on 'commits'+'granular'
      { name: 'cato',  files: [{ name: 'c1', tags: ['commits', 'granular'], source: 'correction' }] },
      { name: 'dora',  files: [{ name: 'd1', tags: ['commits', 'granular'], source: 'correction' }] },
      { name: 'eve',   files: [{ name: 'e1', tags: ['commits', 'granular'], source: 'correction' }] },
    ]);
    const candidates = getCultureCandidates(CORP_ROOT);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.strength).toBe('strong');
    expect(candidates[1]!.strength).toBe('moderate');
  });

  it('accepts confirmation-sourced entries, not just corrections', () => {
    seedCorp([
      { name: 'alice', files: [{ name: 'like', tags: ['style', 'prefer'], type: 'founder-preference', source: 'confirmation' }] },
      { name: 'bob',   files: [{ name: 'same', tags: ['style', 'prefer'], type: 'founder-preference', source: 'confirmation' }] },
    ]);
    const candidates = getCultureCandidates(CORP_ROOT);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.entries.every(e => e.source === 'confirmation')).toBe(true);
  });

  it('defaults timesHeard to 1 when frontmatter field missing', () => {
    seedCorp([
      { name: 'alice', files: [{ name: 'a', tags: ['style', 'verbose'], source: 'correction' }] },
      { name: 'bob',   files: [{ name: 'b', tags: ['style', 'verbose'], source: 'correction' }] },
    ]);
    const candidates = getCultureCandidates(CORP_ROOT);
    expect(candidates[0]!.entries.every(e => e.timesHeard === 1)).toBe(true);
    expect(candidates[0]!.totalTimesHeard).toBe(2);
  });

  it('sums totalTimesHeard across cluster', () => {
    seedCorp([
      { name: 'alice', files: [{ name: 'a', tags: ['style', 'verbose'], source: 'correction', timesHeard: 3 }] },
      { name: 'bob',   files: [{ name: 'b', tags: ['style', 'verbose'], source: 'correction', timesHeard: 2 }] },
    ]);
    const candidates = getCultureCandidates(CORP_ROOT);
    expect(candidates[0]!.totalTimesHeard).toBe(5);
    expect(candidates[0]!.maxTimesHeard).toBe(3);
  });
});
