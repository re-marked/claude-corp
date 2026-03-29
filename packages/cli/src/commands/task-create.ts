import { getClient, getCorpRoot, getFounder } from '../client.js';

export async function cmdTaskCreate(opts: {
  title?: string;
  description?: string;
  priority?: string;
  assigned?: string;
  json: boolean;
}) {
  if (!opts.title) {
    console.error('Usage: claudecorp-cli task create --title "Task title" [--description "..."] [--priority high|medium|low] [--assigned agentId]');
    process.exit(1);
  }

  const client = getClient();
  const corpRoot = await getCorpRoot();
  const founder = getFounder(corpRoot);

  const result = await client.createTask({
    title: opts.title,
    description: opts.description,
    priority: opts.priority ?? 'medium',
    assignedTo: opts.assigned,
    createdBy: founder.id,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Task created: "${opts.title}"`);
  }
}
