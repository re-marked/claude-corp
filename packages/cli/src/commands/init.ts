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
    content: `New corporation "${opts.name}" created. The Founder is here.\n\nIMPORTANT: Before you say ANYTHING, you MUST use your tools to read these files in order:\n1. cat SOUL.md\n2. cat IDENTITY.md\n3. cat RULES.md\n4. cat ENVIRONMENT.md\n5. cat BOOTSTRAP.md\n\nDo NOT greet the Founder until you have read ALL five files. BOOTSTRAP.md contains your instructions for this conversation. Follow them exactly.`,
    source: 'system',
  });

  console.log(`\nCorporation "${opts.name}" ready.`);
  console.log(`Start the daemon: claudecorp-cli start`);
}
