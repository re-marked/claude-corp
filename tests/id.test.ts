import { describe, it, expect } from 'vitest';
import { generateId, taskId } from '../packages/shared/src/id.js';
import { memberSlug } from '../packages/shared/src/mentions.js';

describe('generateId', () => {
  it('produces a 6-char hex string prefixed with m-', () => {
    const id = generateId();
    expect(id).toMatch(/^m-[a-f0-9]{6}$/);
  });

  it('produces unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBeGreaterThanOrEqual(95); // Allow tiny collision chance
  });
});

describe('taskId', () => {
  it('produces a word-pair', () => {
    const id = taskId();
    expect(id).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('produces unique pairs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => taskId()));
    expect(ids.size).toBeGreaterThanOrEqual(45);
  });
});

describe('memberSlug', () => {
  const member = (name: string) => ({ displayName: name } as any);

  it('lowercases and hyphenates', () => {
    expect(memberSlug(member('Lead Coder'))).toBe('lead-coder');
  });

  it('handles single words', () => {
    expect(memberSlug(member('CEO'))).toBe('ceo');
  });

  it('handles names with normal spacing', () => {
    expect(memberSlug(member('Some Agent'))).toBe('some-agent');
  });
});
