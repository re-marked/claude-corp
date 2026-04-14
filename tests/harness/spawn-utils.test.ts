import { describe, it, expect } from 'vitest';
import { quoteForWindowsCmd, CMD_UNSAFE_PATTERN } from '../../packages/daemon/src/harness/spawn-utils.js';

describe('quoteForWindowsCmd', () => {
  describe('no-op cases', () => {
    it('returns plain words unchanged', () => {
      expect(quoteForWindowsCmd('claude')).toBe('claude');
      expect(quoteForWindowsCmd('--session-id')).toBe('--session-id');
      expect(quoteForWindowsCmd('abc123')).toBe('abc123');
    });

    it('returns UUIDs unchanged (hex + hyphens only)', () => {
      expect(quoteForWindowsCmd('1b3f7c9a-2e4d-4a5b-9c8d-7e6f5a4b3c2d'))
        .toBe('1b3f7c9a-2e4d-4a5b-9c8d-7e6f5a4b3c2d');
    });

    it('returns flag-style args unchanged', () => {
      expect(quoteForWindowsCmd('--output-format')).toBe('--output-format');
      expect(quoteForWindowsCmd('stream-json')).toBe('stream-json');
      expect(quoteForWindowsCmd('-p')).toBe('-p');
    });

    it('returns unix-style paths without spaces unchanged', () => {
      expect(quoteForWindowsCmd('/tmp/workspace')).toBe('/tmp/workspace');
    });

    it('returns windows-style paths without spaces unchanged', () => {
      expect(quoteForWindowsCmd('C:\\Users\\psyhik1769\\agent'))
        .toBe('C:\\Users\\psyhik1769\\agent');
    });
  });

  describe('empty string', () => {
    it('wraps empty string in "" so it survives shell tokenization', () => {
      expect(quoteForWindowsCmd('')).toBe('""');
    });
  });

  describe('whitespace', () => {
    it('wraps args containing spaces', () => {
      expect(quoteForWindowsCmd('foo bar')).toBe('"foo bar"');
    });

    it('wraps paths with spaces', () => {
      expect(quoteForWindowsCmd('C:\\Users\\Jane Doe\\agent'))
        .toBe('"C:\\Users\\Jane Doe\\agent"');
    });

    it('wraps args containing tabs', () => {
      expect(quoteForWindowsCmd('foo\tbar')).toBe('"foo\tbar"');
    });

    it('wraps args containing newlines', () => {
      expect(quoteForWindowsCmd('line1\nline2')).toBe('"line1\nline2"');
    });
  });

  describe('double quotes', () => {
    it('wraps args containing double quotes and doubles them (cmd.exe escape)', () => {
      expect(quoteForWindowsCmd('say "hi"')).toBe('"say ""hi"""');
    });

    it('handles a bare double-quote arg', () => {
      expect(quoteForWindowsCmd('"')).toBe('""""');
    });

    it('handles multiple embedded quotes', () => {
      expect(quoteForWindowsCmd('a"b"c')).toBe('"a""b""c"');
    });
  });

  describe('cmd.exe metacharacters', () => {
    it('wraps args containing ampersand (command chaining)', () => {
      expect(quoteForWindowsCmd('a&b')).toBe('"a&b"');
    });

    it('wraps args containing pipe', () => {
      expect(quoteForWindowsCmd('a|b')).toBe('"a|b"');
    });

    it('wraps args containing redirect operators', () => {
      expect(quoteForWindowsCmd('a<b')).toBe('"a<b"');
      expect(quoteForWindowsCmd('a>b')).toBe('"a>b"');
    });

    it('wraps args containing caret (cmd escape char)', () => {
      expect(quoteForWindowsCmd('a^b')).toBe('"a^b"');
    });

    it('wraps args containing percent (env var reference)', () => {
      expect(quoteForWindowsCmd('a%PATH%')).toBe('"a%PATH%"');
    });
  });

  describe('real-world harness args', () => {
    it('keeps harness flag args unchanged (no metacharacters)', () => {
      const args = [
        '-p',
        '--session-id', '1b3f7c9a-2e4d-4a5b-9c8d-7e6f5a4b3c2d',
        '--output-format', 'stream-json',
        '--include-partial-messages',
      ];
      for (const arg of args) {
        expect(quoteForWindowsCmd(arg)).toBe(arg);
      }
    });

    it('wraps typical Windows agent workspace paths safely', () => {
      const path = 'C:\\Users\\psyhik1769\\.claudecorp\\hc-test\\agents\\ceo';
      // No space or metacharacter → unchanged
      expect(quoteForWindowsCmd(path)).toBe(path);
    });

    it('wraps Windows paths with spaces (OneDrive, Program Files, etc.)', () => {
      const path = 'C:\\Users\\Jane Doe\\OneDrive\\.claudecorp\\corp\\agents\\ceo';
      expect(quoteForWindowsCmd(path)).toBe(`"${path}"`);
    });
  });
});

describe('CMD_UNSAFE_PATTERN', () => {
  it('matches each documented metacharacter', () => {
    for (const char of [' ', '\t', '\n', '"', '&', '|', '<', '>', '^', '%']) {
      expect(CMD_UNSAFE_PATTERN.test(`a${char}b`)).toBe(true);
    }
  });

  it('does not match plain safe characters', () => {
    for (const char of ['a', 'Z', '5', '-', '_', '/', '\\', ':', '.', '@', '#', '!', '(', ')']) {
      expect(CMD_UNSAFE_PATTERN.test(char)).toBe(false);
    }
  });
});
