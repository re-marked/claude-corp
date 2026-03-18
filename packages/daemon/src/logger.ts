import { appendFileSync } from 'node:fs';
import { DAEMON_LOG_PATH } from '@claudecorp/shared';

/** Simple logger that writes to both console and daemon log file. */
export function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}`;
  console.log(message);
  try {
    appendFileSync(DAEMON_LOG_PATH, line + '\n', 'utf-8');
  } catch {
    // Non-fatal
  }
}

export function logError(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ERROR ${message}`;
  console.error(message);
  try {
    appendFileSync(DAEMON_LOG_PATH, line + '\n', 'utf-8');
  } catch {
    // Non-fatal
  }
}
