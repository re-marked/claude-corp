import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  quoteForWindowsCmd,
  CMD_UNSAFE_PATTERN,
  findExecutableInPath,
} from '../../packages/daemon/src/harness/spawn-utils.js';

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

describe('findExecutableInPath', () => {
  const isWindows = process.platform === 'win32';
  const sep = isWindows ? ';' : ':';
  const TEST_ROOT = join(tmpdir(), 'cc-spawn-utils-test');
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    if (existsSyncSafe(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (existsSyncSafe(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  });

  function makeBinaryFile(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, isWindows ? 'fake' : '#!/bin/sh\necho fake', { mode: 0o755 });
    return path;
  }

  function existsSyncSafe(p: string): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('node:fs').existsSync(p);
    } catch {
      return false;
    }
  }

  describe('found cases', () => {
    it('returns absolute path when binary exists in a PATH directory', () => {
      const dir = join(TEST_ROOT, 'bin');
      const ext = isWindows ? '.exe' : '';
      const expected = makeBinaryFile(dir, `mybinary${ext}`);
      process.env.PATH = `${dir}${sep}${originalPath ?? ''}`;
      expect(findExecutableInPath('mybinary')).toBe(expected);
    });

    it('honors PATH order — first match wins', () => {
      const dir1 = join(TEST_ROOT, 'first');
      const dir2 = join(TEST_ROOT, 'second');
      const ext = isWindows ? '.exe' : '';
      const firstPath = makeBinaryFile(dir1, `tool${ext}`);
      makeBinaryFile(dir2, `tool${ext}`);
      process.env.PATH = `${dir1}${sep}${dir2}`;
      expect(findExecutableInPath('tool')).toBe(firstPath);
    });

    if (isWindows) {
      it('tries PATHEXT extensions on Windows (.exe before .cmd)', () => {
        const dir = join(TEST_ROOT, 'mixed');
        const exePath = makeBinaryFile(dir, 'mytool.exe');
        makeBinaryFile(dir, 'mytool.cmd');
        process.env.PATH = `${dir}${sep}${originalPath ?? ''}`;
        expect(findExecutableInPath('mytool')).toBe(exePath);
      });

      it('finds .cmd shims when no .exe exists', () => {
        const dir = join(TEST_ROOT, 'cmd-only');
        const cmdPath = makeBinaryFile(dir, 'shimtool.cmd');
        process.env.PATH = `${dir}${sep}${originalPath ?? ''}`;
        expect(findExecutableInPath('shimtool')).toBe(cmdPath);
      });

      it('finds .bat scripts when present', () => {
        const dir = join(TEST_ROOT, 'bat-only');
        const batPath = makeBinaryFile(dir, 'batchtool.bat');
        process.env.PATH = `${dir}${sep}${originalPath ?? ''}`;
        expect(findExecutableInPath('batchtool')).toBe(batPath);
      });

      it('finds bare-name files (no extension) as last resort', () => {
        const dir = join(TEST_ROOT, 'bare');
        const bare = makeBinaryFile(dir, 'plaintool');
        process.env.PATH = `${dir}${sep}${originalPath ?? ''}`;
        expect(findExecutableInPath('plaintool')).toBe(bare);
      });
    }
  });

  describe('not-found cases', () => {
    it('returns null when binary is not in any PATH directory', () => {
      process.env.PATH = TEST_ROOT;
      expect(findExecutableInPath('nonexistent-binary-xyz')).toBeNull();
    });

    it('returns null when PATH is empty', () => {
      process.env.PATH = '';
      expect(findExecutableInPath('anything')).toBeNull();
    });

    it('returns null when PATH env is missing entirely', () => {
      delete process.env.PATH;
      expect(findExecutableInPath('anything')).toBeNull();
    });

    it('skips empty PATH segments without crashing', () => {
      const dir = join(TEST_ROOT, 'with-blanks');
      const ext = isWindows ? '.exe' : '';
      const path = makeBinaryFile(dir, `realtool${ext}`);
      process.env.PATH = `${sep}${sep}${dir}${sep}${sep}`;
      expect(findExecutableInPath('realtool')).toBe(path);
    });
  });

  describe('robustness', () => {
    it('survives PATH entries that point to nonexistent directories', () => {
      const goodDir = join(TEST_ROOT, 'real');
      const ext = isWindows ? '.exe' : '';
      const path = makeBinaryFile(goodDir, `mytool${ext}`);
      process.env.PATH = `${join(TEST_ROOT, 'does', 'not', 'exist')}${sep}${goodDir}`;
      expect(findExecutableInPath('mytool')).toBe(path);
    });

    it('does not match directories with the same name', () => {
      const dir = join(TEST_ROOT, 'tricky');
      mkdirSync(join(dir, 'mytool'), { recursive: true });
      // Directory named 'mytool' but no executable file
      process.env.PATH = `${dir}${sep}${originalPath ?? ''}`;
      // Should NOT return the directory path
      const result = findExecutableInPath('mytool');
      // On POSIX, may return null. On Windows, may return null (no PATHEXT match for a dir).
      // What we DON'T want is the dir path itself returned.
      if (result !== null) {
        expect(result).not.toBe(join(dir, 'mytool'));
      }
    });
  });
});
