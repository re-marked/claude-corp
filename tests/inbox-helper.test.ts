import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createInboxItem,
  TIER_TTL,
  findChitById,
  type Chit,
} from '../packages/shared/src/index.js';

/**
 * createInboxItem is the single funnel for all inbox-item creation
 * (router, hand, escalate, system emitters). These tests lock down
 * the tier-specific TTL / destructionPolicy / scope invariants so
 * drift between tiers becomes a test failure instead of a silent
 * audit-gate bug.
 */

describe('createInboxItem', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = join(
      tmpdir(),
      `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(corpRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  describe('tier → TTL mapping', () => {
    it('Tier 1 → 24h TTL', () => {
      expect(TIER_TTL[1]).toBe('24h');
    });
    it('Tier 2 → 7d TTL', () => {
      expect(TIER_TTL[2]).toBe('7d');
    });
    it('Tier 3 → 30d TTL', () => {
      expect(TIER_TTL[3]).toBe('30d');
    });
  });

  describe('tier → destructionPolicy mapping', () => {
    it('Tier 1 writes destructionPolicy="destroy-if-not-promoted" on the chit', () => {
      const chit = createInboxItem({
        corpRoot,
        recipient: 'toast',
        tier: 1,
        from: 'system',
        subject: 'failsafe restarted',
        source: 'system',
      });
      expect(chit.destructionPolicy).toBe('destroy-if-not-promoted');
    });

    it('Tier 2 inherits registry default (no explicit field → undefined)', () => {
      const chit = createInboxItem({
        corpRoot,
        recipient: 'toast',
        tier: 2,
        from: 'pilot',
        subject: '@mention in #general',
        source: 'channel',
        sourceRef: 'general',
      });
      expect(chit.destructionPolicy).toBeUndefined();
    });

    it('Tier 3 inherits registry default (no explicit field → undefined)', () => {
      const chit = createInboxItem({
        corpRoot,
        recipient: 'ceo',
        tier: 3,
        from: 'mark',
        subject: 'can you review the plan?',
        source: 'dm',
      });
      expect(chit.destructionPolicy).toBeUndefined();
    });
  });

  describe('scope and fields', () => {
    it('scope is agent:<recipient>', () => {
      const chit = createInboxItem({
        corpRoot,
        recipient: 'herald',
        tier: 2,
        from: 'ceo',
        subject: 'hello',
        source: 'dm',
      });
      // Scope isn't on the chit itself (derived from path), so verify
      // the file landed in the right place via findChitById.
      const hit = findChitById(corpRoot, chit.id);
      expect(hit).not.toBeNull();
      expect(hit!.path).toMatch(/agents[\\/]herald[\\/]chits[\\/]inbox-item[\\/]/);
    });

    it('fields.inbox-item carries tier/from/subject/source/sourceRef verbatim', () => {
      const chit = createInboxItem({
        corpRoot,
        recipient: 'toast',
        tier: 2,
        from: 'pilot',
        subject: 'review my PR',
        source: 'channel',
        sourceRef: 'engineering',
      });
      const f = (chit as Chit<'inbox-item'>).fields['inbox-item'];
      expect(f.tier).toBe(2);
      expect(f.from).toBe('pilot');
      expect(f.subject).toBe('review my PR');
      expect(f.source).toBe('channel');
      expect(f.sourceRef).toBe('engineering');
    });

    it('createdBy defaults to `from` when not specified', () => {
      const chit = createInboxItem({
        corpRoot,
        recipient: 'ceo',
        tier: 3,
        from: 'mark',
        subject: 'x',
        source: 'dm',
      });
      expect(chit.createdBy).toBe('mark');
    });

    it('references[] carries caller-supplied pointers', () => {
      const chit = createInboxItem({
        corpRoot,
        recipient: 'toast',
        tier: 2,
        from: 'pilot',
        subject: 'see #eng:abc',
        source: 'channel',
        sourceRef: 'eng',
        references: ['eng:abc123'],
      });
      expect(chit.references).toEqual(['eng:abc123']);
    });
  });

  describe('TTL is written as ISO-future', () => {
    it('ttl is a parseable ISO timestamp in the future', () => {
      const chit = createInboxItem({
        corpRoot,
        recipient: 'toast',
        tier: 2,
        from: 'pilot',
        subject: 'x',
        source: 'dm',
      });
      expect(chit.ttl).toBeDefined();
      expect(new Date(chit.ttl!).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('chit persists with expected shape', () => {
    it('round-trips through the chit store', () => {
      const created = createInboxItem({
        corpRoot,
        recipient: 'toast',
        tier: 3,
        from: 'mark',
        subject: 'urgent',
        source: 'dm',
      });
      const hit = findChitById(corpRoot, created.id);
      expect(hit).not.toBeNull();
      expect(hit!.chit.id).toBe(created.id);
      expect(hit!.chit.type).toBe('inbox-item');
      expect((hit!.chit as Chit<'inbox-item'>).fields['inbox-item'].tier).toBe(3);
    });

    it('Tier 1 frontmatter persists the destructionPolicy override on disk', () => {
      const created = createInboxItem({
        corpRoot,
        recipient: 'toast',
        tier: 1,
        from: 'system',
        subject: 'clock tick',
        source: 'system',
      });
      const hit = findChitById(corpRoot, created.id);
      const content = readFileSync(hit!.path, 'utf-8');
      expect(content).toMatch(/destructionPolicy:\s*destroy-if-not-promoted/);
    });
  });
});
