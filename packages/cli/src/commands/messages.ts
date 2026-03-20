import { join } from 'node:path';
import { tailMessages, MESSAGES_JSONL } from '@claudecorp/shared';
import { getCorpRoot, resolveChannel, getMembers } from '../client.js';

export async function cmdMessages(opts: { channel: string; last: number; json: boolean }) {
  if (!opts.channel) {
    console.error('--channel is required');
    process.exit(1);
  }

  const corpRoot = await getCorpRoot();
  const channel = resolveChannel(corpRoot, opts.channel);
  const members = getMembers(corpRoot);
  const messagesPath = join(corpRoot, channel.path, MESSAGES_JSONL);

  const messages = tailMessages(messagesPath, opts.last);

  if (opts.json) {
    const formatted = messages.map((m) => {
      const sender = members.find((mem) => mem.id === m.senderId);
      return {
        sender: sender?.displayName ?? m.senderId,
        kind: m.kind,
        content: m.content,
        timestamp: m.timestamp,
      };
    });
    console.log(JSON.stringify(formatted, null, 2));
    return;
  }

  if (messages.length === 0) {
    console.log(`No messages in #${channel.name}`);
    return;
  }

  console.log(`#${channel.name} — last ${messages.length} messages:\n`);
  for (const msg of messages) {
    const sender = members.find((m) => m.id === msg.senderId);
    const name = sender?.displayName ?? msg.senderId;
    const time = new Date(msg.timestamp).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
    const prefix = msg.kind === 'system' ? '  \u250A' : ' ';
    console.log(`${prefix} [${time}] ${name}: ${msg.content}`);
  }
}
