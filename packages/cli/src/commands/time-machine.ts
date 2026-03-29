import { getClient } from '../client.js';

export async function cmdTimeMachine(opts: {
  action?: string;
  hash?: string;
  last?: number;
  json: boolean;
}) {
  const client = getClient();

  // Default: show git log
  if (!opts.action || opts.action === 'log') {
    const commits = await client.getGitLog(opts.last ?? 15);
    if (opts.json) {
      console.log(JSON.stringify(commits, null, 2));
      return;
    }
    console.log('Recent snapshots:\n');
    for (const c of commits) {
      const date = new Date(c.date).toLocaleString();
      console.log(`  ${c.hash.slice(0, 7)}  ${date}  ${c.message}`);
    }
    console.log(`\nUse: claudecorp-cli tm rewind --hash <hash>`);
    return;
  }

  // Rewind to a specific commit
  if (opts.action === 'rewind') {
    if (!opts.hash) {
      console.error('Usage: claudecorp-cli tm rewind --hash <commit-hash>');
      process.exit(1);
    }
    const result = await client.rewindTo(opts.hash);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Rewound to ${opts.hash}`);
      console.log(result.result);
    }
    return;
  }

  // Forward (undo last rewind)
  if (opts.action === 'forward') {
    const result = await client.forward();
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('Fast-forwarded.');
      console.log(result.result);
    }
    return;
  }

  console.error(`Unknown action: ${opts.action}. Use: log, rewind, forward`);
  process.exit(1);
}
