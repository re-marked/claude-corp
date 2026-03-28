import { join } from 'node:path';
import { readConfigOr, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { getClient, getCorpRoot } from '../client.js';

export async function cmdAgentControl(opts: {
  action: string;
  agent?: string;
  json: boolean;
}) {
  if (!opts.agent) {
    console.error(`Usage: claudecorp-cli agent ${opts.action} --agent <name-or-id>`);
    process.exit(1);
  }

  const client = getClient();
  const corpRoot = await getCorpRoot();
  const members = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);

  // Resolve agent by name or id
  const member = members.find(m =>
    m.id === opts.agent ||
    m.displayName.toLowerCase() === opts.agent!.toLowerCase() ||
    m.agentDir?.includes(opts.agent!) ||
    m.id.includes(opts.agent!),
  );

  if (!member) {
    console.error(`Agent "${opts.agent}" not found. Available:`);
    for (const m of members.filter(m => m.type === 'agent')) {
      console.log(`  ${m.id.padEnd(20)} ${m.displayName}`);
    }
    process.exit(1);
  }

  if (opts.action === 'start') {
    const result = await client.startAgent(member.id);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Started ${member.displayName} (port ${result.port}, ${result.status})`);
    }
  } else if (opts.action === 'stop') {
    const result = await client.stopAgent(member.id);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Stopped ${member.displayName}.`);
    }
  }
}
