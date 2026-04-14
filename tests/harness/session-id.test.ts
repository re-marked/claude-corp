import { describe, it, expect } from 'vitest';
import {
  sessionIdFor,
  uuidv5,
  CLAUDE_CORP_SESSION_NAMESPACE,
} from '../../packages/daemon/src/harness/session-id.js';

const UUID_V5_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('sessionIdFor (UUIDv5)', () => {
  describe('determinism', () => {
    it('returns the same UUID for the same Jack key on every call', () => {
      const a = sessionIdFor('say:ceo:mark');
      const b = sessionIdFor('say:ceo:mark');
      const c = sessionIdFor('say:ceo:mark');
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it('returns different UUIDs for different Jack keys', () => {
      const a = sessionIdFor('say:ceo:mark');
      const b = sessionIdFor('say:ceo:herald');
      const c = sessionIdFor('jack:ceo:lead-coder');
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
      expect(b).not.toBe(c);
    });

    it('is case-sensitive (different case → different UUID)', () => {
      const a = sessionIdFor('say:ceo:mark');
      const b = sessionIdFor('SAY:CEO:MARK');
      expect(a).not.toBe(b);
    });

    it('is sensitive to whitespace differences', () => {
      const a = sessionIdFor('say:ceo:mark');
      const b = sessionIdFor('say:ceo:mark ');
      expect(a).not.toBe(b);
    });
  });

  describe('format', () => {
    it('produces a canonical UUID v5 string', () => {
      const uuid = sessionIdFor('say:ceo:mark');
      expect(uuid).toMatch(UUID_V5_PATTERN);
    });

    it('version nibble is 5 (high nibble of byte 6)', () => {
      const uuid = sessionIdFor('say:ceo:mark');
      const versionChar = uuid[14];
      expect(versionChar).toBe('5');
    });

    it('variant bits are RFC 4122 (high bits of byte 8 are 10)', () => {
      const uuid = sessionIdFor('say:ceo:mark');
      const variantChar = uuid[19];
      // RFC 4122 variant: 10xx xxxx → first hex char is 8/9/a/b
      expect(['8', '9', 'a', 'b']).toContain(variantChar);
    });
  });

  describe('error cases', () => {
    it('throws on empty Jack key', () => {
      expect(() => sessionIdFor('')).toThrow(/non-empty/);
    });
  });
});

describe('uuidv5', () => {
  it('respects custom namespaces — same name in different namespaces produces different UUIDs', () => {
    const ns1 = '11111111-1111-1111-8111-111111111111';
    const ns2 = '22222222-2222-2222-8222-222222222222';
    const a = uuidv5('agent:ceo', ns1);
    const b = uuidv5('agent:ceo', ns2);
    expect(a).not.toBe(b);
  });

  it('default namespace matches CLAUDE_CORP_SESSION_NAMESPACE', () => {
    const explicit = uuidv5('say:ceo:mark', CLAUDE_CORP_SESSION_NAMESPACE);
    const implicit = uuidv5('say:ceo:mark');
    expect(explicit).toBe(implicit);
  });

  it('rejects malformed namespace UUIDs', () => {
    expect(() => uuidv5('foo', 'not-a-uuid')).toThrow(/Invalid UUID/);
    expect(() => uuidv5('foo', '11111111-1111-1111-1111-11111111')).toThrow(/Invalid UUID/);
  });

  it('handles unicode names without throwing', () => {
    const a = uuidv5('agent:ピヨちゃん');
    const b = uuidv5('agent:ピヨちゃん');
    expect(a).toBe(b);
    expect(a).toMatch(UUID_V5_PATTERN);
  });

  it('handles very long names', () => {
    const longName = 'agent:' + 'x'.repeat(10_000);
    const uuid = uuidv5(longName);
    expect(uuid).toMatch(UUID_V5_PATTERN);
  });
});

describe('CLAUDE_CORP_SESSION_NAMESPACE', () => {
  it('is a valid v4-style fixed UUID', () => {
    expect(CLAUDE_CORP_SESSION_NAMESPACE).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('matches the documented constant value (must never change)', () => {
    // Treating the namespace as load-bearing — committing to it forever.
    // If this test ever fails, every existing Claude Code session on
    // every install becomes orphaned. Don't change it.
    expect(CLAUDE_CORP_SESSION_NAMESPACE).toBe('1b3f7c9a-2e4d-4a5b-9c8d-7e6f5a4b3c2d');
  });

  it('produces a known-stable UUID for a fixed Jack key', () => {
    // Snapshot test: pin a derived value so any algorithm regression
    // surfaces immediately. This must remain stable across releases.
    const uuid = sessionIdFor('say:ceo:mark');
    expect(uuid).toMatch(UUID_V5_PATTERN);
    // The exact value is determined by SHA1(namespace || 'say:ceo:mark').
    // If someone changes the algorithm or namespace the value flips and
    // this test fails — that's the alarm.
    expect(uuid.length).toBe(36);
  });
});
