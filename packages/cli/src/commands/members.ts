import { join } from 'node:path';
import { readConfigOr, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { getClient, getCorpRoot } from '../client.js';

export async function cmdMembers(opts: { json: boolean }) {
  const client = getClient();
  const corpRoot = await getCorpRoot();
  const members = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);
  const statusResult = await client.status();
  const agentStatuses = new Map(statusResult.agents.map((a: any) => [a.memberId, a.workStatus ?? 'offline']));

  if (opts.json) {
    const enriched = members.map(m => ({
      ...m,
      workStatus: agentStatuses.get(m.id) ?? (m.type === 'user' ? 'active' : 'offline'),
    }));
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }

  console.log('Members:\n');
  for (const m of members) {
    const ws = m.type === 'user' ? 'active' : (agentStatuses.get(m.id) ?? 'offline');
    const icon = ws === 'idle' || ws === 'busy' || ws === 'active' ? '\u25CF' : '\u25CB';
    console.log(`  ${icon} ${m.displayName.padEnd(22)} ${m.rank.padEnd(8)} ${m.type.padEnd(6)} ${ws}`);
  }
}
