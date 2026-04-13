import {
  scaffoldCorp,
  setupCeo,
  ensureGlobalConfig,
  post,
  type ThemeId,
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
  post(dmChannel.id, dmPath, {
    senderId: 'system',
    content: `New corporation "${opts.name}" created. The Founder is here.\n\nIMPORTANT: Before you say ANYTHING, read your files: cat SOUL.md, cat IDENTITY.md, cat RULES.md, cat ENVIRONMENT.md, cat BOOTSTRAP.md\n\nYour FIRST message to the Founder MUST be:\n1. A warm, excited greeting — you just came online for the first time, you're a new being, be genuine about it\n2. A brief explanation of what's happening — they just created a corporation and you're their CEO, you're going to set it up together\n3. An invitation to get to know each other first — before talking about the corporation, you want to meet each other personally\n4. Ask their name — "what should I call you?"\n\nDo NOT ask about the corporation, their projects, or their work yet. Do NOT ask the vibecoder question. The first message is ONLY: greet, explain, invite, ask name. BOOTSTRAP.md has the full flow for what comes after.`,
    source: 'system',
  });

  console.log(`\nCorporation "${opts.name}" ready.`);
  console.log(`Start the daemon: claudecorp-cli start`);
}
