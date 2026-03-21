import { appendFileSync } from 'node:fs';
import { DAEMON_LOG_PATH } from '@claudecorp/shared';

/** When true, logs go to file only (no console). Set by TUI on startup. */
let silentMode = false;

export function setSilentMode(silent: boolean): void {
  silentMode = silent;
}

/** Log to file (and console if not in silent mode). */
export function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}`;
  if (!silentMode) console.log(message);
  try {
    appendFileSync(DAEMON_LOG_PATH, line + '\n', 'utf-8');
  } catch {}
}

export function logError(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ERROR ${message}`;
  if (!silentMode) console.error(message);
  try {
    appendFileSync(DAEMON_LOG_PATH, line + '\n', 'utf-8');
  } catch {}
}
