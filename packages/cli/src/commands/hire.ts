import { readFileSync } from 'node:fs';
import { getClient, getCorpRoot, getFounder, getCeo } from '../client.js';
import { resolveModelAlias, getProjectByName } from '@claudecorp/shared';

export async function cmdHire(opts: {
  name: string;
  rank: string;
  soul?: string;
  model?: string;
  project?: string;
  harness?: string;
  supervisor?: string;
  json: boolean;
}) {
  if (!opts.name) {
    console.error('--name is required');
    process.exit(1);
  }
  if (!opts.rank) {
    console.error('--rank is required (leader, worker, subagent)');
    process.exit(1);
  }

  const client = getClient();
  const corpRoot = await getCorpRoot();
  const founder = getFounder(corpRoot);
  const ceo = getCeo(corpRoot);
  const creatorId = ceo?.id ?? founder.id;
  const agentName = opts.name.toLowerCase().replace(/\s+/g, '-');

  let soulContent: string | undefined;
  if (opts.soul) {
    soulContent = readFileSync(opts.soul, 'utf-8');
  }

  const model = opts.model ? (resolveModelAlias(opts.model) ?? opts.model) : undefined;

  // Resolve project scope
  let scope: string | undefined;
  let scopeId: string | undefined;
  if (opts.project) {
    const project = getProjectByName(corpRoot, opts.project);
    if (!project) {
      console.error(`Project "${opts.project}" not found. Create it first: cc-cli projects create --name "${opts.project}" --type workspace`);
      process.exit(1);
    }
    scope = 'project';
    scopeId = project.id;
  }

  const harness = opts.harness?.trim();

  const result = await client.hireAgent({
    creatorId,
    agentName,
    displayName: opts.name,
    rank: opts.rank,
    soulContent,
    model,
    scope,
    scopeId,
    ...(harness ? { harness } : {}),
    ...(opts.supervisor ? { supervisorId: opts.supervisor } : {}),
  } as any);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const projectInfo = opts.project ? ` into project "${opts.project}"` : '';
    const harnessInfo = harness ? ` on harness "${harness}"` : '';
    console.log(`Hired ${opts.name} (${opts.rank}) as ${agentName}${model ? ` on ${model}` : ''}${harnessInfo}${projectInfo}.`);
  }
}
