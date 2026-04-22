import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  observe,
  readTodaysObservations,
  parseObservations,
  getObservationStats,
  getObservationLogPath,
  getObservationsDir,
  countRecentObservations,
  listObservationLogs,
} from '../packages/shared/src/observations.js';
import { existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

/**
 * Post-0.5-migration tests. Observations now live as chits under
 * agent:<slug> scope rather than in daily-log files at
 * observations/YYYY/MM/YYYY-MM-DD.md. The EXTERNAL API surface is
 * preserved (observe / readTodaysObservations / parseObservations /
 * getObservationStats etc.) so these tests verify the contracts the
 * daemon callers rely on still hold against the new storage.
 */

describe('observations (post-0.5 chit-backed)', () => {
  let corpRoot: string;
  let agentDir: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'observations-test-'));
    // Set up a realistic agent layout: <corpRoot>/agents/<slug>.
    // observe() requires this shape to derive corpRoot + scope.
    agentDir = join(corpRoot, 'agents', 'toast');
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('observe() writes an entry accessible via readTodaysObservations', () => {
    observe(agentDir, 'TASK', 'Picked up cool-bay');

    const content = readTodaysObservations(agentDir);
    expect(content).toContain('[TASK]');
    expect(content).toContain('Picked up cool-bay');
  });

  it('observe() writes to chit storage (one chit file per call, not one daily file)', () => {
    observe(agentDir, 'TASK', 'First task');
    observe(agentDir, 'DECISION', 'Chose approach B');
    observe(agentDir, 'CHECKPOINT', 'Phase 1 complete');

    // Each call = one chit. readTodaysObservations synthesizes the bulleted
    // markdown from all of today's chits, so parsing reports 3 entries.
    const content = readTodaysObservations(agentDir);
    const lines = content.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(3);

    // Chit files on disk — one per observe() call
    const chitDir = join(agentDir, 'chits', 'observation');
    const chitFiles = readdirSync(chitDir).filter((f) => f.endsWith('.md'));
    expect(chitFiles).toHaveLength(3);
  });

  it('parseObservations() round-trips through the synthesized markdown', () => {
    observe(agentDir, 'LEARNED', 'Auth uses JWT tokens', ['src/auth.ts']);
    observe(agentDir, 'BLOCKED', 'Cannot access API');

    const content = readTodaysObservations(agentDir);
    const observations = parseObservations(content);

    expect(observations).toHaveLength(2);
    // Order: sorted by createdAt asc (earliest first)
    const learned = observations.find((o) => o.category === 'LEARNED');
    const blocked = observations.find((o) => o.category === 'BLOCKED');
    expect(learned).toBeDefined();
    expect(blocked).toBeDefined();
    expect(learned!.description).toBe('Auth uses JWT tokens');
    expect(learned!.files).toContain('src/auth.ts');
  });

  it('getObservationStats() returns correct counts from chit query', () => {
    observe(agentDir, 'TASK', 'Task 1');
    observe(agentDir, 'TASK', 'Task 2');
    observe(agentDir, 'DECISION', 'Decision 1');
    observe(agentDir, 'ERROR', 'Something broke');

    const stats = getObservationStats(agentDir);
    expect(stats).not.toBeNull();
    expect(stats!.entryCount).toBe(4);
    expect(stats!.categoryCounts.TASK).toBe(2);
    expect(stats!.categoryCounts.DECISION).toBe(1);
    expect(stats!.categoryCounts.ERROR).toBe(1);
  });

  it('getObservationLogPath() returns the chit directory post-migration', () => {
    const path = getObservationLogPath(agentDir);
    // Pre-0.5 this returned observations/YYYY/MM/YYYY-MM-DD.md. Post-chits
    // there's no single per-day file — the helper now points at the agent's
    // observation chit directory as the closest single-location analogue.
    const normalized = path.replace(/\\/g, '/');
    expect(normalized).toContain('chits/observation');
    expect(path).toBe(getObservationsDir(agentDir));
  });

  it('countRecentObservations() counts via queryChits, respects sinceDaysAgo', () => {
    observe(agentDir, 'TASK', 'Recent 1');
    observe(agentDir, 'TASK', 'Recent 2');

    expect(countRecentObservations(agentDir, 7)).toBe(2);
    expect(countRecentObservations(agentDir, 1)).toBe(2);
  });

  it('listObservationLogs() groups chits by date', () => {
    observe(agentDir, 'TASK', 'One');
    observe(agentDir, 'TASK', 'Two');

    const logs = listObservationLogs(agentDir);
    // Both observations today → single date entry
    expect(logs).toHaveLength(1);
    expect(logs[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(logs[0]!.path).toBe(getObservationsDir(agentDir));
  });

  it('observe() preserves the original activity category via from-log tag', () => {
    observe(agentDir, 'SLUMBER', 'Entering deep work');

    // Round-trip: synthesize markdown, parse back, original category recovered
    const content = readTodaysObservations(agentDir);
    const observations = parseObservations(content);
    expect(observations[0]!.category).toBe('SLUMBER');
  });

  it('observe() with files adds file:<path> tags', () => {
    observe(agentDir, 'CREATED', 'Wrote tests', ['tests/a.test.ts', 'tests/b.test.ts']);

    const content = readTodaysObservations(agentDir);
    const observations = parseObservations(content);
    expect(observations[0]!.files).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('returns empty string when no observations exist for today', () => {
    expect(readTodaysObservations(agentDir)).toBe('');
    expect(getObservationStats(agentDir)).toBeNull();
    expect(countRecentObservations(agentDir, 7)).toBe(0);
    expect(listObservationLogs(agentDir)).toEqual([]);
  });

  it('throws a clear error if agentDir is malformed (not under agents/)', () => {
    const malformedDir = join(corpRoot, 'not-agents', 'toast');
    mkdirSync(malformedDir, { recursive: true });
    expect(() => observe(malformedDir, 'TASK', 'x')).toThrow(/agents\/<slug>/);
  });
});
