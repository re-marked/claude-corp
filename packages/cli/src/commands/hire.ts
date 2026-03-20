import { readFileSync } from 'node:fs';
import { getClient, getCorpRoot, getFounder, getCeo } from '../client.js';

export async function cmdHire(opts: { name: string; rank: string; soul?: string; json: boolean }) {
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

  const result = await client.hireAgent({
    creatorId,
    agentName,
    displayName: opts.name,
    rank: opts.rank,
    soulContent,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Hired ${opts.name} (${opts.rank}) as ${agentName}.`);
  }
}
