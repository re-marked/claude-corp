import { getClient, getCorpRoot, getFounder } from '../client.js';

export async function cmdTeams(opts: {
  action?: string;
  name?: string;
  project?: string;
  lead?: string;
  description?: string;
  json: boolean;
}) {
  const client = getClient();

  if (!opts.action || opts.action === 'list') {
    const teams = await client.listTeams(opts.project) as any[];
    if (opts.json) {
      console.log(JSON.stringify(teams, null, 2));
      return;
    }
    if (teams.length === 0) {
      console.log('No teams.');
      return;
    }
    console.log(`Teams (${teams.length}):\n`);
    for (const t of teams) {
      console.log(`  ${(t.name ?? t.id).padEnd(24)} ${(t.projectId ?? '').padEnd(16)} ${t.leaderId ?? ''}`);
    }
    return;
  }

  if (opts.action === 'create') {
    if (!opts.name || !opts.project || !opts.lead) {
      console.error('Usage: claudecorp-cli teams create --name "Team Name" --project <projectId> --lead <agentId> [--description "..."]');
      process.exit(1);
    }
    const corpRoot = await getCorpRoot();
    const founder = getFounder(corpRoot);
    const result = await client.createTeam({
      projectId: opts.project,
      name: opts.name,
      leaderId: opts.lead,
      description: opts.description,
      createdBy: founder.id,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Team "${opts.name}" created.`);
    }
    return;
  }

  console.error(`Unknown action: ${opts.action}. Use: list, create`);
  process.exit(1);
}
