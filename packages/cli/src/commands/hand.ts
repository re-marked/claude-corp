import { getClient } from '../client.js';

export async function cmdHand(opts: {
  task?: string;
  to?: string;
  json: boolean;
}) {
  if (!opts.task || !opts.to) {
    console.error('Usage: cc-cli hand --task <task-id> --to <agent-slug>');
    console.error('');
    console.error('Hand a task to an agent. This is the moment work begins.');
    console.error('Creating a task is planning. Handing is action.');
    console.error('');
    console.error('Examples:');
    console.error('  cc-cli hand --task task-abc12 --to frontend-dev');
    console.error('  cc-cli hand --task task-abc12 --to ceo');
    process.exit(1);
  }

  const client = getClient();

  try {
    const result = await client.handTask(opts.task, opts.to);

    if (!result.ok) {
      console.error(`Failed: ${(result as any).error ?? 'Unknown error'}`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const task = result.task as any;
      console.log(`Handed "${task.title}" to ${result.handedTo}`);
      console.log(`  Task: ${task.id} (${task.priority.toUpperCase()})`);
      console.log(`  Status: ${task.status}`);
      console.log(`  → Dispatched to ${result.handedTo}'s DM`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
