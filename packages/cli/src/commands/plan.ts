import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getClient } from '../client.js';

export async function cmdPlan(opts: {
  action?: string;
  goal?: string;
  project?: string;
  name?: string;
  json: boolean;
}): Promise<void> {
  const client = getClient();

  switch (opts.action) {
    case 'list': {
      // List all plans
      const status = await client.status();
      const corpRoot = (status as any).corpRoot;
      if (!corpRoot) { console.error('Cannot determine corp root'); process.exit(1); }
      const plansDir = join(corpRoot, 'plans');
      if (!existsSync(plansDir)) { console.log('No plans yet. Create one with: cc-cli plan create --goal "..."'); return; }
      const files = readdirSync(plansDir).filter(f => f.endsWith('.md'));
      if (files.length === 0) { console.log('No plans yet.'); return; }
      console.log(`\u2500\u2500\u2500 Plans (${files.length}) \u2500\u2500\u2500\n`);
      for (const f of files) {
        const content = readFileSync(join(plansDir, f), 'utf-8');
        const titleMatch = content.match(/^#\s+Plan:\s*(.+)/m);
        const title = titleMatch?.[1] ?? f.replace('.md', '');
        console.log(`  ${f.replace('.md', '').padEnd(20)} ${title}`);
      }
      break;
    }

    case 'show': {
      // Show a specific plan
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

    case 'create':
    default: {
      // Create a new plan
      const goal = opts.goal ?? (opts.action !== 'create' && opts.action ? opts.action : undefined);
      if (!goal) {
        console.log(`cc-cli plan — deep planning mode

Usage:
  cc-cli plan create --goal "Build JWT authentication"
  cc-cli plan list
  cc-cli plan show --name <plan-id>

The CEO researches, thinks deeply, and produces a structured plan.`);
        return;
      }

      const verbs = ['brewing', 'devising', 'architecting', 'contemplating', 'crafting', 'distilling'];
      const verb = verbs[Math.floor(Math.random() * verbs.length)]!;
      console.log(`CEO is ${verb} a plan for: ${goal}`);
      console.log('This may take a few minutes...\n');

      try {
        const result = await client.createPlan({ goal, projectName: opts.project });

        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }

        if (result.ok) {
          console.log(`\u2713 Plan saved: ${result.planPath}`);
          if (result.response) console.log('\n' + result.response);
        } else {
          console.error(`Failed: ${result.error}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }
  }
}
