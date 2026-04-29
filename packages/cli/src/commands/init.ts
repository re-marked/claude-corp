import {
  scaffoldCorp,
  setupCeo,
  ensureGlobalConfig,
  post,
  getTheme,
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

  // Write kickoff system message — minimal trigger that defers to
  // BOOTSTRAP.md (refreshed in PR #197). Keep in sync with the
  // onboarding wizard's kickoff in packages/tui/src/views/onboarding.tsx.
  const ownerTitle = getTheme(themeId).ranks.owner;
  const dmPath = join(corpRoot, dmChannel.path, 'messages.jsonl');
  post(dmChannel.id, dmPath, {
    senderId: 'system',
    content: `New corporation "${opts.name}" created. This is your first session. The ${ownerTitle} is in this DM. Run \`cc-cli whoami --agent ceo\` to confirm your identity, then walk BOOTSTRAP.md — the founding-conversation guide — and start where it tells you to start.`,
    source: 'system',
  });

  console.log(`\nCorporation "${opts.name}" ready.`);
  console.log(`Start the daemon: cc-cli start`);
  console.log(``);
  console.log(`For the daemon to auto-restart on crash + auto-start on login,`);
  console.log(`run: cc-cli daemon install-service`);
  console.log(`(writes an OS-supervisor config; you then run one command to activate it)`);
}
