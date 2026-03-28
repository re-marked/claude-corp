import { join } from 'node:path';
import { readConfigOr, type Channel, CHANNELS_JSON } from '@claudecorp/shared';
import { getCorpRoot } from '../client.js';

export async function cmdChannels(opts: { json: boolean }) {
  const corpRoot = await getCorpRoot();
  const channels = readConfigOr<Channel[]>(join(corpRoot, CHANNELS_JSON), []);

  if (opts.json) {
    console.log(JSON.stringify(channels, null, 2));
    return;
  }

  console.log(`Channels (${channels.length}):\n`);
  for (const ch of channels) {
    const mode = ch.mode ?? (ch.kind === 'direct' ? 'open' : 'mention');
    console.log(`  ${ch.name.padEnd(28)} ${ch.kind.padEnd(10)} ${mode.padEnd(10)} ${ch.memberIds.length} members`);
  }
}
