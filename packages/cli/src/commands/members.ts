import { join } from 'node:path';
import { readConfigOr, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { getClient, getCorpRoot } from '../client.js';

export async function cmdMembers(opts: { json: boolean }) {
  const client = getClient();
  const corpRoot = await getCorpRoot();
  const members = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);
  const statusResult = await client.status();
  const agentStatuses = new Map(statusResult.agents.map(a => [a.memberId, a.status]));

  if (opts.json) {
    const enriched = members.map(m => ({
      ...m,
      processStatus: agentStatuses.get(m.id) ?? (m.type === 'user' ? 'active' : 'offline'),
    }));
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }

  console.log('Members:\n');
  for (const m of members) {
    const status = m.type === 'user' ? 'active' : (agentStatuses.get(m.id) ?? 'offline');
    const icon = status === 'ready' || status === 'active' ? '\u25C6' : '\u25C7';
    const statusLabel = status === 'ready' ? 'online' : status;
    console.log(`  ${icon} ${m.displayName.padEnd(22)} ${m.rank.padEnd(8)} ${m.type.padEnd(6)} ${statusLabel}`);
  }
}
