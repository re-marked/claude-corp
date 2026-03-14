import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import type { ChannelMessage } from '../types/index.js';

export function appendMessage(filePath: string, message: ChannelMessage): void {
  const line = JSON.stringify(message) + '\n';
  appendFileSync(filePath, line, 'utf-8');
}

export function readMessages(
  filePath: string,
  opts?: { after?: string },
): ChannelMessage[] {
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const messages: ChannelMessage[] = [];

  let pastCursor = !opts?.after;

  for (const line of lines) {
    const msg = JSON.parse(line) as ChannelMessage;
    if (!pastCursor) {
      if (msg.id === opts!.after) pastCursor = true;
      continue;
    }
    messages.push(msg);
  }

  return messages;
}

export function tailMessages(filePath: string, n: number): ChannelMessage[] {
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const tail = lines.slice(-n);

  return tail.map((line) => JSON.parse(line) as ChannelMessage);
}
