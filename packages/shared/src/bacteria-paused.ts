/**
 * Bacteria pause registry — corp-scope set of role ids the bacteria
 * decision module skips entirely (no mitose, no apoptose). Founder-
 * controlled via `cc-cli bacteria pause/resume`. Lives at
 * `<corpRoot>/bacteria-paused.json` with shape `{ paused: string[] }`.
 *
 * Why a tiny JSON file vs a chit type:
 *
 *   The pause set is read on every bacteria tick (every 5s by
 *   default) — querying the chit store on each tick would be wasteful.
 *   The set is small (one entry per paused role, rare in practice),
 *   the schema is trivial, and the chit-create-then-close-on-resume
 *   ceremony adds nothing meaningful. Plain JSON is the right shape
 *   for runtime config; chits are for work records.
 *
 * Project 1.10.4.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeConfig } from './parsers/config.js';
import { BACTERIA_PAUSED_JSON } from './constants.js';

interface PausedRolesFile {
  paused: string[];
}

/**
 * Return the set of currently-paused role ids. Empty set when the
 * file doesn't exist (the steady-state for most corps) or is
 * corrupted (defense-in-depth — a bad pause file shouldn't freeze
 * bacteria for every role).
 */
export function readPausedRoles(corpRoot: string): Set<string> {
  const path = join(corpRoot, BACTERIA_PAUSED_JSON);
  if (!existsSync(path)) return new Set();
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PausedRolesFile>;
    if (!parsed || !Array.isArray(parsed.paused)) return new Set();
    return new Set(parsed.paused.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * Add `roleId` to the paused set. Idempotent — already-paused roles
 * stay paused without throwing.
 */
export function pauseRole(corpRoot: string, roleId: string): void {
  const paused = readPausedRoles(corpRoot);
  paused.add(roleId);
  writePausedRoles(corpRoot, paused);
}

/**
 * Remove `roleId` from the paused set. Idempotent — resuming a role
 * that wasn't paused is a no-op.
 */
export function resumeRole(corpRoot: string, roleId: string): void {
  const paused = readPausedRoles(corpRoot);
  if (!paused.has(roleId)) return;
  paused.delete(roleId);
  writePausedRoles(corpRoot, paused);
}

function writePausedRoles(corpRoot: string, paused: Set<string>): void {
  const path = join(corpRoot, BACTERIA_PAUSED_JSON);
  const file: PausedRolesFile = { paused: [...paused].sort() };
  writeConfig(path, file);
}
