/**
 * File Locking System
 *
 * Agents MUST acquire a lock before writing files outside their own agent directory.
 * Locks are stored in {corpRoot}/locks.json and automatically expire after 30 minutes.
 *
 * Usage:
 *   const result = acquireLock(corpRoot, '/path/to/file', memberId, 'Agent Name', 'optional reason');
 *   if (!result.ok) throw new Error(`File locked by ${result.lock?.lockedByName}`);
 *   // ... do your write ...
 *   releaseLock(corpRoot, '/path/to/file', memberId);
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { FileLock, LocksFile } from './types/lock.js';

/** Stale lock threshold — 30 minutes */
export const LOCK_STALE_MS = 30 * 60 * 1000;

const LOCKS_FILE = 'locks.json';

function locksPath(corpRoot: string): string {
  return join(corpRoot, LOCKS_FILE);
}

function normalizePath(filePath: string): string {
  return normalize(filePath).replace(/\\/g, '/');
}

function readLocksFile(corpRoot: string): LocksFile {
  const p = locksPath(corpRoot);
  if (!existsSync(p)) {
    return { locks: {}, updatedAt: new Date().toISOString() };
  }
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as LocksFile;
  } catch {
    return { locks: {}, updatedAt: new Date().toISOString() };
  }
}

function writeLocksFile(corpRoot: string, data: LocksFile): void {
  writeFileSync(locksPath(corpRoot), JSON.stringify(data, null, 2), 'utf-8');
}

function isStale(lock: FileLock): boolean {
  return Date.now() - new Date(lock.lockedAt).getTime() > LOCK_STALE_MS;
}

export interface AcquireResult {
  ok: boolean;
  /** Existing lock that blocked acquisition (if ok=false) */
  lock?: FileLock;
}

/**
 * Attempt to acquire a lock on `filePath`.
 * Returns { ok: true } if acquired (or already owned by this agent).
 * Returns { ok: false, lock } if another agent holds a fresh lock.
 * Stale locks (>30 min) are automatically evicted and the lock is granted.
 */
export function acquireLock(
  corpRoot: string,
  filePath: string,
  memberId: string,
  memberName: string,
  reason?: string,
): AcquireResult {
  const key = normalizePath(filePath);
  const data = readLocksFile(corpRoot);
  const existing = data.locks[key];

  if (existing) {
    // Already owned by this agent — refresh timestamp
    if (existing.lockedBy === memberId) {
      existing.lockedAt = new Date().toISOString();
      if (reason) existing.reason = reason;
      data.updatedAt = new Date().toISOString();
      writeLocksFile(corpRoot, data);
      return { ok: true };
    }

    // Another agent holds a fresh lock — deny
    if (!isStale(existing)) {
      return { ok: false, lock: existing };
    }

    // Stale lock — evict and continue
  }

  // Grant the lock
  const newLock: FileLock = {
    filePath: key,
    lockedBy: memberId,
    lockedByName: memberName,
    lockedAt: new Date().toISOString(),
    reason,
  };
  data.locks[key] = newLock;
  data.updatedAt = new Date().toISOString();
  writeLocksFile(corpRoot, data);
  return { ok: true };
}

/**
 * Release a lock held by `memberId`. No-op if no lock or wrong owner.
 * Returns true if the lock was released, false otherwise.
 */
export function releaseLock(corpRoot: string, filePath: string, memberId: string): boolean {
  const key = normalizePath(filePath);
  const data = readLocksFile(corpRoot);
  const existing = data.locks[key];

  if (!existing || existing.lockedBy !== memberId) {
    return false;
  }

  delete data.locks[key];
  data.updatedAt = new Date().toISOString();
  writeLocksFile(corpRoot, data);
  return true;
}

/**
 * Check if a file is currently locked (by another agent).
 * Returns the lock record if locked by someone else, or null if free / stale.
 */
export function checkLock(
  corpRoot: string,
  filePath: string,
  requestingMemberId?: string,
): FileLock | null {
  const key = normalizePath(filePath);
  const data = readLocksFile(corpRoot);
  const lock = data.locks[key];

  if (!lock) return null;
  if (isStale(lock)) return null;
  if (requestingMemberId && lock.lockedBy === requestingMemberId) return null;

  return lock;
}

/**
 * List all active (non-stale) locks.
 */
export function listLocks(corpRoot: string): FileLock[] {
  const data = readLocksFile(corpRoot);
  return Object.values(data.locks).filter((l) => !isStale(l));
}

/**
 * Release ALL locks held by a specific agent (called on agent shutdown/crash).
 */
export function releaseAllLocks(corpRoot: string, memberId: string): number {
  const data = readLocksFile(corpRoot);
  let count = 0;
  for (const [key, lock] of Object.entries(data.locks)) {
    if (lock.lockedBy === memberId) {
      delete data.locks[key];
      count++;
    }
  }
  if (count > 0) {
    data.updatedAt = new Date().toISOString();
    writeLocksFile(corpRoot, data);
  }
  return count;
}

/**
 * Evict all stale locks (older than 30 minutes). Returns count evicted.
 */
export function evictStaleLocks(corpRoot: string): number {
  const data = readLocksFile(corpRoot);
  let count = 0;
  for (const [key, lock] of Object.entries(data.locks)) {
    if (isStale(lock)) {
      delete data.locks[key];
      count++;
    }
  }
  if (count > 0) {
    data.updatedAt = new Date().toISOString();
    writeLocksFile(corpRoot, data);
  }
  return count;
}
