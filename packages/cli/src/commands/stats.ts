import { join } from 'node:path';
import { readConfigOr, type Member, type Channel, MEMBERS_JSON, CHANNELS_JSON } from '@claudecorp/shared';
import { getClient, getCorpRoot } from '../client.js';
import { listTasks } from '@claudecorp/shared';

export async function cmdStats(opts: { json: boolean }) {
  const client = getClient();
  const corpRoot = await getCorpRoot();
  const members = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);
  const channels = readConfigOr<Channel[]>(join(corpRoot, CHANNELS_JSON), []);

  const agents = members.filter(m => m.type === 'agent');
  let statusResult: any = { agents: [] };
  try { statusResult = await client.status(); } catch {}

  const onlineAgents = (statusResult.agents ?? []).filter((a: any) => a.status === 'ready');

  const allTasks = listTasks(corpRoot, {});
  const tasksByStatus: Record<string, number> = {};
  for (const t of allTasks) {
    tasksByStatus[t.task.status] = (tasksByStatus[t.task.status] ?? 0) + 1;
  }

  // Fetch analytics from daemon
  let analytics: any = null;
  try { analytics = await client.getCorpStats(); } catch {}

  if (opts.json) {
    console.log(JSON.stringify({
      agents: { total: agents.length, online: onlineAgents.length },
      tasks: { ...tasksByStatus, total: allTasks.length },
      channels: channels.length,
      analytics,
    }, null, 2));
    return;
  }

  // --- Pretty Print ---

  console.log('CORP STATISTICS');
  console.log('');

  // Agents
  console.log('AGENTS');
  console.log(`  ${onlineAgents.length} online / ${agents.length} total`);
  if (analytics?.topAgent) {
    console.log(`  Top performer: ${analytics.topAgent.name} (${analytics.topAgent.completed} tasks, streak: ${analytics.topAgent.streak})`);
  }
  console.log('');

  // Tasks
  console.log('TASKS');
  for (const [status, count] of Object.entries(tasksByStatus)) {
    const icon = status === 'completed' ? '\u2713' : status === 'blocked' ? '\u26A0' : status === 'in_progress' ? '\u25CF' : '\u25CB';
    console.log(`  ${icon} ${status.padEnd(14)} ${count}`);
  }
  console.log(`    ${'total'.padEnd(14)} ${allTasks.length}`);
  console.log('');

  // Analytics (if daemon is running)
  if (analytics) {
    console.log('ANALYTICS');
    console.log(`  Dispatches:     ${analytics.dispatchesTotal}`);
    console.log(`  Messages:       ${analytics.messagesTotal}`);
    console.log(`  Errors:         ${analytics.errorsTotal}`);

    const uptimeMs = analytics.uptime;
    if (uptimeMs) {
      const hours = Math.floor(uptimeMs / 3_600_000);
      const mins = Math.floor((uptimeMs % 3_600_000) / 60_000);
      console.log(`  Tracking since: ${hours}h ${mins}m ago`);
    }

    // Per-agent utilization
    if (analytics.agentCount > 0) {
      console.log('');
      console.log('AGENT METRICS');
      try {
        const full = await client.getAnalytics();
        if (full.agents) {
          for (const [, agent] of Object.entries(full.agents as Record<string, any>)) {
            const totalTime = (agent.busyTimeMs ?? 0) + (agent.idleTimeMs ?? 0);
            const utilization = totalTime > 0 ? Math.round((agent.busyTimeMs / totalTime) * 100) : 0;
            const streakInfo = agent.bestStreak > 0 ? ` best-streak:${agent.bestStreak}` : '';
            console.log(`  ${agent.name.padEnd(18)} ${utilization}% utilized  tasks:${agent.tasksCompleted}  dispatches:${agent.dispatchCount}${streakInfo}`);
          }
        }
      } catch {}
    }
  } else {
    console.log('ANALYTICS: daemon not running (start with cc-cli start)');
  }

  console.log('');
  console.log(`  Channels: ${channels.length}`);
}
