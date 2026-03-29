import { join } from 'node:path';
import { readConfigOr, type Member, type Channel, MEMBERS_JSON, CHANNELS_JSON } from '@claudecorp/shared';
import { getClient, getCorpRoot } from '../client.js';
import { listTasks } from '@claudecorp/shared';

export async function cmdStats(opts: { json: boolean }) {
  const client = getClient();
  const corpRoot = await getCorpRoot();
  const members = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);
  const channels = readConfigOr<Channel[]>(join(corpRoot, CHANNELS_JSON), []);
  const uptime = await client.getUptime();

  const agents = members.filter(m => m.type === 'agent');
  const statusResult = await client.status();
  const onlineAgents = statusResult.agents.filter(a => a.status === 'ready');

  const allTasks = listTasks(corpRoot, {});
  const tasksByStatus: Record<string, number> = {};
  for (const t of allTasks) {
    tasksByStatus[t.task.status] = (tasksByStatus[t.task.status] ?? 0) + 1;
  }

  const data = {
    agents: { total: agents.length, online: onlineAgents.length, offline: agents.length - onlineAgents.length },
    tasks: { ...tasksByStatus, total: allTasks.length },
    channels: channels.length,
    messages: uptime.totalMessages,
    uptime: uptime.uptime,
  };

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log('Corp Statistics:\n');
  console.log(`  Agents:    ${data.agents.online} online / ${data.agents.total} total`);
  console.log(`  Channels:  ${data.channels}`);
  console.log(`  Messages:  ${data.messages}`);
  console.log(`  Uptime:    ${data.uptime}`);
  console.log('');
  console.log('  Tasks:');
  for (const [status, count] of Object.entries(tasksByStatus)) {
    console.log(`    ${status.padEnd(14)} ${count}`);
  }
  console.log(`    ${'total'.padEnd(14)} ${allTasks.length}`);
}
