import cronstrue from 'cronstrue';
import { formatIntervalMs, formatRelativeTime } from '@claudecorp/shared';
import { getClient } from '../client.js';

export async function cmdLoop(opts: {
  action?: string;
  interval?: string;
  command?: string;
  agent?: string;
  name?: string;
  maxRuns?: number;
  json: boolean;
}): Promise<void> {
  const client = getClient();

  switch (opts.action) {
    case 'create': {
      if (!opts.interval) {
        console.error('Error: --interval is required (e.g., "5m", "30s", "2h")');
        process.exit(1);
      }
      if (!opts.command) {
        console.error('Error: --command is required');
        process.exit(1);
      }

      const result = await client.createLoop({
        interval: opts.interval,
        command: opts.command,
        targetAgent: opts.agent,
        name: opts.name,
        maxRuns: opts.maxRuns,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.ok) {
        const loop = result.loop;
        console.log(`\u2713 Loop created: ${loop.name}`);
        console.log(`  Interval: ${loop.humanSchedule}`);
        console.log(`  Command:  ${loop.command}`);
        if (loop.targetAgent) console.log(`  Agent:    @${loop.targetAgent}`);
        if (loop.maxRuns) console.log(`  Max runs: ${loop.maxRuns}`);
        console.log(`  ID:       ${loop.id}`);
      } else {
        console.error(`Error: ${(result as any).error}`);
        process.exit(1);
      }
      break;
    }

    case 'list':
    case undefined: {
      const clocks = await client.listClocks();
      const loops = (clocks as any[]).filter((c: any) => c.type === 'loop');

      if (opts.json) {
        console.log(JSON.stringify(loops, null, 2));
        return;
      }

      if (loops.length === 0) {
        console.log('No active loops. Create one with: cc-cli loop create --interval "5m" --command "cc-cli status"');
        return;
      }

      console.log(`\u2500\u2500\u2500 Loops (${loops.length}) \u2500\u2500\u2500\n`);
      for (const loop of loops) {
        const status = loop.status === 'running' ? '\u25CF' : loop.status === 'paused' ? '\u25CB' : '\u2717';
        const interval = formatIntervalMs(loop.intervalMs);
        const nextFire = loop.nextFireAt
          ? formatRelativeTime(loop.nextFireAt - Date.now())
          : 'N/A';
        const fires = loop.fireCount;
        const errors = loop.errorCount > 0 ? ` (${loop.errorCount} errors)` : '';

        console.log(`  ${status} ${loop.name.padEnd(25)} every ${interval.padEnd(6)} next: ${nextFire.padEnd(8)} ${fires}x${errors}`);
      }
      break;
    }

    case 'complete': {
      const slug = opts.name;
      if (!slug) { console.error('Error: --name required'); process.exit(1); }
      try {
        await client.completeClock(slug);
        console.log(`\u2713 Loop "${slug}" completed — history preserved`);
      } catch (err) { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
      break;
    }

    case 'dismiss': {
      const slug = opts.name;
      if (!slug) { console.error('Error: --name required'); process.exit(1); }
      try {
        await client.dismissClock(slug);
        console.log(`\u2713 Loop "${slug}" dismissed`);
      } catch (err) { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
      break;
    }

    case 'stop':
    case 'delete': {
      const slug = opts.name;
      if (!slug) { console.error('Error: --name required'); process.exit(1); }
      try {
        await client.deleteClock(slug);
        console.log(`\u2713 Loop "${slug}" deleted`);
      } catch (err) { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
      break;
    }

    default:
      console.error(`Unknown loop action: "${opts.action}". Use: create, list, stop`);
      process.exit(1);
  }
}
