import { appendFileSync } from 'node:fs';
import { getDaemonLogPath } from '@claudecorp/shared';

/** When true, logs go to file only (no console). Set by TUI on startup. */
let silentMode = false;

/**
 * Per-corp log path resolved from the daemon's corp root. Set by
 * Daemon's constructor via `setLogPath(corpRoot)`. When null —
 * before any daemon constructed, or in unit tests that import
 * the logger without a daemon — log()/logError() skip the file
 * write entirely (console-only). That isolation is the whole point
 * of per-corp scoping: test fixtures must NEVER pollute a real
 * corp's `.daemon.log`.
 */
let currentLogPath: string | null = null;

export function setSilentMode(silent: boolean): void {
  silentMode = silent;
}

/**
 * Point the logger at this corp's `.daemon.log`. Daemon's
 * constructor calls this once. Subsequent log() / logError() /
 * sweeper rotation reads the same path. Setting it again
 * (e.g. on a second daemon construction in the same process)
 * overwrites — only one daemon is alive at a time.
 */
export function setLogPath(corpRoot: string): void {
  currentLogPath = getDaemonLogPath(corpRoot);
}

/** Read the current log path. Returns null when no daemon has been constructed yet. */
export function getCurrentLogPath(): string | null {
  return currentLogPath;
}

/** Log to file (and console if not in silent mode). Skips file write when no path set. */
export function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}`;
  if (!silentMode) console.log(message);
  if (currentLogPath === null) return;
  try {
    appendFileSync(currentLogPath, line + '\n', 'utf-8');
  } catch {}
}

export function logError(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ERROR ${message}`;
  if (!silentMode) console.error(message);
  if (currentLogPath === null) return;
  try {
    appendFileSync(currentLogPath, line + '\n', 'utf-8');
  } catch {}
}
