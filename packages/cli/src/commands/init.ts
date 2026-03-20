import {
  scaffoldCorp,
  setupCeo,
  ensureGlobalConfig,
  appendMessage,
  generateId,
  type ThemeId,
  type ChannelMessage,
} from '@claudecorp/shared';
import { join } from 'node:path';

export async function cmdInit(opts: { name: string; user: string; theme: string }) {
  if (!opts.name) {
    console.error('--name is required');
    process.exit(1);
  }
  if (!opts.user) {
    console.error('--user is required');
    process.exit(1);
  }

  const themeId = (opts.theme || 'corporate') as ThemeId;
  console.log(`Creating corporation "${opts.name}" for ${opts.user} (${themeId} theme)...`);

  const globalConfig = ensureGlobalConfig();
  const corpRoot = await scaffoldCorp(opts.name, opts.user, themeId);
  console.log(`Corp directory: ${corpRoot}`);

  const { dmChannel } = setupCeo(corpRoot, globalConfig, opts.user);
  console.log(`CEO created. DM channel: ${dmChannel.name}`);

  // Write kickoff system message (same as onboarding)
  const dmPath = join(corpRoot, dmChannel.path, 'messages.jsonl');
  const kickoff: ChannelMessage = {
    id: generateId(),
    channelId: dmChannel.id,
    senderId: 'system',
    threadId: null,
    content: `New corporation "${opts.name}" created. The Founder is here. Introduce yourself and begin the onboarding interview — ask what they want this corporation to accomplish.`,
    kind: 'text',
    mentions: [],
    metadata: null,
    depth: 0,
    originId: '',
    timestamp: new Date().toISOString(),
  };
  kickoff.originId = kickoff.id;
  appendMessage(dmPath, kickoff);

  console.log(`\nCorporation "${opts.name}" ready.`);
  console.log(`Start the daemon: claudecorp-cli start`);
}
