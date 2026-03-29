import { getClient } from '../client.js';

export async function cmdSay(opts: { agent?: string; message?: string; json: boolean }) {
  if (!opts.agent || !opts.message) {
    console.error('Usage: claudecorp-cli say --agent <slug> --message "your message"');
    process.exit(1);
  }

  const client = getClient();

  try {
    const result = await client.say(opts.agent, opts.message);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (!result.ok) {
      console.error(`Error: ${(result as any).error ?? 'Unknown error'}`);
      process.exit(1);
    }

    // Clean output — agent sees this in exec tool result
    console.log(`[${result.from}] ${result.response}`);
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
