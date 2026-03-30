import { getClient, getCorpRoot, getFounder, getMembers } from '../client.js';

export async function cmdTaskCreate(opts: {
  title?: string;
  description?: string;
  priority?: string;
  assigned?: string;
  to?: string; // Alias for --assigned + hand (create + dispatch in one step)
  json: boolean;
}) {
  if (!opts.title) {
    console.error('Usage: cc-cli task create --title "..." [--to <agent-slug>] [--priority high]');
    console.error('');
    console.error('Options:');
    console.error('  --to <slug>     Create AND hand to agent (starts work immediately)');
    console.error('  --assigned <id> Set assignee without dispatching (plan, hand later)');
    console.error('  --priority      critical | high | normal | low (default: normal)');
    process.exit(1);
  }

  const client = getClient();
  const corpRoot = await getCorpRoot();
  const founder = getFounder(corpRoot);

  // Resolve --to slug to agent ID
  let assigneeId = opts.assigned;
  let handTo: string | undefined;

  if (opts.to) {
    const members = getMembers(corpRoot);
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
    const target = members.find((m: any) =>
      m.type === 'agent' && (normalize(m.displayName) === normalize(opts.to!) || m.id === opts.to),
    );
    if (!target) {
      console.error(`Agent "${opts.to}" not found.`);
      process.exit(1);
    }
    assigneeId = target.id;
    handTo = target.id; // Signal to API: dispatch immediately
  }

  const result = await client.createTask({
    title: opts.title,
    description: opts.description,
    priority: opts.priority ?? 'normal',
    assignedTo: assigneeId,
    createdBy: founder.id,
    handTo, // Only dispatches if --to was provided
  } as any);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const task = (result as any).task;
    if (handTo) {
      const members = getMembers(corpRoot);
      const target = members.find((m: any) => m.id === handTo);
      console.log(`Task created: "${opts.title}" → handed to ${target?.displayName ?? opts.to}`);
    } else if (assigneeId) {
      console.log(`Task created: "${opts.title}" (assigned, not yet handed — use cc-cli hand to dispatch)`);
    } else {
      console.log(`Task created: "${opts.title}" (unassigned)`);
    }
  }
}
