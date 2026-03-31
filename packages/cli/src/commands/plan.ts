import { getClient } from '../client.js';

export async function cmdPlan(opts: {
  goal?: string;
  project?: string;
  json: boolean;
}): Promise<void> {
  const client = getClient();

  if (!opts.goal) {
    console.error('Usage: cc-cli plan --goal "Build JWT authentication"');
    console.error('The CEO will research, think deeply, and produce a structured plan.');
    process.exit(1);
  }

  const verbs = ['brewing', 'devising', 'architecting', 'contemplating', 'crafting', 'distilling'];
  const verb = verbs[Math.floor(Math.random() * verbs.length)]!;
  console.log(`CEO is ${verb} a plan for: ${opts.goal}`);
  console.log('This may take a few minutes...\n');

  try {
    const result = await client.createPlan({
      goal: opts.goal,
      projectName: opts.project,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.ok) {
      console.log(`\u2713 Plan saved: ${result.planPath}`);
      if (result.response) {
        console.log('\n' + result.response);
      }
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
