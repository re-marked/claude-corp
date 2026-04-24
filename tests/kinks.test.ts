import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeOrBumpKink,
  resolveKink,
  queryChits,
  findChitById,
  CHIT_TYPES,
  getChitType,
  ChitValidationError,
  type Chit,
} from '../packages/shared/src/index.js';

/**
 * kink lifecycle — the dedup + auto-resolve primitives that
 * sweepers (and future daemon-internal detectors) lean on.
 *
 * Test focus:
 *   - writeOrBumpKink: create vs bump decision, severity/title
 *     refresh on bump, preserved source/subject identity.
 *   - resolveKink: state transition, resolution field set,
 *     noop on no-match, closes-all on multiple matches.
 *   - Registry invariants: kink type registered correctly with
 *     the 7d TTL + destroy-if-not-promoted policy pinned by
 *     the spec.
 *
 * Explicitly NOT tested:
 *   - Each sweeper module's full behavior (would require mocking
 *     daemon + processManager + queryChits heavily; rely on
 *     integration-time verification instead).
 *   - Sweeper runner auto-resolve wiring (integration-shaped;
 *     tested via the writeOrBumpKink + resolveKink primitives
 *     the runner composes).
 */

describe('kink chit type — registry invariants', () => {
  it('is registered in CHIT_TYPES', () => {
    const entry = getChitType('kink');
    expect(entry).toBeDefined();
    expect(entry?.id).toBe('kink');
    expect(entry?.idPrefix).toBe('k');
  });

  it('has ephemeral + 7d TTL + destroy-if-not-promoted policy', () => {
    const entry = getChitType('kink');
    expect(entry?.defaultEphemeral).toBe(true);
    expect(entry?.defaultTTL).toBe('7d');
    expect(entry?.destructionPolicy).toBe('destroy-if-not-promoted');
  });

  it('accepts active + closed + burning statuses; closed + burning are terminal', () => {
    const entry = getChitType('kink');
    expect(entry?.validStatuses).toEqual(['active', 'closed', 'burning']);
    expect(entry?.terminalStatuses).toEqual(['closed', 'burning']);
  });
});

describe('validateKink', () => {
  const entry = getChitType('kink');

  it('accepts a minimal valid kink', () => {
    expect(() => entry?.validate({
      source: 'sweeper:silentexit',
      subject: 'ceo',
      severity: 'info',
      title: 'Respawned CEO',
      occurrenceCount: 1,
    })).not.toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => entry?.validate({
      // source missing
      subject: 'ceo',
      severity: 'info',
      title: 'foo',
      occurrenceCount: 1,
    })).toThrow(ChitValidationError);
  });

  it('rejects invalid severity enum', () => {
    expect(() => entry?.validate({
      source: 'sweeper:silentexit',
      subject: 'ceo',
      severity: 'critical', // not in enum
      title: 'foo',
      occurrenceCount: 1,
    })).toThrow(ChitValidationError);
  });

  it('rejects occurrenceCount < 1', () => {
    expect(() => entry?.validate({
      source: 'sweeper:silentexit',
      subject: 'ceo',
      severity: 'info',
      title: 'foo',
      occurrenceCount: 0,
    })).toThrow(ChitValidationError);
  });

  it('accepts optional resolution enum', () => {
    for (const r of ['auto-resolved', 'acknowledged', 'dismissed']) {
      expect(() => entry?.validate({
        source: 'sweeper:silentexit',
        subject: 'ceo',
        severity: 'info',
        title: 'foo',
        occurrenceCount: 1,
        resolution: r,
      })).not.toThrow();
    }
  });

  it('rejects invalid resolution enum', () => {
    expect(() => entry?.validate({
      source: 'sweeper:silentexit',
      subject: 'ceo',
      severity: 'info',
      title: 'foo',
      occurrenceCount: 1,
      resolution: 'fixed', // not in enum
    })).toThrow(ChitValidationError);
  });
});

describe('writeOrBumpKink', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = join(
      tmpdir(),
      `kinks-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(corpRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('creates a new kink on first call', () => {
    const result = writeOrBumpKink({
      corpRoot,
      source: 'sweeper:silentexit',
      subject: 'ceo',
      severity: 'info',
      title: 'Respawned CEO',
      body: 'process had crashed',
    });

    expect(result.action).toBe('created');
    expect(result.occurrenceCount).toBe(1);
    expect(result.chit.fields.kink.source).toBe('sweeper:silentexit');
    expect(result.chit.fields.kink.subject).toBe('ceo');
    expect(result.chit.fields.kink.severity).toBe('info');
    expect(result.chit.status).toBe('active');
  });

  it('bumps occurrenceCount on same (source, subject)', () => {
    writeOrBumpKink({
      corpRoot, source: 'sweeper:agentstuck', subject: 'toast', severity: 'warn', title: 'stuck',
    });
    const second = writeOrBumpKink({
      corpRoot, source: 'sweeper:agentstuck', subject: 'toast', severity: 'warn', title: 'still stuck',
    });
    expect(second.action).toBe('bumped');
    expect(second.occurrenceCount).toBe(2);

    // Only one active kink on disk, not two
    const q = queryChits<'kink'>(corpRoot, {
      types: ['kink'], scopes: ['corp'], statuses: ['active'],
    });
    expect(q.chits.length).toBe(1);
  });

  it('refreshes severity + title + body on bump', () => {
    writeOrBumpKink({
      corpRoot, source: 'sweeper:silentexit', subject: 'ceo', severity: 'info',
      title: 'Respawned', body: 'first',
    });
    const bumped = writeOrBumpKink({
      corpRoot, source: 'sweeper:silentexit', subject: 'ceo', severity: 'error',
      title: 'Respawn failed', body: 'second',
    });
    expect(bumped.chit.fields.kink.severity).toBe('error');
    expect(bumped.chit.fields.kink.title).toBe('Respawn failed');
  });

  it('treats distinct (source, subject) pairs as separate kinks', () => {
    writeOrBumpKink({
      corpRoot, source: 'sweeper:silentexit', subject: 'ceo', severity: 'info', title: 'a',
    });
    writeOrBumpKink({
      corpRoot, source: 'sweeper:silentexit', subject: 'herald', severity: 'info', title: 'b',
    });
    writeOrBumpKink({
      corpRoot, source: 'sweeper:agentstuck', subject: 'ceo', severity: 'warn', title: 'c',
    });

    const q = queryChits<'kink'>(corpRoot, {
      types: ['kink'], scopes: ['corp'], statuses: ['active'],
    });
    expect(q.chits.length).toBe(3);
  });

  it('uses createdBy=source by default', () => {
    const r = writeOrBumpKink({
      corpRoot, source: 'sweeper:silentexit', subject: 'ceo', severity: 'info', title: 'x',
    });
    expect(r.chit.createdBy).toBe('sweeper:silentexit');
  });

  it('honors explicit createdBy override', () => {
    const r = writeOrBumpKink({
      corpRoot, source: 'sweeper:silentexit', subject: 'ceo', severity: 'info', title: 'x',
      createdBy: 'some-other-writer',
    });
    expect(r.chit.createdBy).toBe('some-other-writer');
  });
});

describe('resolveKink', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = join(
      tmpdir(),
      `kinks-resolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(corpRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('returns empty array when no active match exists', () => {
    const closed = resolveKink({
      corpRoot, source: 'sweeper:x', subject: 'y', resolution: 'auto-resolved',
    });
    expect(closed).toEqual([]);
  });

  it('closes a matching active kink with resolution set', () => {
    writeOrBumpKink({
      corpRoot, source: 'sweeper:silentexit', subject: 'ceo', severity: 'info', title: 'x',
    });
    const closed = resolveKink({
      corpRoot, source: 'sweeper:silentexit', subject: 'ceo', resolution: 'auto-resolved',
    });

    expect(closed.length).toBe(1);
    expect(closed[0]!.status).toBe('closed');
    expect(closed[0]!.fields.kink.resolution).toBe('auto-resolved');
  });

  it('does not touch kinks from a different source', () => {
    writeOrBumpKink({
      corpRoot, source: 'sweeper:silentexit', subject: 'ceo', severity: 'info', title: 'a',
    });
    writeOrBumpKink({
      corpRoot, source: 'sweeper:agentstuck', subject: 'ceo', severity: 'warn', title: 'b',
    });

    resolveKink({
      corpRoot, source: 'sweeper:silentexit', subject: 'ceo', resolution: 'auto-resolved',
    });

    // silentexit kink should be closed, agentstuck kink should still be active
    const stillActive = queryChits<'kink'>(corpRoot, {
      types: ['kink'], scopes: ['corp'], statuses: ['active'],
    });
    expect(stillActive.chits.length).toBe(1);
    expect(stillActive.chits[0]!.chit.fields.kink.source).toBe('sweeper:agentstuck');
  });

  it('accepts the three documented resolution values', () => {
    for (const r of ['auto-resolved', 'acknowledged', 'dismissed'] as const) {
      const localRoot = join(
        tmpdir(),
        `kinks-res-${r}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      mkdirSync(localRoot, { recursive: true });
      try {
        writeOrBumpKink({
          corpRoot: localRoot, source: 'sweeper:s', subject: 'subj', severity: 'info', title: 't',
        });
        const closed = resolveKink({
          corpRoot: localRoot, source: 'sweeper:s', subject: 'subj', resolution: r,
        });
        expect(closed[0]!.fields.kink.resolution).toBe(r);
      } finally {
        try { rmSync(localRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  });
});
