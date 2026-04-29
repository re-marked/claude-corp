import { readFileSync, existsSync } from 'node:fs';
import { getDaemonLogPath } from '@claudecorp/shared';
import { getCorpRoot } from '../client.js';

export async function cmdLogs(opts: { last: number; corp?: string }) {
  const corpRoot = await getCorpRoot(opts.corp);
  const logPath = getDaemonLogPath(corpRoot);

  if (!existsSync(logPath)) {
    console.log(`No daemon log file at ${logPath}.`);
    return;
  }

  const content = readFileSync(logPath, 'utf-8');
  const lines = content.trim().split('\n');
  const tail = lines.slice(-opts.last);
  console.log(tail.join('\n'));
}
