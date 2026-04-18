import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parsePendingFeedback,
  getAgentFeedbackIntel,
  getCorpFeedbackIntel,
} from '../packages/shared/src/feedback-intel.js';
import { createBrainFile, getBrainFilePath } from '../packages/shared/src/brain.js';
import { parse as parseFrontmatter, stringify as stringifyFrontmatter } from '../packages/shared/src/parsers/frontmatter.js';
import type { BrainMemoryType, BrainSource } from '../packages/shared/src/types/brain.js';

let counter = 0;
let CORP_ROOT = '';

beforeEach(() => {
  CORP_ROOT = join(tmpdir(), `claude-corp-test-fb-intel-${process.pid}-${++counter}`);
  if (existsSync(CORP_ROOT)) rmSync(CORP_ROOT, { recursive: true, force: true });
  mkdirSync(CORP_ROOT, { recursive: true });
});

interface SeedFile {
  name: string;
  tags: string[];
  type?: BrainMemoryType;
  source?: BrainSource;
  timesHeard?: number;
}

function seedCorp(agents: Array<{
  name: string;
  brainFiles?: SeedFile[];
  pendingBody?: string;
}>) {
  const members: Array<Record<string, unknown>> = [
    { id: 'founder', displayName: 'Mark', rank: 'owner', status: 'active',
      type: 'user', scope: 'corp', scopeId: 'test', agentDir: null,
      port: null, spawnedBy: null, createdAt: '2026-01-01' },
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

    if (agent.pendingBody) {
      writeFileSync(join(absDir, '.pending-feedback.md'), agent.pendingBody, 'utf-8');
    }

    for (const file of agent.brainFiles ?? []) {
      const source = file.source ?? 'correction';
      const type = file.type ?? 'correction';
      createBrainFile(absDir, file.name, `Body for ${file.name}`, type, file.tags, source, 'medium');
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

// ── parsePendingFeedback ────────────────────────────────────────────

describe('parsePendingFeedback', () => {
  it('returns empty for empty input', () => {
    expect(parsePendingFeedback('')).toEqual([]);
    expect(parsePendingFeedback('   \n\n   ')).toEqual([]);
  });

  it('parses a single entry', () => {
    const body = `# Pending Feedback

Corrections and confirmations captured from the founder.

---

## 2026-04-18T12:34:56.789Z

**Channel:** DM (dm-alice)
**Signal:** correction (matched: dont, wrong, +2 more)

**Quote:**
> stop summarizing
> just ship

**Prior context:**
Your message at 12:30:00: "here's a summary of what I did..."

---
`;
    const entries = parsePendingFeedback(body);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      timestamp: '2026-04-18T12:34:56.789Z',
      channel: 'DM (dm-alice)',
      polarity: 'correction',
      quote: 'stop summarizing\njust ship',
    });
    expect(entries[0]!.matchedPatterns).toContain('dont');
    expect(entries[0]!.matchedPatterns).toContain('wrong');
    expect(entries[0]!.priorContext).toContain("here's a summary");
  });

  it('parses multiple entries, newest first', () => {
    const body = `# Pending Feedback

---

## 2026-04-18T10:00:00.000Z

**Channel:** DM
**Signal:** correction (matched: stop)

**Quote:**
> first entry

**Prior context:**
older

---

## 2026-04-18T11:00:00.000Z

**Channel:** #general
**Signal:** confirmation (matched: perfect)

**Quote:**
> second entry

**Prior context:**
newer

---
`;
    const entries = parsePendingFeedback(body);
    expect(entries).toHaveLength(2);
    // Newest first — 11:00 before 10:00
    expect(entries[0]!.timestamp).toBe('2026-04-18T11:00:00.000Z');
    expect(entries[0]!.polarity).toBe('confirmation');
    expect(entries[1]!.timestamp).toBe('2026-04-18T10:00:00.000Z');
    expect(entries[1]!.polarity).toBe('correction');
  });

  it('recognizes mixed polarity', () => {
    const body = `# Pending Feedback

---

## 2026-04-18T10:00:00.000Z

**Channel:** DM
**Signal:** mixed (matched: perfect, but)

**Quote:**
> perfect, but not like that

**Prior context:**
ctx

---
`;
    expect(parsePendingFeedback(body)[0]!.polarity).toBe('mixed');
  });

  it('falls back to unknown polarity when signal missing', () => {
    const body = `# Pending Feedback

---

## 2026-04-18T10:00:00.000Z

**Channel:** DM

**Quote:**
> malformed entry

**Prior context:**
ctx

---
`;
    const entries = parsePendingFeedback(body);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.polarity).toBe('unknown');
  });

  it('strips "+N more" pattern placeholders from matched list', () => {
    const body = `# Pending Feedback

---

## 2026-04-18T10:00:00.000Z

**Channel:** DM
**Signal:** correction (matched: dont, stop, +3 more)

**Quote:**
> x

**Prior context:**
y

---
`;
    const patterns = parsePendingFeedback(body)[0]!.matchedPatterns;
    expect(patterns).toEqual(['dont', 'stop']);
  });
});

// ── getAgentFeedbackIntel ──────────────────────────────────────────

describe('getAgentFeedbackIntel', () => {
  it('handles an agent with no pending + no BRAIN', () => {
    seedCorp([{ name: 'alice' }]);
    const intel = getAgentFeedbackIntel(CORP_ROOT, 'alice', join(CORP_ROOT, 'agents/alice/'));
    expect(intel.hasPending).toBe(false);
    expect(intel.pending).toEqual([]);
    expect(intel.brainEntries).toEqual([]);
    expect(intel.stats.pendingCount).toBe(0);
    expect(intel.stats.totalTimesHeard).toBe(0);
  });

  it('surfaces pending file when present', () => {
    seedCorp([{
      name: 'alice',
      pendingBody: `# Pending Feedback\n\n---\n\n## 2026-04-18T10:00:00Z\n\n**Channel:** DM\n**Signal:** correction (matched: stop)\n\n**Quote:**\n> cut it out\n\n**Prior context:**\nprior\n\n---\n`,
    }]);
    const intel = getAgentFeedbackIntel(CORP_ROOT, 'alice', join(CORP_ROOT, 'agents/alice/'));
    expect(intel.hasPending).toBe(true);
    expect(intel.pending).toHaveLength(1);
    expect(intel.stats.correctionCount).toBe(1);
    expect(intel.stats.confirmationCount).toBe(0);
  });

  it('returns only feedback-sourced BRAIN entries', () => {
    seedCorp([{
      name: 'alice',
      brainFiles: [
        { name: 'correction-one', tags: ['style'], source: 'correction' },
        { name: 'technical-note', tags: ['tech'], type: 'technical', source: 'observation' }, // should be excluded
        { name: 'founder-said',  tags: ['pref'], type: 'founder-preference', source: 'founder-direct' },
        { name: 'confirm-it',    tags: ['vibe'], type: 'founder-preference', source: 'confirmation' },
      ],
    }]);
    const intel = getAgentFeedbackIntel(CORP_ROOT, 'alice', join(CORP_ROOT, 'agents/alice/'));
    const names = intel.brainEntries.map(e => e.name).sort();
    expect(names).toEqual(['confirm-it', 'correction-one', 'founder-said']);
  });

  it('sorts BRAIN entries by timesHeard desc', () => {
    seedCorp([{
      name: 'alice',
      brainFiles: [
        { name: 'rare', tags: ['style'], source: 'correction', timesHeard: 1 },
        { name: 'loud', tags: ['style'], source: 'correction', timesHeard: 4 },
        { name: 'mid',  tags: ['style'], source: 'correction', timesHeard: 2 },
      ],
    }]);
    const intel = getAgentFeedbackIntel(CORP_ROOT, 'alice', join(CORP_ROOT, 'agents/alice/'));
    expect(intel.brainEntries.map(e => e.name)).toEqual(['loud', 'mid', 'rare']);
    expect(intel.stats.totalTimesHeard).toBe(7);
    expect(intel.stats.repeatedEntryCount).toBe(2); // loud + mid
  });
});

// ── getCorpFeedbackIntel ───────────────────────────────────────────

describe('getCorpFeedbackIntel', () => {
  it('returns empty-but-valid for empty corp', () => {
    writeFileSync(join(CORP_ROOT, 'members.json'), JSON.stringify([]), 'utf-8');
    const intel = getCorpFeedbackIntel(CORP_ROOT);
    expect(intel.agents).toEqual([]);
    expect(intel.cultureContent).toBeNull();
    expect(intel.candidates).toEqual([]);
    expect(intel.totals.agentsWithPending).toBe(0);
  });

  it('aggregates across agents', () => {
    seedCorp([
      {
        name: 'alice',
        pendingBody: '# Pending\n\n---\n\n## 2026-04-18T10:00:00Z\n**Channel:** DM\n**Signal:** correction (matched: stop)\n**Quote:**\n> x\n**Prior context:**\ny\n\n---\n',
        brainFiles: [{ name: 'a', tags: ['style', 'verbose'], source: 'correction', timesHeard: 2 }],
      },
      {
        name: 'bob',
        brainFiles: [{ name: 'b', tags: ['style', 'verbose'], source: 'correction' }],
      },
    ]);
    const intel = getCorpFeedbackIntel(CORP_ROOT);
    expect(intel.agents).toHaveLength(2);
    expect(intel.totals.agentsWithPending).toBe(1);
    expect(intel.totals.totalPendingEntries).toBe(1);
    expect(intel.totals.totalFeedbackBrainEntries).toBe(2);
    expect(intel.totals.totalTimesHeard).toBe(3); // alice=2 + bob=1
    // Strong/moderate candidates come from the culture module;
    // 2 agents on the same 2-tag cluster → moderate
    expect(intel.totals.moderateCandidates).toBeGreaterThanOrEqual(1);
  });

  it('surfaces CULTURE.md when written', () => {
    seedCorp([{ name: 'alice' }]);
    writeFileSync(join(CORP_ROOT, 'CULTURE.md'), '# Corp Culture\n\n## rule\n\nbody', 'utf-8');
    const intel = getCorpFeedbackIntel(CORP_ROOT);
    expect(intel.cultureContent).toContain('Corp Culture');
    expect(intel.cultureSizeChars).toBeGreaterThan(0);
  });

  it('sorts agents so pending ones surface first', () => {
    seedCorp([
      { name: 'quiet', brainFiles: [{ name: 'x', tags: ['a', 'b'], source: 'correction' }] },
      {
        name: 'loud',
        pendingBody: '# Pending\n\n---\n\n## 2026-04-18T10:00:00Z\n**Channel:** DM\n**Signal:** correction (matched: stop)\n**Quote:**\n> x\n**Prior context:**\ny\n\n---\n',
      },
    ]);
    const intel = getCorpFeedbackIntel(CORP_ROOT);
    expect(intel.agents[0]!.agentName).toBe('loud');
  });
});
