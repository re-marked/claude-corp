import { getClient, getCorpRoot, getFounder } from '../client.js';
import { resolveModelAlias } from '@claudecorp/shared';

/**
 * cc — corp operations toolkit for agents and humans.
 * All commands are thin wrappers around existing daemon API endpoints.
 */
export async function cmdCc(opts: {
  action?: string;
  agent?: string;
  message?: string;
  title?: string;
  description?: string;
  priority?: string;
  assigned?: string;
  taskId?: string;
  reason?: string;
  name?: string;
  rank?: string;
  json: boolean;
}) {
  const client = getClient();

  switch (opts.action) {
    // --- Communication ---

    case 'say': {
      if (!opts.agent || !opts.message) {
        console.error('Usage: cc say --agent <slug> --message "..."');
        process.exit(1);
      }
      const result = await client.say(opts.agent, opts.message);
      if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
      if (!(result as any).ok) { console.error((result as any).error); process.exit(1); }
      console.log(`[${result.from}] ${result.response}`);
      return;
    }

    // --- Tasks ---

    case 'task': {
      if (!opts.title) {
        console.error('Usage: cc task --title "..." [--assigned <slug>] [--priority high]');
        process.exit(1);
      }
      const corpRoot = await getCorpRoot();
      const founder = getFounder(corpRoot);
      const result = await client.createTask({
        title: opts.title,
        description: opts.description,
        priority: opts.priority ?? 'medium',
        assignedTo: opts.assigned,
        createdBy: founder.id,
      });
      if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`Task created: "${opts.title}"`);
      return;
    }

    case 'done': {
      if (!opts.taskId) {
        console.error('Usage: cc done --taskId <id>');
        process.exit(1);
      }
      const resp = await fetch(`${(client as any).baseUrl}/tasks/${encodeURIComponent(opts.taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
      const result = await resp.json();
      if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`Task ${opts.taskId} marked complete.`);
      return;
    }

    case 'block': {
      if (!opts.taskId) {
        console.error('Usage: cc block --taskId <id> [--reason "..."]');
        process.exit(1);
      }
      const resp = await fetch(`${(client as any).baseUrl}/tasks/${encodeURIComponent(opts.taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'blocked' }),
      });
      const result = await resp.json();
      if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`Task ${opts.taskId} marked BLOCKED.${opts.reason ? ' Reason: ' + opts.reason : ''}`);
      return;
    }

    case 'tasks': {
      const tasks = await client.listTasks({ assignedTo: opts.assigned });
      if (opts.json) { console.log(JSON.stringify(tasks, null, 2)); return; }
      if (tasks.length === 0) { console.log('No tasks.'); return; }
      for (const t of tasks) {
        console.log(`  [${t.status.padEnd(12)}] ${t.title} (${t.priority})`);
      }
      return;
    }

    // --- People ---

    case 'hire': {
      if (!opts.name) {
        console.error('Usage: cc hire --name "Agent Name" [--description "..."]');
        process.exit(1);
      }
      const corpRoot = await getCorpRoot();
      const founder = getFounder(corpRoot);
      const agentSlug = opts.name.toLowerCase().replace(/\s+/g, '-');
      const result = await client.hireAgent({
        creatorId: founder.id,
        agentName: agentSlug,
        displayName: opts.name,
        rank: opts.rank ?? 'worker',
        soulContent: opts.description ? `# Identity\n\nYou are ${opts.name}. ${opts.description}\n` : undefined,
      });
      if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`Hired ${opts.name} as ${agentSlug}.`);
      return;
    }

    case 'fire': {
      if (!opts.agent) {
        console.error('Usage: cc fire --agent <slug>');
        process.exit(1);
      }
      // Archive the agent by stopping them
      try {
        await client.stopAgent(opts.agent);
        console.log(`${opts.agent} stopped.`);
      } catch {
        console.error(`Failed to stop ${opts.agent}.`);
      }
      return;
    }

    case 'who': {
      const agents = await client.listAgents();
      if (opts.json) { console.log(JSON.stringify(agents, null, 2)); return; }
      for (const a of agents) {
        const icon = a.status === 'ready' ? '\u25CF' : '\u25CB';
        console.log(`  ${icon} ${a.displayName.padEnd(20)} ${(a as any).workStatus ?? a.status}`);
      }
      return;
    }

    // --- Info ---

    case 'status': {
      const status = await client.status();
      if (opts.json) { console.log(JSON.stringify(status, null, 2)); return; }
      console.log(`Agents: ${status.agents.length}`);
      for (const a of status.agents) {
        const ws = (a as any).workStatus ?? 'offline';
        const icon = ws === 'idle' || ws === 'busy' ? '\u25CF' : '\u25CB';
        console.log(`  ${icon} ${a.displayName.padEnd(16)} ${ws}`);
      }
      return;
    }

    case 'inspect': {
      if (!opts.agent) {
        console.error('Usage: cc inspect --agent <slug>');
        process.exit(1);
      }
      // Reuse the inspect CLI command
      const { cmdInspect } = await import('./inspect.js');
      await cmdInspect({ agent: opts.agent, json: opts.json });
      return;
    }

    default:
      console.log(`cc — corp operations toolkit

Communication:
  cc say --agent <slug> --message "..."      Direct message, get response

Tasks:
  cc task --title "..." [--assigned <slug>]   Create task
  cc done --taskId <id>                       Mark task complete
  cc block --taskId <id> [--reason "..."]     Mark task blocked
  cc tasks [--assigned <slug>]                List tasks

People:
  cc hire --name "Name" [--description "..."] Hire agent
  cc fire --agent <slug>                      Stop agent
  cc who                                      List agents with status

Info:
  cc status                                   Corp status
  cc inspect --agent <slug>                   Agent detail`);
  }
}
