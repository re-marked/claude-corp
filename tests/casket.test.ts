import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  casketExists,
  createCasketIfMissing,
  getCurrentStep,
  advanceCurrentStep,
  incrementSessionCount,
} from '../packages/shared/src/casket.js';
import { findChitById } from '../packages/shared/src/chits.js';
import type { Chit } from '../packages/shared/src/types/chit.js';

/**
 * Lifecycle-primitive coverage for Casket. These tests lock down the
 * "idempotent create / three-way read / no-clobber advance" contracts
 * the audit gate (0.7.3) + task-create (Casket auto-populate) + 1.3's
 * eventual chain walker all depend on.
 */

describe('Casket lifecycle', () => {
  let corpRoot: string;
  const slug = 'toast';

  beforeEach(() => {
    corpRoot = join(
      tmpdir(),
      `casket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(corpRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  describe('casketExists + createCasketIfMissing', () => {
    it('casketExists returns false for a fresh corp with no casket', () => {
      expect(casketExists(corpRoot, slug)).toBe(false);
    });

    it('createCasketIfMissing creates a chit with currentStep=null', () => {
      const casket = createCasketIfMissing(corpRoot, slug, slug);
      expect(casket.type).toBe('casket');
      expect(casket.id).toBe(`casket-${slug}`);
      expect(casket.fields.casket.currentStep).toBeNull();
      expect(casketExists(corpRoot, slug)).toBe(true);
    });

    it('createCasketIfMissing is idempotent — second call returns existing, no duplicate create', () => {
      const first = createCasketIfMissing(corpRoot, slug, slug);
      const second = createCasketIfMissing(corpRoot, slug, slug);
      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
    });

    it('createCasketIfMissing preserves existing Casket state (doesn\'t reset currentStep)', () => {
      createCasketIfMissing(corpRoot, slug, slug);
      advanceCurrentStep(corpRoot, slug, 'chit-t-deadbeef', slug);
      // Simulate a re-hire path calling createCasketIfMissing again.
      const result = createCasketIfMissing(corpRoot, slug, slug);
      expect(result.fields.casket.currentStep).toBe('chit-t-deadbeef');
    });
  });

  describe('getCurrentStep (three-way return)', () => {
    it('returns undefined when Casket does not exist', () => {
      expect(getCurrentStep(corpRoot, slug)).toBeUndefined();
    });

    it('returns null when Casket exists and is idle', () => {
      createCasketIfMissing(corpRoot, slug, slug);
      expect(getCurrentStep(corpRoot, slug)).toBeNull();
    });

    it('returns the chit id string when currentStep is set', () => {
      createCasketIfMissing(corpRoot, slug, slug);
      advanceCurrentStep(corpRoot, slug, 'chit-t-cafebabe', slug);
      expect(getCurrentStep(corpRoot, slug)).toBe('chit-t-cafebabe');
    });
  });

  describe('advanceCurrentStep', () => {
    it('updates currentStep + sets lastAdvanced ISO timestamp', () => {
      createCasketIfMissing(corpRoot, slug, slug);
      const before = new Date().toISOString();
      advanceCurrentStep(corpRoot, slug, 'chit-t-11111111', slug);

      const hit = findChitById(corpRoot, `casket-${slug}`);
      expect(hit).not.toBeNull();
      const casket = hit!.chit as Chit<'casket'>;
      expect(casket.fields.casket.currentStep).toBe('chit-t-11111111');
      expect(casket.fields.casket.lastAdvanced).toBeDefined();
      expect(casket.fields.casket.lastAdvanced! >= before).toBe(true);
    });

    it('accepts null to clear the pointer (session-exit path)', () => {
      createCasketIfMissing(corpRoot, slug, slug);
      advanceCurrentStep(corpRoot, slug, 'chit-t-abcdef00', slug);
      advanceCurrentStep(corpRoot, slug, null, slug);
      expect(getCurrentStep(corpRoot, slug)).toBeNull();
    });
  });

  describe('incrementSessionCount', () => {
    it('starts at 0, bumps by 1 each call', () => {
      createCasketIfMissing(corpRoot, slug, slug);
      incrementSessionCount(corpRoot, slug, slug);
      let casket = findChitById(corpRoot, `casket-${slug}`)!.chit as Chit<'casket'>;
      expect(casket.fields.casket.sessionCount).toBe(1);

      incrementSessionCount(corpRoot, slug, slug);
      casket = findChitById(corpRoot, `casket-${slug}`)!.chit as Chit<'casket'>;
      expect(casket.fields.casket.sessionCount).toBe(2);
    });

    it('preserves currentStep when bumping sessionCount', () => {
      createCasketIfMissing(corpRoot, slug, slug);
      advanceCurrentStep(corpRoot, slug, 'chit-t-persistent', slug);
      incrementSessionCount(corpRoot, slug, slug);
      expect(getCurrentStep(corpRoot, slug)).toBe('chit-t-persistent');
    });
  });
});
