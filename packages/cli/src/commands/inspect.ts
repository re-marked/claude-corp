import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { readConfigOr, readConfig, type Member, type Corporation, type AgentConfig, MEMBERS_JSON, CORP_JSON } from '@claudecorp/shared';
import { getClient, getCorpRoot } from '../client.js';
import { listTasks } from '@claudecorp/shared';

export async function cmdInspect(opts: { agent?: string; json: boolean }) {
  if (!opts.agent) {
    console.error('Usage: claudecorp-cli inspect --agent <name-or-id>');
    process.exit(1);
  }

  const corpRoot = await getCorpRoot();
  const members = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);

  const normalize = (s: string) => s.toLowerCase().replace(/[\s-_]+/g, '');
  const needle = normalize(opts.agent!);
  const member = members.find(m =>
    m.id === opts.agent ||
    normalize(m.displayName) === needle ||
    (m.agentDir && normalize(m.agentDir) .includes(needle)),
  );

  if (!member) {
    console.error(`Agent "${opts.agent}" not found.`);
    process.exit(1);
  }

  const agentDir = member.agentDir ? join(corpRoot, member.agentDir) : null;

  // Read SOUL.md
  let soulExcerpt = '';
  if (agentDir) {
    const soulPath = join(agentDir, 'SOUL.md');
    if (existsSync(soulPath)) {
      soulExcerpt = readFileSync(soulPath, 'utf-8').slice(0, 500);
    }
  }

  // Read config.json
  let config: AgentConfig | null = null;
  if (agentDir) {
    try {
      config = readConfig<AgentConfig>(join(agentDir, 'config.json'));
    } catch {}
  }

  // Brain files
  let brainFiles: string[] = [];
  if (agentDir) {
    const brainDir = join(agentDir, 'BRAIN');
    if (existsSync(brainDir)) {
      brainFiles = readdirSync(brainDir).filter(f => f.endsWith('.md'));
    }
  }

  // Tasks assigned
  const allTasks = listTasks(corpRoot, { assignedTo: member.id });

  // Resolve harness: config.json → Member → corp → 'openclaw'.
  // Mirrors the daemon's resolveHarnessForAgent so inspection is truthful
  // even when the daemon isn't running.
  let corp: Corporation | null = null;
  try { corp = readConfig<Corporation>(join(corpRoot, CORP_JSON)); } catch {}
  const harness = config?.harness ?? member.harness ?? corp?.harness ?? 'openclaw';

  const data = {
    id: member.id,
    displayName: member.displayName,
    rank: member.rank,
    type: member.type,
    scope: member.scope,
    status: member.status,
    spawnedBy: member.spawnedBy,
    createdAt: member.createdAt,
    model: config?.model ?? 'default',
    provider: config?.provider ?? 'default',
    harness,
    soulExcerpt,
    brainFiles,
    tasks: allTasks.map(t => ({ id: t.task.id, title: t.task.title, status: t.task.status })),
  };

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Agent: ${member.displayName}\n`);
  console.log(`  ID:         ${member.id}`);
  console.log(`  Rank:       ${member.rank}`);
  console.log(`  Status:     ${member.status}`);
  console.log(`  Model:      ${config?.model ?? 'corp default'}`);
  console.log(`  Harness:    ${harness}`);
  console.log(`  Scope:      ${member.scope}`);
  console.log(`  Hired by:   ${member.spawnedBy ?? '—'}`);
  console.log(`  Created:    ${member.createdAt}`);

  if (soulExcerpt) {
    console.log(`\n  SOUL.md (excerpt):`);
    for (const line of soulExcerpt.split('\n').slice(0, 8)) {
      console.log(`    ${line}`);
    }
  }

  if (brainFiles.length > 0) {
    console.log(`\n  BRAIN/ (${brainFiles.length} files): ${brainFiles.join(', ')}`);
  }

  if (allTasks.length > 0) {
    console.log(`\n  Tasks (${allTasks.length}):`);
    for (const t of allTasks) {
      console.log(`    [${t.task.status}] ${t.task.title}`);
    }
  }
}
