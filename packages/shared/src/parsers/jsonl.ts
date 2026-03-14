import { readFileSync, appendFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
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

/** Read new lines from a JSONL file starting at a byte offset. */
export function readNewLines(
  filePath: string,
  fromByte: number,
): { messages: ChannelMessage[]; newOffset: number } {
  if (!existsSync(filePath)) return { messages: [], newOffset: fromByte };

  const fileSize = statSync(filePath).size;
  if (fileSize <= fromByte) return { messages: [], newOffset: fromByte };

  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(fileSize - fromByte);
    readSync(fd, buf, 0, buf.length, fromByte);
    const chunk = buf.toString('utf-8');

    // Only process complete lines (ignore trailing partial line)
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return { messages: [], newOffset: fromByte };

    const complete = chunk.slice(0, lastNewline);
    const lines = complete.split('\n').filter((l) => l.trim().length > 0);
    const messages: ChannelMessage[] = [];

    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as ChannelMessage);
      } catch {
        // Skip malformed lines
      }
    }

    return { messages, newOffset: fromByte + lastNewline + 1 };
  } finally {
    closeSync(fd);
  }
}

/** Get the current byte size of a JSONL file (for initializing offset). */
export function getFileSize(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  return statSync(filePath).size;
}

export function tailMessages(filePath: string, n: number): ChannelMessage[] {
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const tail = lines.slice(-n);

  return tail.map((line) => JSON.parse(line) as ChannelMessage);
}
