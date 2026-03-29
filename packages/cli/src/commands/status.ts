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
    const ws = (a as any).workStatus ?? 'offline';
    const icon = ws === 'idle' || ws === 'busy' ? '\u25CF' : '\u25CB';
    console.log(`  ${icon} ${a.displayName.padEnd(16)} ${ws}`);
  }
}
