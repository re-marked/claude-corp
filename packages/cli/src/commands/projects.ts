import { getClient, getCorpRoot, getFounder } from '../client.js';

export async function cmdProjects(opts: {
  action?: string;
  name?: string;
  type?: string;
  lead?: string;
  description?: string;
  json: boolean;
}) {
  const client = getClient();

  if (!opts.action || opts.action === 'list') {
    const projects = await client.listProjects() as any[];
    if (opts.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }
    if (projects.length === 0) {
      console.log('No projects.');
      return;
    }
    console.log(`Projects (${projects.length}):\n`);
    for (const p of projects) {
      console.log(`  ${(p.name ?? p.id).padEnd(24)} ${(p.type ?? '').padEnd(12)} ${p.lead ?? ''}`);
    }
    return;
  }

  if (opts.action === 'create') {
    if (!opts.name) {
      console.error('Usage: claudecorp-cli projects create --name "Project Name" [--type research|development|content|operations] [--lead agentId] [--description "..."]');
      process.exit(1);
    }
    const corpRoot = await getCorpRoot();
    const founder = getFounder(corpRoot);
    const result = await client.createProject({
      name: opts.name,
      type: opts.type ?? 'development',
      lead: opts.lead,
      description: opts.description,
      createdBy: founder.id,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Project "${opts.name}" created.`);
    }
    return;
  }

  console.error(`Unknown action: ${opts.action}. Use: list, create`);
  process.exit(1);
}
