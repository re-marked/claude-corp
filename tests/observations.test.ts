import { describe, it, expect, beforeEach } from 'vitest';
import {
  observe,
  readTodaysObservations,
  parseObservations,
  getObservationStats,
  getObservationLogPath,
} from '../packages/shared/src/observations.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'claude-corp-test-obs');

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

describe('observations', () => {
  it('observe() creates the directory structure and writes an entry', () => {
    observe(TEST_DIR, 'TASK', 'Picked up cool-bay');

    const content = readTodaysObservations(TEST_DIR);
    expect(content).toContain('[TASK]');
    expect(content).toContain('Picked up cool-bay');
  });

  it('observe() appends multiple entries to the same file', () => {
    observe(TEST_DIR, 'TASK', 'First task');
    observe(TEST_DIR, 'DECISION', 'Chose approach B');
    observe(TEST_DIR, 'CHECKPOINT', 'Phase 1 complete');

    const content = readTodaysObservations(TEST_DIR);
    const lines = content.split('\n').filter(l => l.startsWith('- '));
    expect(lines).toHaveLength(3);
  });

  it('parseObservations() extracts structured data', () => {
    observe(TEST_DIR, 'LEARNED', 'Auth uses JWT tokens', ['src/auth.ts']);
    observe(TEST_DIR, 'BLOCKED', 'Cannot access API');

    const content = readTodaysObservations(TEST_DIR);
    const observations = parseObservations(content);

    expect(observations).toHaveLength(2);
    expect(observations[0]!.category).toBe('LEARNED');
    expect(observations[0]!.description).toBe('Auth uses JWT tokens');
    expect(observations[0]!.files).toContain('src/auth.ts');
    expect(observations[1]!.category).toBe('BLOCKED');
  });

  it('getObservationStats() returns correct counts', () => {
    observe(TEST_DIR, 'TASK', 'Task 1');
    observe(TEST_DIR, 'TASK', 'Task 2');
    observe(TEST_DIR, 'DECISION', 'Decision 1');
    observe(TEST_DIR, 'ERROR', 'Something broke');

    const stats = getObservationStats(TEST_DIR);
    expect(stats).not.toBeNull();
    expect(stats!.entryCount).toBe(4);
    expect(stats!.categoryCounts.TASK).toBe(2);
    expect(stats!.categoryCounts.DECISION).toBe(1);
    expect(stats!.categoryCounts.ERROR).toBe(1);
  });

  it('getObservationLogPath() uses YYYY/MM/YYYY-MM-DD format', () => {
    const path = getObservationLogPath(TEST_DIR);
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');

    // Windows uses backslashes — normalize for comparison
    const normalized = path.replace(/\\/g, '/');
    expect(normalized).toContain(`observations/${year}/${month}/`);
    expect(path).toMatch(/\.md$/);
  });
});
