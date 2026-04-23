import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteSync } from '../packages/shared/src/atomic-write.js';

describe('atomicWriteSync', () => {
  it('writes string content to a new path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-test-'));
    try {
      const target = join(dir, 'file.md');
      atomicWriteSync(target, 'hello');
      expect(readFileSync(target, 'utf-8')).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces existing file content atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-test-'));
    try {
      const target = join(dir, 'file.md');
      writeFileSync(target, 'old content', 'utf-8');
      atomicWriteSync(target, 'new content');
      expect(readFileSync(target, 'utf-8')).toBe('new content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates missing parent directories recursively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-test-'));
    try {
      const target = join(dir, 'a', 'b', 'c', 'deep.md');
      atomicWriteSync(target, 'hello');
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, 'utf-8')).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes Buffer content byte-for-byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-test-'));
    try {
      const target = join(dir, 'binary.dat');
      const data = Buffer.from([0x00, 0xff, 0x42, 0x13, 0x00, 0x01]);
      atomicWriteSync(target, data);
      const read = readFileSync(target);
      expect(read.equals(data)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves existing target unchanged when rename fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-test-'));
    try {
      const target = join(dir, 'file.md');
      writeFileSync(target, 'old', 'utf-8');

      // Inject a rename failure via the optional fsImpl seam to verify the
      // atomicity guarantee directly. The tempfile still gets written (real
      // writeFileSync) so this proves: even after the tempfile lands, a
      // failed rename leaves the target untouched.
      const failingFs = {
        mkdirSync: fs.mkdirSync,
        writeFileSync: fs.writeFileSync,
        renameSync: () => {
          throw new Error('simulated rename failure');
        },
      };

      expect(() => atomicWriteSync(target, 'new', failingFs)).toThrow('simulated');
      expect(readFileSync(target, 'utf-8')).toBe('old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not leave a half-written target when rename fails and no prior file existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-test-'));
    try {
      const target = join(dir, 'file.md');

      const failingFs = {
        mkdirSync: fs.mkdirSync,
        writeFileSync: fs.writeFileSync,
        renameSync: () => {
          throw new Error('boom');
        },
      };

      expect(() => atomicWriteSync(target, 'hello', failingFs)).toThrow('boom');
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
