import { getClient } from '../client.js';

export async function cmdDream(opts: {
  agent?: string;
  json: boolean;
}): Promise<void> {
  const client = getClient();

  if (!opts.agent) {
    console.error('Usage: cc-cli dream --agent <slug>');
    console.error('Force-trigger memory consolidation for an agent.');
    process.exit(1);
  }

  console.log(`Triggering dream for @${opts.agent}...`);

  try {
    const result = await client.triggerDream(opts.agent);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.ok) {
      console.log(`\u2713 Dream complete: ${result.summary ?? 'consolidated'}`);
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
