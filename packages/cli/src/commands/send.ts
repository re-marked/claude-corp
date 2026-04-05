import { join } from 'node:path';
import {
  type Member,
  readNewLines,
  getFileSize,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { getClient, getCorpRoot, resolveChannel, getMembers, getFounder } from '../client.js';

export async function cmdSend(opts: {
  channel: string;
  message: string;
  from?: string;
  wait: boolean;
  timeout: number;
  json: boolean;
}) {
  if (!opts.channel) {
    console.error('--channel is required');
    process.exit(1);
  }
  if (!opts.message) {
    console.error('--message is required');
    process.exit(1);
  }

  // --from is MANDATORY. Prevents misattribution.
  // Agents calling cc-cli send without --from get a clear error
  // teaching them to use cc-cli say instead.
  if (!opts.from) {
    console.error('ERROR: --from is required.');
    console.error('');
    console.error('  cc-cli send --channel general --from founder --message "hello"');
    console.error('');
    console.error('If you are an AGENT, do NOT use cc-cli send.');
    console.error('Use cc-cli say instead — it handles attribution correctly:');
    console.error('  cc-cli say --agent <target> --message "your message"');
    process.exit(1);
  }

  const client = getClient();
  const corpRoot = await getCorpRoot();
  const channel = resolveChannel(corpRoot, opts.channel);
  const founder = getFounder(corpRoot);
  const members = getMembers(corpRoot);
  const messagesPath = join(corpRoot, channel.path, MESSAGES_JSONL);

  // Resolve --from to a member ID
  const fromMember = members.find((m: Member) =>
    m.id === opts.from || m.displayName.toLowerCase().replace(/\s+/g, '-') === opts.from!.toLowerCase() || (opts.from === 'founder' && m.rank === 'owner'),
  );
  if (!fromMember) {
    console.error(`Unknown sender: "${opts.from}". Use "founder" or a member name/ID.`);
    process.exit(1);
  }

  // Record byte offset BEFORE sending (for --wait)
  let offsetBefore = 0;
  if (opts.wait) {
    try {
      offsetBefore = getFileSize(messagesPath);
    } catch {}
  }

  const result = await client.sendMessage(channel.id, opts.message, fromMember.id);

  if (opts.json && !opts.wait) {
    console.log(JSON.stringify(result));
    return;
  }

  if (!opts.wait) {
    console.log(`Sent to #${channel.name}.`);
    if (result.dispatching) {
      console.log(`Dispatching to: ${result.dispatchTargets.join(', ')}`);
    }
    return;
  }

  // --wait mode: poll for agent response
  if (!result.dispatching) {
    console.log(`Sent to #${channel.name}. No agent dispatch expected.`);
    return;
  }

  console.error(`Sent to #${channel.name}. Waiting for response from ${result.dispatchTargets.join(', ')}...`);

  const deadline = Date.now() + opts.timeout * 1000;
  const pollInterval = 2000;
  let currentOffset = offsetBefore;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    try {
      const { messages: newMsgs, newOffset } = readNewLines(messagesPath, currentOffset);
      currentOffset = newOffset;

      // Look for text messages from agents (not the founder, not system)
      for (const msg of newMsgs) {
        if (msg.senderId === founder.id) continue;
        if (msg.senderId === 'system') continue;
        if (msg.kind !== 'text') continue;

        const sender = members.find((m: Member) => m.id === msg.senderId);
        const name = sender?.displayName ?? msg.senderId;

        if (opts.json) {
          console.log(JSON.stringify({ sender: name, content: msg.content, timestamp: msg.timestamp }));
        } else {
          console.log(`\n[${name}] ${msg.content}`);
        }
        process.exit(0);
      }
    } catch {}
  }

  console.error(`No response within ${opts.timeout}s.`);
  process.exit(1);
}
