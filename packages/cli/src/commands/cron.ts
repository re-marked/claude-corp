import cronstrue from 'cronstrue';
import { formatRelativeTime } from '@claudecorp/shared';
import { getClient } from '../client.js';

export async function cmdCron(opts: {
  action?: string;
  schedule?: string;
  command?: string;
  agent?: string;
  name?: string;
  maxRuns?: number;
  spawnTask?: boolean;
  taskTitle?: string;
  assignTo?: string;
  taskPriority?: string;
  json: boolean;
}): Promise<void> {
  const client = getClient();

  switch (opts.action) {
    case 'create': {
      if (!opts.schedule) {
        console.error('Error: --schedule is required (e.g., "@daily", "0 9 * * 1")');
        process.exit(1);
      }
      if (!opts.command) {
        console.error('Error: --command is required');
        process.exit(1);
      }

      const result = await client.createCron({
        schedule: opts.schedule,
        command: opts.command,
        targetAgent: opts.agent,
        name: opts.name,
        maxRuns: opts.maxRuns,
        spawnTask: opts.spawnTask,
        taskTitle: opts.taskTitle,
        assignTo: opts.assignTo,
        taskPriority: opts.taskPriority,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.ok) {
        const cron = result.cron;
        console.log(`\u2713 Cron created: ${cron.name}`);
        console.log(`  Schedule: ${cron.humanSchedule}`);
        console.log(`  Command:  ${cron.command}`);
        if (cron.targetAgent) console.log(`  Agent:    @${cron.targetAgent}`);
        if (cron.maxRuns) console.log(`  Max runs: ${cron.maxRuns}`);
        console.log(`  ID:       ${cron.id}`);
      } else {
        console.error(`Error: ${(result as any).error}`);
        process.exit(1);
      }
      break;
    }

    case 'list':
    case undefined: {
      const clocks = await client.listClocks();
      const crons = (clocks as any[]).filter((c: any) => c.type === 'cron');

      if (opts.json) {
        console.log(JSON.stringify(crons, null, 2));
        return;
      }

      if (crons.length === 0) {
        console.log('No active crons. Create one with: cc-cli cron create --schedule "@daily" --command "cc-cli status"');
        return;
      }

      console.log(`\u2500\u2500\u2500 Crons (${crons.length}) \u2500\u2500\u2500\n`);
      for (const cron of crons) {
        const status = cron.status === 'running' ? '\u25CF' : cron.status === 'paused' ? '\u25CB' : '\u2717';
        let schedule: string;
        try {
          schedule = cronstrue.toString(cron.description?.match(/^(.*?)\s*→/)?.[1] ?? '', { use24HourTimeFormat: true });
        } catch {
          schedule = cron.name;
        }
        const nextFire = cron.nextFireAt
          ? formatRelativeTime(cron.nextFireAt - Date.now())
          : 'N/A';
        const fires = cron.fireCount;
        const errors = cron.errorCount > 0 ? ` (${cron.errorCount} errors)` : '';

        console.log(`  ${status} ${cron.name.padEnd(30)} next: ${nextFire.padEnd(8)} ${fires}x${errors}`);
      }
      break;
    }

    case 'complete': {
      const slug = opts.name;
      if (!slug) { console.error('Error: --name required'); process.exit(1); }
      try {
        await client.completeClock(slug);
        console.log(`\u2713 Cron "${slug}" completed — history preserved`);
      } catch (err) { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
      break;
    }

    case 'dismiss': {
      const slug = opts.name;
      if (!slug) { console.error('Error: --name required'); process.exit(1); }
      try {
        await client.dismissClock(slug);
        console.log(`\u2713 Cron "${slug}" dismissed`);
      } catch (err) { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
      break;
    }

    case 'stop':
    case 'delete': {
      const slug = opts.name;
      if (!slug) { console.error('Error: --name required'); process.exit(1); }
      try {
        await client.deleteClock(slug);
        console.log(`\u2713 Cron "${slug}" deleted`);
      } catch (err) { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
      break;
    }

    default:
      console.error(`Unknown cron action: "${opts.action}". Use: create, list, stop`);
      process.exit(1);
  }
}
