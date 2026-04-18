import { describe, it, expect } from 'vitest';
import {
  detectFeedback,
  FEEDBACK_PATTERN_COUNTS,
} from '../packages/shared/src/feedback-detector.js';

describe('feedback-detector', () => {
  describe('pattern counts', () => {
    it('ships at least 100 correction patterns', () => {
      expect(FEEDBACK_PATTERN_COUNTS.correction).toBeGreaterThanOrEqual(100);
    });

    it('ships at least 100 confirmation patterns', () => {
      expect(FEEDBACK_PATTERN_COUNTS.confirmation).toBeGreaterThanOrEqual(100);
    });
  });

  describe('no-match cases', () => {
    it('returns null for empty input', () => {
      expect(detectFeedback('')).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
      expect(detectFeedback('   \n\t  ')).toBeNull();
    });

    it('returns null for neutral statements', () => {
      expect(detectFeedback('the file is at packages/daemon/src/router.ts')).toBeNull();
    });

    it('returns null for a plain question', () => {
      expect(detectFeedback('what time is the meeting')).toBeNull();
    });
  });

  describe('correction polarity', () => {
    it('catches direct negation', () => {
      const m = detectFeedback("don't do that");
      expect(m?.polarity).toBe('correction');
    });

    it('catches "stop"', () => {
      const m = detectFeedback('stop writing summaries at the end');
      expect(m?.polarity).toBe('correction');
    });

    it('catches "wrong"', () => {
      const m = detectFeedback('this is wrong, try again');
      expect(m?.polarity).toBe('correction');
    });

    it('catches "i told you"', () => {
      const m = detectFeedback('i told you to use pnpm, not npm');
      expect(m?.polarity).toBe('correction');
    });

    it('catches "bruh"', () => {
      const m = detectFeedback('bruh why did you commit that');
      expect(m?.polarity).toBe('correction');
    });

    it('catches redo signals', () => {
      const m = detectFeedback('redo it, this is broken');
      expect(m?.polarity).toBe('correction');
    });

    it('catches too-long / too-verbose style corrections', () => {
      const m = detectFeedback('this is way too verbose, make it shorter');
      expect(m?.polarity).toBe('correction');
    });

    it('catches "not quite"', () => {
      const m = detectFeedback('not quite what I meant');
      expect(m?.polarity).toBe('correction');
    });

    it('catches "nevermind"', () => {
      const m = detectFeedback('nevermind, forget it');
      expect(m?.polarity).toBe('correction');
    });

    it('reports matched pattern names for correction', () => {
      const m = detectFeedback("don't do that, it's wrong");
      expect(m?.matchedPatterns).toContain('dont');
      expect(m?.matchedPatterns).toContain('wrong');
    });
  });

  describe('confirmation polarity', () => {
    it('catches "not bad" as positive (compound beats single negative)', () => {
      const m = detectFeedback('not bad at all');
      expect(m?.polarity).toBe('confirmation');
    });

    it('catches "perfect"', () => {
      const m = detectFeedback('perfect, ship it');
      expect(m?.polarity).toBe('confirmation');
    });

    it('catches "lgtm"', () => {
      const m = detectFeedback('lgtm');
      expect(m?.polarity).toBe('confirmation');
    });

    it('catches "good call"', () => {
      const m = detectFeedback('good call on the refactor');
      expect(m?.polarity).toBe('confirmation');
    });

    it('catches "keep doing that"', () => {
      const m = detectFeedback('yes, keep doing that');
      expect(m?.polarity).toBe('confirmation');
    });

    it('catches fire emoji', () => {
      const m = detectFeedback('🔥');
      expect(m?.polarity).toBe('confirmation');
    });

    it('catches "thanks"', () => {
      const m = detectFeedback('thanks for the fix');
      expect(m?.polarity).toBe('confirmation');
    });

    it('catches "nailed it"', () => {
      const m = detectFeedback('you nailed it');
      expect(m?.polarity).toBe('confirmation');
    });

    it('catches "lets go"', () => {
      const m = detectFeedback("let's goo");
      expect(m?.polarity).toBe('confirmation');
    });

    it('catches trust signal "your call"', () => {
      const m = detectFeedback('your call on that one');
      expect(m?.polarity).toBe('confirmation');
    });
  });

  describe('mixed polarity', () => {
    it('returns mixed when both match', () => {
      const m = detectFeedback("yeah that's good but don't do the other thing");
      expect(m?.polarity).toBe('mixed');
    });

    it('returns mixed for sandwich feedback', () => {
      const m = detectFeedback('nice work, but actually you missed the point');
      expect(m?.polarity).toBe('mixed');
    });
  });

  describe('match payload shape', () => {
    it('always returns arrays for matchedPatterns and matchedText', () => {
      const m = detectFeedback('this is wrong');
      expect(Array.isArray(m?.matchedPatterns)).toBe(true);
      expect(Array.isArray(m?.matchedText)).toBe(true);
      expect(m?.matchedText.length).toBeGreaterThan(0);
    });

    it('case-insensitive matching', () => {
      expect(detectFeedback('WRONG')?.polarity).toBe('correction');
      expect(detectFeedback('PERFECT')?.polarity).toBe('confirmation');
    });
  });
});
