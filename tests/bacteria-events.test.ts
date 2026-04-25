import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendBacteriaEvent,
  readBacteriaEvents,
  type BacteriaEvent,
} from '../packages/shared/src/index.js';

/**
 * Coverage for the bacteria-events.jsonl substrate (Project 1.10.4).
 * Every observability surface — status, lineage, Sexton's wake prompt,
 * burst detector — reads through this. Defensive behavior matters
 * (missing file → empty, malformed lines → skipped, filters compose).
 */

describe('bacteria-events substrate', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'bacteria-events-'));
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      /* Windows */
    }
  });

  function makeMitose(overrides: Partial<BacteriaEvent> = {}): BacteriaEvent {
    return {
      kind: 'mitose',
      ts: '2026-04-25T10:00:00.000Z',
      role: 'backend-engineer',
      slug: 'backend-engineer-ab',
      generation: 1,
      parentSlug: null,
      assignedChit: 'chit-t-abc',
      ...overrides,
    } as BacteriaEvent;
  }

  function makeApoptose(overrides: Partial<BacteriaEvent> = {}): BacteriaEvent {
    return {
      kind: 'apoptose',
      ts: '2026-04-25T11:00:00.000Z',
      role: 'backend-engineer',
      slug: 'backend-engineer-ab',
      generation: 1,
      parentSlug: null,
      chosenName: 'Toast',
      reason: 'queue drained',
      idleSince: '2026-04-25T10:57:00.000Z',
      lifetimeMs: 3_600_000,
      tasksCompleted: 5,
      ...overrides,
    } as BacteriaEvent;
  }

  it('returns empty array when the log file does not exist', () => {
    const events = readBacteriaEvents(corpRoot);
    expect(events).toEqual([]);
  });

  it('append → read round-trip preserves event shape', () => {
    appendBacteriaEvent(corpRoot, makeMitose());
    const events = readBacteriaEvents(corpRoot);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'mitose',
      role: 'backend-engineer',
      slug: 'backend-engineer-ab',
    });
  });

  it('preserves chronological order across multiple appends', () => {
    appendBacteriaEvent(corpRoot, makeMitose({ ts: '2026-04-25T10:00:00.000Z' }));
    appendBacteriaEvent(corpRoot, makeMitose({ ts: '2026-04-25T10:01:00.000Z', slug: 'backend-engineer-bd' }));
    appendBacteriaEvent(corpRoot, makeMitose({ ts: '2026-04-25T10:02:00.000Z', slug: 'backend-engineer-cd' }));
    const events = readBacteriaEvents(corpRoot);
    expect(events.map((e) => e.slug)).toEqual([
      'backend-engineer-ab',
      'backend-engineer-bd',
      'backend-engineer-cd',
    ]);
  });

  it('filters by `since` (inclusive)', () => {
    appendBacteriaEvent(corpRoot, makeMitose({ ts: '2026-04-25T09:00:00.000Z' }));
    appendBacteriaEvent(corpRoot, makeMitose({ ts: '2026-04-25T11:00:00.000Z', slug: 'backend-engineer-bd' }));
    const events = readBacteriaEvents(corpRoot, { since: '2026-04-25T10:00:00.000Z' });
    expect(events.map((e) => e.slug)).toEqual(['backend-engineer-bd']);
  });

  it('filters by role', () => {
    appendBacteriaEvent(corpRoot, makeMitose({ role: 'backend-engineer' }));
    appendBacteriaEvent(corpRoot, makeMitose({ role: 'qa-engineer', slug: 'qa-engineer-xy' }));
    const events = readBacteriaEvents(corpRoot, { role: 'qa-engineer' });
    expect(events).toHaveLength(1);
    expect(events[0]!.slug).toBe('qa-engineer-xy');
  });

  it('filters by kind', () => {
    appendBacteriaEvent(corpRoot, makeMitose());
    appendBacteriaEvent(corpRoot, makeApoptose());
    const mitoses = readBacteriaEvents(corpRoot, { kind: 'mitose' });
    const apoptoses = readBacteriaEvents(corpRoot, { kind: 'apoptose' });
    expect(mitoses).toHaveLength(1);
    expect(apoptoses).toHaveLength(1);
    expect(mitoses[0]!.kind).toBe('mitose');
    expect(apoptoses[0]!.kind).toBe('apoptose');
  });

  it('skips malformed lines without throwing', () => {
    appendBacteriaEvent(corpRoot, makeMitose());
    // Plant a malformed line
    const path = join(corpRoot, 'bacteria-events.jsonl');
    writeFileSync(
      path,
      '{"valid":"json","missing":"required fields"}\n' +
        '{ broken json {{{\n' +
        JSON.stringify(makeMitose({ slug: 'backend-engineer-cd' })) + '\n',
      'utf-8',
    );
    const events = readBacteriaEvents(corpRoot);
    // First line had wrong shape, second was bad JSON, third valid
    expect(events).toHaveLength(1);
    expect(events[0]!.slug).toBe('backend-engineer-cd');
  });

  it('apoptose event preserves lifetime + tasksCompleted + chosenName', () => {
    appendBacteriaEvent(corpRoot, makeApoptose({ chosenName: 'Toast', lifetimeMs: 7_200_000, tasksCompleted: 12 }));
    const events = readBacteriaEvents(corpRoot, { kind: 'apoptose' });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    if (e.kind !== 'apoptose') throw new Error('narrowing');
    expect(e.chosenName).toBe('Toast');
    expect(e.lifetimeMs).toBe(7_200_000);
    expect(e.tasksCompleted).toBe(12);
  });
});
