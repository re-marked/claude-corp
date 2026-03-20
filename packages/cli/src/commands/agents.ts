import { getClient } from '../client.js';

export async function cmdAgents(opts: { json: boolean }) {
  const client = getClient();
  const agents = await client.listAgents();

  if (opts.json) {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }

  if (agents.length === 0) {
    console.log('No agents.');
    return;
  }

  for (const a of agents) {
    const icon = a.status === 'ready' ? '\u25C6' : '\u25C7';
    console.log(`${icon} ${a.displayName.padEnd(16)} ${a.status.padEnd(10)} port:${a.port}`);
  }
}
