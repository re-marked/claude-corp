import { getClient } from '../client.js';

export async function cmdStatus(opts: { json: boolean }) {
  const client = getClient();
  const result = await client.status();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Corp: ${result.corpRoot}`);
  console.log(`Agents: ${result.agents.length}`);
  console.log('');
  for (const a of result.agents) {
    const icon = a.status === 'ready' ? '\u25C6' : '\u25C7';
    console.log(`  ${icon} ${a.displayName.padEnd(16)} ${a.status}`);
  }
}
