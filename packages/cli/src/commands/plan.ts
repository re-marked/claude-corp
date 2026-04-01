import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getClient } from '../client.js';

export async function cmdPlan(opts: {
  action?: string;
  goal?: string;
  project?: string;
  name?: string;
  agent?: string;
  type?: string;
  json: boolean;
}): Promise<void> {
  const client = getClient();

  switch (opts.action) {
    case 'list': {
      const status = await client.status();
      const corpRoot = (status as any).corpRoot;
      if (!corpRoot) { console.error('Cannot determine corp root'); process.exit(1); }
      const plansDir = join(corpRoot, 'plans');
      if (!existsSync(plansDir)) { console.log('No plans yet. Use: cc-cli plan create --goal "..."'); return; }
      const files = readdirSync(plansDir).filter(f => f.endsWith('.md'));
      if (files.length === 0) { console.log('No plans yet.'); return; }
      console.log(`\u2500\u2500\u2500 Plans (${files.length}) \u2500\u2500\u2500\n`);
      for (const f of files) {
        const content = readFileSync(join(plansDir, f), 'utf-8');
        const typeMatch = content.match(/^type:\s*(\w+)/m);
        const authorMatch = content.match(/^author:\s*(.+)/m);
        const statusMatch = content.match(/^status:\s*(\w+)/m);
        const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?/m);
        const type = typeMatch?.[1] ?? '?';
        const author = authorMatch?.[1]?.trim() ?? '?';
        const planStatus = statusMatch?.[1] ?? 'draft';
        const title = titleMatch?.[1] ?? f.replace('.md', '');
        const icon = type === 'plan' ? '\u25C6' : '\u25C7';
        console.log(`  ${icon} ${f.replace('.md', '').padEnd(18)} ${type.padEnd(8)} ${author.padEnd(12)} ${planStatus.padEnd(10)} ${title}`);
      }
      break;
    }

    case 'show': {
      const planId = opts.name ?? opts.goal;
      if (!planId) { console.error('Usage: cc-cli plan show --name <plan-id>'); process.exit(1); }
      const status = await client.status();
      const corpRoot = (status as any).corpRoot;
      if (!corpRoot) { console.error('Cannot determine corp root'); process.exit(1); }
      const planPath = join(corpRoot, 'plans', `${planId}.md`);
      if (!existsSync(planPath)) { console.error(`Plan "${planId}" not found`); process.exit(1); }
      console.log(readFileSync(planPath, 'utf-8'));
      break;
    }

    case 'sketch': {
      if (!opts.goal) { console.error('Usage: cc-cli plan sketch --goal "Quick feature plan"'); process.exit(1); }
      await createPlan(client, opts.goal, 'sketch', opts.agent, opts.project, opts.json);
      break;
    }

    case 'create':
    default: {
      const goal = opts.goal ?? (opts.action !== 'create' && opts.action !== 'sketch' && opts.action ? opts.action : undefined);
      if (!goal) {
        console.log(`cc-cli plan — the Plan primitive

Usage:
  cc-cli plan create --goal "Build auth system" [--agent cto]     Deep plan (20 min)
  cc-cli plan sketch --goal "Fix login bug" [--agent cto]         Quick sketch (5 min)
  cc-cli plan list                                                 List all plans
  cc-cli plan show --name <plan-id>                                Display a plan`);
        return;
      }
      const type = opts.type === 'sketch' ? 'sketch' : 'plan';
      await createPlan(client, goal, type, opts.agent, opts.project, opts.json);
      break;
    }
  }
}

async function createPlan(
  client: any,
  goal: string,
  type: 'sketch' | 'plan',
  agent?: string,
  project?: string,
  json?: boolean,
): Promise<void> {
  const verbs = ['brewing', 'devising', 'architecting', 'contemplating', 'crafting', 'distilling'];
  const verb = verbs[Math.floor(Math.random() * verbs.length)]!;
  const timeLabel = type === 'sketch' ? '~5 min' : 'up to 20 min';
  console.log(`${verb} a ${type} for: ${goal} (${timeLabel})`);

  try {
    const result = await client.createPlan({ goal, type, agent, projectName: project });

    if (json) { console.log(JSON.stringify(result, null, 2)); return; }

    if (result.ok) {
      console.log(`\u2713 ${result.planType === 'sketch' ? 'Sketch' : 'Plan'} saved: ${result.planPath}`);
      if (result.author) console.log(`  Author: ${result.author}`);
      if (result.response) console.log('\n' + result.response);
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
