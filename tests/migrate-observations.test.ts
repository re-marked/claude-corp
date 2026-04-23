import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrateObservationsToChits,
  bulletToChit,
} from '../packages/shared/src/migrations/migrate-observations.js';
import { readChit, queryChits } from '../packages/shared/src/chits.js';

function writeObservationLog(
  corpRoot: string,
  agentSlug: string,
  date: string, // YYYY-MM-DD
  bullets: string[],
): string {
  const [year, month] = date.split('-');
  const dir = join(corpRoot, 'agents', agentSlug, 'observations', year!, month!);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  const content = `# Observations — ${date}\n\n${bullets.join('\n')}\n`;
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('bulletToChit — pure mapping', () => {
  it('translates activity categories to chit vocabulary (lossy)', () => {
    const mappings = [
      ['DECISION', 'DECISION'],
      ['FEEDBACK', 'FEEDBACK'],
      ['RESEARCH', 'DISCOVERY'],
      ['LEARNED', 'DISCOVERY'],
      ['ERROR', 'CORRECTION'],
      ['TASK', 'NOTICE'],
      ['BLOCKED', 'NOTICE'],
      ['CREATED', 'NOTICE'],
      ['REVIEWED', 'NOTICE'],
      ['CHECKPOINT', 'NOTICE'],
      ['SLUMBER', 'NOTICE'],
      ['HANDOFF', 'NOTICE'],
    ] as const;

    for (const [original, expected] of mappings) {
      const chit = bulletToChit({
        agentSlug: 'toast',
        dateFromFilename: '2026-04-20',
        bullet: { localTime: '14:30', category: original, description: 'x', files: [] },
      });
      expect(chit.fields.observation.category, `${original} → ${expected}`).toBe(expected);
    }
  });

  it('preserves the original category as a tag', () => {
    const chit = bulletToChit({
      agentSlug: 'toast',
      dateFromFilename: '2026-04-20',
      bullet: { localTime: '14:30', category: 'TASK', description: 'working', files: [] },
    });
    expect(chit.tags).toContain('from-log:TASK');
  });

  it('encodes file references as tags', () => {
    const chit = bulletToChit({
      agentSlug: 'toast',
      dateFromFilename: '2026-04-20',
      bullet: {
        localTime: '14:30',
        category: 'CREATED',
        description: 'wrote tests',
        files: ['tests/a.test.ts', 'tests/b.test.ts'],
      },
    });
    expect(chit.tags).toContain('file:tests/a.test.ts');
    expect(chit.tags).toContain('file:tests/b.test.ts');
  });

  it('combines date filename + bullet time into ISO timestamp', () => {
    const chit = bulletToChit({
      agentSlug: 'toast',
      dateFromFilename: '2026-04-20',
      bullet: { localTime: '14:32', category: 'TASK', description: 'x', files: [] },
    });
    expect(chit.createdAt).toBe('2026-04-20T14:32:00.000Z');
    expect(chit.updatedAt).toBe('2026-04-20T14:32:00.000Z');
  });

  it('sets createdBy to the agent slug (derived from path)', () => {
    const chit = bulletToChit({
      agentSlug: 'backend-engineer',
      dateFromFilename: '2026-04-20',
      bullet: { localTime: '14:30', category: 'TASK', description: 'x', files: [] },
    });
    expect(chit.createdBy).toBe('backend-engineer');
  });

  it('sets subject to the agent slug (author is observation subject for activity logs)', () => {
    const chit = bulletToChit({
      agentSlug: 'toast',
      dateFromFilename: '2026-04-20',
      bullet: { localTime: '14:30', category: 'TASK', description: 'x', files: [] },
    });
    expect(chit.fields.observation.subject).toBe('toast');
  });

  it('truncates description to title (max 80 chars) and preserves full text in context', () => {
    const longDesc = 'x'.repeat(150);
    const chit = bulletToChit({
      agentSlug: 'toast',
      dateFromFilename: '2026-04-20',
      bullet: { localTime: '14:30', category: 'LEARNED', description: longDesc, files: [] },
    });
    expect(chit.fields.observation.title!.length).toBeLessThanOrEqual(80);
    expect(chit.fields.observation.context).toBe(longDesc);
  });

  it('generates a valid chit id (chit-o-<8hex>)', () => {
    const chit = bulletToChit({
      agentSlug: 'toast',
      dateFromFilename: '2026-04-20',
      bullet: { localTime: '14:30', category: 'TASK', description: 'x', files: [] },
    });
    expect(chit.id).toMatch(/^chit-o-[0-9a-f]{8}$/);
  });

  it('defaults to NOTICE for unknown categories', () => {
    const chit = bulletToChit({
      agentSlug: 'toast',
      dateFromFilename: '2026-04-20',
      bullet: { localTime: '14:30', category: 'BOGUS', description: 'x', files: [] },
    });
    expect(chit.fields.observation.category).toBe('NOTICE');
  });
});

describe('migrateObservationsToChits — file migration', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'migrate-obs-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('returns empty result when no agents/ dir exists', () => {
    const result = migrateObservationsToChits(corpRoot);
    expect(result.filesProcessed).toBe(0);
    expect(result.migrated).toBe(0);
  });

  it('migrates all bullets in a single-file daily log', () => {
    const bullets = [
      '- 14:30 [TASK] picked up chit-t-abc',
      '- 14:45 [DECISION] chose approach A over B',
      '- 15:00 [CREATED] wrote tests/a.test.ts (files: tests/a.test.ts)',
    ];
    const sourcePath = writeObservationLog(corpRoot, 'toast', '2026-04-20', bullets);

    const result = migrateObservationsToChits(corpRoot);
    expect(result.migrated).toBe(3);
    expect(result.filesProcessed).toBe(1);
    expect(result.errors).toEqual([]);

    // Source file deleted
    expect(existsSync(sourcePath)).toBe(false);

    // Three chits written at agent:toast/chits/observation/
    const chitDir = join(corpRoot, 'agents', 'toast', 'chits', 'observation');
    const chitFiles = readdirSync(chitDir).filter((f) => f.endsWith('.md'));
    expect(chitFiles).toHaveLength(3);
  });

  it('migrated chits carry the expected fields via round-trip validation', () => {
    writeObservationLog(corpRoot, 'toast', '2026-04-20', [
      '- 14:30 [DECISION] chose approach A',
    ]);

    migrateObservationsToChits(corpRoot);

    const { chits } = queryChits(corpRoot, {
      types: ['observation'],
      scopes: ['agent:toast'],
    });
    expect(chits).toHaveLength(1);
    const chit = chits[0]!.chit;
    expect(chit.type).toBe('observation');
    expect(chit.status).toBe('active');
    expect(chit.ephemeral).toBe(true);
    expect(chit.fields.observation.category).toBe('DECISION');
    expect(chit.fields.observation.subject).toBe('toast');
    expect(chit.tags).toContain('from-log:DECISION');
  });

  it('walks observations across multiple years/months/agents', () => {
    writeObservationLog(corpRoot, 'toast', '2026-04-20', [
      '- 14:30 [TASK] toast observation',
    ]);
    writeObservationLog(corpRoot, 'toast', '2026-03-15', [
      '- 09:00 [RESEARCH] earlier month',
    ]);
    writeObservationLog(corpRoot, 'copper', '2026-04-20', [
      '- 10:00 [CREATED] copper observation',
    ]);

    const result = migrateObservationsToChits(corpRoot);
    expect(result.migrated).toBe(3);
    expect(result.filesProcessed).toBe(3);
  });

  it('skips malformed bullet lines but processes valid ones in the same file', () => {
    writeObservationLog(corpRoot, 'toast', '2026-04-20', [
      '- not a valid bullet',
      '- 14:30 [TASK] this is valid',
      '- also invalid',
      '- 15:00 [DECISION] also valid',
    ]);

    const result = migrateObservationsToChits(corpRoot);
    expect(result.migrated).toBe(2);
    expect(result.skipped).toBe(2);
  });

  it('deletes empty/all-malformed files so they do not re-process', () => {
    const path = writeObservationLog(corpRoot, 'toast', '2026-04-20', [
      '- garbage',
      '- also garbage',
    ]);

    migrateObservationsToChits(corpRoot);
    expect(existsSync(path)).toBe(false);
  });

  it('dry-run reports planned chit counts per file without writing', () => {
    writeObservationLog(corpRoot, 'toast', '2026-04-20', [
      '- 14:30 [TASK] a',
      '- 15:00 [DECISION] b',
    ]);

    const result = migrateObservationsToChits(corpRoot, { dryRun: true });
    expect(result.migrated).toBe(0);
    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]!.chitCount).toBe(2);

    // No chits written
    const obsDir = join(corpRoot, 'agents', 'toast', 'chits', 'observation');
    expect(existsSync(obsDir)).toBe(false);
  });

  it('idempotent — re-running skips files when target chits for same date exist', () => {
    writeObservationLog(corpRoot, 'toast', '2026-04-20', [
      '- 14:30 [TASK] already migrated',
    ]);

    const first = migrateObservationsToChits(corpRoot);
    expect(first.migrated).toBe(1);

    // Re-seed the source file (simulating a split state)
    writeObservationLog(corpRoot, 'toast', '2026-04-20', [
      '- 14:30 [TASK] already migrated',
    ]);

    const second = migrateObservationsToChits(corpRoot);
    // Should skip via date-based idempotency check — no new chits written
    expect(second.migrated).toBe(0);
    expect(second.filesProcessed).toBe(0); // skipped before counting as processed
  });

  it('overwrite: true re-migrates files even if chits already exist for the date', () => {
    writeObservationLog(corpRoot, 'toast', '2026-04-20', [
      '- 14:30 [TASK] first',
    ]);
    migrateObservationsToChits(corpRoot);
    writeObservationLog(corpRoot, 'toast', '2026-04-20', [
      '- 15:00 [DECISION] second',
    ]);

    const result = migrateObservationsToChits(corpRoot, { overwrite: true });
    expect(result.migrated).toBe(1);
  });

  it('migrated chit body preserves original bullet text verbatim', () => {
    writeObservationLog(corpRoot, 'toast', '2026-04-20', [
      '- 14:30 [TASK] working on the feature (files: src/feature.ts)',
    ]);

    migrateObservationsToChits(corpRoot);

    const { chits } = queryChits(corpRoot, {
      types: ['observation'],
      scopes: ['agent:toast'],
    });
    const { body } = readChit(
      corpRoot,
      'agent:toast',
      'observation',
      chits[0]!.chit.id,
    );
    expect(body).toContain('14:30 [TASK] working on the feature (files: src/feature.ts)');
  });
});
