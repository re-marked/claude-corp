import { readFileSync, existsSync } from 'node:fs';
import { DAEMON_LOG_PATH } from '@claudecorp/shared';

export async function cmdLogs(opts: { last: number }) {
  if (!existsSync(DAEMON_LOG_PATH)) {
    console.log('No daemon log file found.');
    return;
  }

  const content = readFileSync(DAEMON_LOG_PATH, 'utf-8');
  const lines = content.trim().split('\n');
  const tail = lines.slice(-opts.last);
  console.log(tail.join('\n'));
}
