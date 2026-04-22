import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChit, readChit, chitPath, queryChits } from '../packages/shared/src/chits.js';
import { scanChitLifecycle, buildReferenceIndex } from '../packages/daemon/src/chit-lifecycle.js';

/**
 * Integration tests for the Project 0.6 chit lifecycle scanner. These
 * cover the 6 scenarios pinned in the spec:
 *
 *   1. Destruction path — handoff with TTL aged, no signal → destroyed
 *   2. Cold path — observation with TTL aged, no signal → cold, file stays
 *   3. Promotion path — handoff with a reference → promoted (ephemeral=false)
 *   4. Keep tag overrides destruction — handoff tagged keep + aged → promoted
 *   5. Fresh + no signal → skip (scanner leaves for next tick)
 *   6. Scanner work-list bound — re-scanning after cold is a no-op (cold chits
 *      have ephemeral=false so queryChits({ephemeral:true}) doesn't visit them)
 */

describe('scanChitLifecycle — integration', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chit-lifecycle-'));
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('destroys handoff that TTL-aged with no promotion signal', () => {
    const handoff = createChit(corpRoot, {
      type: 'handoff',
      scope: 'corp',
      createdBy: 'predecessor',
      ephemeral: true,
      ttl: '2026-04-22T10:00:00.000Z',
      fields: {
        handoff: {
          predecessorSession: 'toast-1',
          currentStep: 'chit-t-11111111',
          completed: [],
          nextAction: 'continue',
        },
      },
    });
    const path = chitPath(corpRoot, 'corp', 'handoff', handoff.id);
    expect(existsSync(path), 'handoff file should exist pre-scan').toBe(true);

    const result = scanChitLifecycle(corpRoot, {
      now: new Date('2026-04-22T11:00:00.000Z'), // 1h past ttl
    });

    expect(result.destroyed).toBe(1);
    expect(result.cooled).toBe(0);
    expect(result.promoted).toBe(0);
    expect(existsSync(path), 'handoff file should be gone after destroy').toBe(false);

    const logEntry = result.entries.find((e) => e.chitId === handoff.id);
    expect(logEntry?.action).toBe('destroyed');
  });

  it('cools observation that TTL-aged with no promotion signal (keep-forever policy)', () => {
    const obs = createChit(corpRoot, {
      type: 'observation',
      scope: 'corp',
      createdBy: 'ceo',
      ephemeral: true,
      ttl: '2026-04-22T10:00:00.000Z',
      fields: {
        observation: {
          category: 'NOTICE',
          subject: 'mark',
          importance: 2,
        },
      },
    });
    const path = chitPath(corpRoot, 'corp', 'observation', obs.id);
    expect(existsSync(path), 'observation file should exist pre-scan').toBe(true);

    const result = scanChitLifecycle(corpRoot, {
      now: new Date('2026-04-22T11:00:00.000Z'),
    });

    expect(result.cooled).toBe(1);
    expect(result.destroyed).toBe(0);
    expect(existsSync(path), 'observation file should STILL exist after cold').toBe(true);

    // Re-read — should be status:cold, ephemeral:false
    const { chit: cooled } = readChit(corpRoot, 'corp', 'observation', obs.id);
    expect(cooled.status).toBe('cold');
    expect(cooled.ephemeral).toBe(false);
    expect(cooled.ttl).toBeUndefined();

    const logEntry = result.entries.find((e) => e.chitId === obs.id);
    expect(logEntry?.action).toBe('cooled');
  });

  it('promotes handoff referenced by another chit (ephemeral: true → false, ttl cleared)', () => {
    // Create a handoff
    const handoff = createChit(corpRoot, {
      type: 'handoff',
      scope: 'corp',
      createdBy: 'predecessor',
      ephemeral: true,
      ttl: '2026-04-22T10:00:00.000Z',
      fields: {
        handoff: {
          predecessorSession: 'toast-1',
          currentStep: 'chit-t-22222222',
          completed: [],
          nextAction: 'continue',
        },
      },
    });

    // Create a task that references the handoff (structured signal)
    createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'ceo',
      references: [handoff.id],
      fields: {
        task: {
          title: 'task referencing the handoff',
          priority: 'normal',
        },
      },
    });

    const result = scanChitLifecycle(corpRoot, {
      now: new Date('2026-04-22T11:00:00.000Z'), // aged, but referenced
    });

    expect(result.promoted).toBe(1);
    expect(result.destroyed).toBe(0);

    const { chit: promoted } = readChit(corpRoot, 'corp', 'handoff', handoff.id);
    expect(promoted.ephemeral).toBe(false);
    expect(promoted.ttl).toBeUndefined();

    const logEntry = result.entries.find((e) => e.chitId === handoff.id);
    expect(logEntry?.action).toBe('promoted');
    expect(logEntry?.reason).toBe('referenced');
  });

  it('promotes handoff with `keep` tag even when aged (explicit intent beats destruction)', () => {
    const handoff = createChit(corpRoot, {
      type: 'handoff',
      scope: 'corp',
      createdBy: 'predecessor',
      ephemeral: true,
      ttl: '2026-04-22T10:00:00.000Z',
      tags: ['keep'],
      fields: {
        handoff: {
          predecessorSession: 'toast-1',
          currentStep: 'chit-t-33333333',
          completed: [],
          nextAction: 'continue',
        },
      },
    });

    const result = scanChitLifecycle(corpRoot, {
      now: new Date('2026-04-22T11:00:00.000Z'),
    });

    expect(result.promoted).toBe(1);
    expect(result.destroyed).toBe(0);

    const { chit: promoted } = readChit(corpRoot, 'corp', 'handoff', handoff.id);
    expect(promoted.ephemeral).toBe(false);

    const logEntry = result.entries.find((e) => e.chitId === handoff.id);
    expect(logEntry?.reason).toBe('tagged-keep');
  });

  it('skips fresh chits with no promotion signal (leaves for next tick)', () => {
    const handoff = createChit(corpRoot, {
      type: 'handoff',
      scope: 'corp',
      createdBy: 'predecessor',
      ephemeral: true,
      ttl: '2026-04-22T12:00:00.000Z', // AFTER scan time = not aged
      fields: {
        handoff: {
          predecessorSession: 'toast-1',
          currentStep: 'chit-t-44444444',
          completed: [],
          nextAction: 'continue',
        },
      },
    });

    const result = scanChitLifecycle(corpRoot, {
      now: new Date('2026-04-22T11:00:00.000Z'),
    });

    expect(result.skipped).toBe(1);
    expect(result.destroyed).toBe(0);
    expect(result.promoted).toBe(0);

    // Chit unchanged — still ephemeral with its ttl
    const { chit: unchanged } = readChit(corpRoot, 'corp', 'handoff', handoff.id);
    expect(unchanged.ephemeral).toBe(true);
    expect(unchanged.ttl).toBe('2026-04-22T12:00:00.000Z');
  });

  it('scanner work-list stays bounded — cold chits are not revisited on subsequent ticks', () => {
    // Create an observation that will be cold on first tick
    createChit(corpRoot, {
      type: 'observation',
      scope: 'corp',
      createdBy: 'ceo',
      ephemeral: true,
      ttl: '2026-04-22T10:00:00.000Z',
      fields: {
        observation: {
          category: 'NOTICE',
          subject: 'mark',
          importance: 2,
        },
      },
    });

    const now = new Date('2026-04-22T11:00:00.000Z');

    const first = scanChitLifecycle(corpRoot, { now });
    expect(first.cooled).toBe(1);

    // Run the scanner again immediately — cold observation should not be
    // visited (ephemeral: false now), so every counter should be zero.
    const second = scanChitLifecycle(corpRoot, { now });
    expect(second.cooled).toBe(0);
    expect(second.destroyed).toBe(0);
    expect(second.promoted).toBe(0);
    expect(second.skipped).toBe(0);
    expect(second.entries).toHaveLength(0);
  });

  it('writes a single JSONL log entry per action to chits/_log/lifecycle.jsonl', () => {
    createChit(corpRoot, {
      type: 'handoff',
      scope: 'corp',
      createdBy: 'predecessor',
      ephemeral: true,
      ttl: '2026-04-22T10:00:00.000Z',
      fields: {
        handoff: {
          predecessorSession: 'toast-1',
          currentStep: 'chit-t-55555555',
          completed: [],
          nextAction: 'continue',
        },
      },
    });

    scanChitLifecycle(corpRoot, { now: new Date('2026-04-22T11:00:00.000Z') });

    const logPath = join(corpRoot, 'chits', '_log', 'lifecycle.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const raw = readFileSync(logPath, 'utf-8').trim();
    const lines = raw.split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.action).toBe('destroyed');
    expect(parsed.chitType).toBe('handoff');
  });

  it('processes the full backlog in one tick after long downtime (no per-tick cap)', () => {
    // Five handoffs, all aged
    for (let i = 0; i < 5; i++) {
      createChit(corpRoot, {
        type: 'handoff',
        scope: 'corp',
        createdBy: 'predecessor',
        ephemeral: true,
        ttl: '2026-04-22T10:00:00.000Z',
        fields: {
          handoff: {
            predecessorSession: `toast-${i}`,
            currentStep: `chit-t-${i.toString().padStart(8, '0')}`,
            completed: [],
            nextAction: 'continue',
          },
        },
      });
    }

    const result = scanChitLifecycle(corpRoot, {
      now: new Date('2026-04-22T23:00:00.000Z'), // 13h later
    });

    expect(result.destroyed).toBe(5);

    // Second tick: nothing to do (all destroyed)
    const second = scanChitLifecycle(corpRoot, {
      now: new Date('2026-04-22T23:01:00.000Z'),
    });
    expect(second.destroyed).toBe(0);
    expect(second.promoted).toBe(0);
    expect(second.cooled).toBe(0);
  });
});

describe('buildReferenceIndex', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chit-lifecycle-idx-'));
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('harvests references from chit.references[]', () => {
    const target = createChit(corpRoot, {
      type: 'observation',
      scope: 'corp',
      createdBy: 'ceo',
      ephemeral: true,
      ttl: '2026-04-25T00:00:00.000Z',
      fields: {
        observation: { category: 'NOTICE', subject: 'mark', importance: 2 },
      },
    });

    createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'ceo',
      references: [target.id],
      fields: { task: { title: 'referring task', priority: 'normal' } },
    });

    const index = buildReferenceIndex(corpRoot);
    expect(index.referencedIds.has(target.id)).toBe(true);
  });

  it('harvests references from chit.dependsOn[]', () => {
    const target = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'ceo',
      fields: { task: { title: 'prerequisite', priority: 'normal' } },
    });

    createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'ceo',
      dependsOn: [target.id],
      fields: { task: { title: 'dependent', priority: 'normal' } },
    });

    const index = buildReferenceIndex(corpRoot);
    expect(index.referencedIds.has(target.id)).toBe(true);
  });

  it('harvests body-text mentions matching the chit-id format', () => {
    const target = createChit(corpRoot, {
      type: 'observation',
      scope: 'corp',
      createdBy: 'ceo',
      ephemeral: true,
      ttl: '2026-04-25T00:00:00.000Z',
      fields: { observation: { category: 'NOTICE', subject: 'mark', importance: 2 } },
    });

    createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'ceo',
      body: `See also ${target.id} for context.`,
      fields: { task: { title: 'related task', priority: 'normal' } },
    });

    const index = buildReferenceIndex(corpRoot);
    expect(index.mentionedIds.has(target.id)).toBe(true);
  });
});
