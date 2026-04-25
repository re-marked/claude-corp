import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pauseRole,
  readPausedRoles,
  resumeRole,
} from '../packages/shared/src/index.js';

/**
 * Coverage for the bacteria pause registry (Project 1.10.4).
 * Read returns Set<string> with empty-set for missing/corrupt;
 * pause/resume are idempotent.
 */

describe('bacteria pause registry', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'bacteria-paused-'));
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      /* Windows */
    }
  });

  it('readPausedRoles returns empty set when file missing', () => {
    const paused = readPausedRoles(corpRoot);
    expect(paused.size).toBe(0);
  });

  it('readPausedRoles returns empty set on corrupted JSON', () => {
    writeFileSync(join(corpRoot, 'bacteria-paused.json'), '{ this is not json {{{', 'utf-8');
    const paused = readPausedRoles(corpRoot);
    expect(paused.size).toBe(0);
  });

  it('readPausedRoles returns empty set when shape is wrong', () => {
    writeFileSync(join(corpRoot, 'bacteria-paused.json'), '{"paused":"not-an-array"}', 'utf-8');
    const paused = readPausedRoles(corpRoot);
    expect(paused.size).toBe(0);
  });

  it('pauseRole + readPausedRoles round-trip', () => {
    pauseRole(corpRoot, 'backend-engineer');
    pauseRole(corpRoot, 'qa-engineer');
    const paused = readPausedRoles(corpRoot);
    expect(paused.has('backend-engineer')).toBe(true);
    expect(paused.has('qa-engineer')).toBe(true);
    expect(paused.size).toBe(2);
  });

  it('pauseRole is idempotent', () => {
    pauseRole(corpRoot, 'backend-engineer');
    pauseRole(corpRoot, 'backend-engineer');
    pauseRole(corpRoot, 'backend-engineer');
    const paused = readPausedRoles(corpRoot);
    expect(paused.size).toBe(1);
  });

  it('resumeRole removes a paused role', () => {
    pauseRole(corpRoot, 'backend-engineer');
    pauseRole(corpRoot, 'qa-engineer');
    resumeRole(corpRoot, 'backend-engineer');
    const paused = readPausedRoles(corpRoot);
    expect(paused.has('backend-engineer')).toBe(false);
    expect(paused.has('qa-engineer')).toBe(true);
  });

  it('resumeRole on a not-paused role is a no-op', () => {
    expect(() => resumeRole(corpRoot, 'never-paused')).not.toThrow();
    const paused = readPausedRoles(corpRoot);
    expect(paused.size).toBe(0);
  });
});
