import { join } from 'node:path';
import { getClient, getCorpRoot, getFounder, getCeo, getMembers } from '../client.js';
import {
  getProjectByName,
  listContracts,
  listAllContracts,
  readContract,
  getContractProgress,
  contractPath,
} from '@claudecorp/shared';

export async function cmdContract(opts: {
  action?: string;
  project?: string;
  title?: string;
  goal?: string;
  lead?: string;
  priority?: string;
  deadline?: string;
  blueprint?: string;
  status?: string;
  id?: string;
  json: boolean;
}) {
  const corpRoot = await getCorpRoot();
  const client = getClient();

  const action = opts.action ?? 'list';

  // --- CREATE ---
  if (action === 'create') {
    if (!opts.project || !opts.title || !opts.goal) {
      console.error('Usage: cc-cli contract create --project <name> --title "..." --goal "..." [--lead @slug] [--priority high] [--deadline 2026-04-05]');
      process.exit(1);
    }

    const project = getProjectByName(corpRoot, opts.project);
    if (!project) {
      console.error(`Project "${opts.project}" not found. Create it first: cc-cli projects create --name "${opts.project}" --type workspace`);
      process.exit(1);
    }

    // Resolve lead
    let leadId: string | undefined;
    if (opts.lead) {
      const members = getMembers(corpRoot);
      const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
      const lead = members.find(m =>
        m.type === 'agent' && (normalize(m.displayName) === normalize(opts.lead!) || m.id === opts.lead),
      );
      if (!lead) {
        console.error(`Agent "${opts.lead}" not found.`);
        process.exit(1);
      }
      leadId = lead.id;
    }

    const founder = getFounder(corpRoot);
    const ceo = getCeo(corpRoot);
    const creatorId = ceo?.id ?? founder.id;

    const result = await client.createContract({
      projectName: opts.project,
      title: opts.title,
      goal: opts.goal,
      leadId,
      priority: opts.priority ?? 'normal',
      deadline: opts.deadline ?? null,
      blueprintId: opts.blueprint ?? null,
      createdBy: creatorId,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const contract = (result as any).contract;
      console.log(`Contract created: "${opts.title}"`);
      console.log(`  ID: ${contract.id}`);
      console.log(`  Project: ${opts.project}`);
      console.log(`  Status: ${contract.status}`);
      if (opts.lead) console.log(`  Lead: ${opts.lead}`);
      console.log(`\n  Activate when ready: cc-cli contract activate --id ${contract.id} --project ${opts.project}`);
    }
    return;
  }

  // --- LIST ---
  if (action === 'list') {
    let contracts;
    if (opts.project) {
      contracts = listContracts(corpRoot, opts.project, opts.status ? { status: opts.status as any } : undefined);
    } else {
      contracts = listAllContracts(corpRoot, opts.status ? { status: opts.status as any } : undefined);
    }

    if (opts.json) {
      console.log(JSON.stringify(contracts.map(c => c.contract), null, 2));
      return;
    }

    if (contracts.length === 0) {
      console.log('No contracts found.');
      return;
    }

    console.log(`CONTRACTS (${contracts.length})\n`);
    const members = getMembers(corpRoot);

    for (const { contract } of contracts) {
      const lead = members.find(m => m.id === contract.leadId);
      const leadName = lead?.displayName ?? 'unassigned';
      const progress = getContractProgress(corpRoot, contract);
      const statusIcon = contract.status === 'completed' ? '\u2713'
        : contract.status === 'active' ? '\u25CF'
        : contract.status === 'review' ? '\u25CB'
        : contract.status === 'rejected' ? '\u2717'
        : '\u25CB';

      console.log(`  ${statusIcon} ${contract.title}`);
      console.log(`    ${contract.status.toUpperCase()} | ${contract.priority} | lead: ${leadName} | ${progress.percentComplete}% (${progress.completedTasks}/${progress.totalTasks} tasks)`);
      if (contract.deadline) {
        const deadline = new Date(contract.deadline);
        const daysLeft = Math.ceil((deadline.getTime() - Date.now()) / 86_400_000);
        console.log(`    Deadline: ${deadline.toLocaleDateString()} (${daysLeft > 0 ? `${daysLeft}d left` : 'OVERDUE'})`);
      }
      console.log('');
    }
    return;
  }

  // --- SHOW ---
  if (action === 'show') {
    if (!opts.project || !opts.id) {
      console.error('Usage: cc-cli contract show --id <contract-id> --project <name>');
      process.exit(1);
    }

    try {
      const filePath = contractPath(corpRoot, opts.project, opts.id);
      const { contract, body } = readContract(filePath);
      const progress = getContractProgress(corpRoot, contract);
      const members = getMembers(corpRoot);
      const lead = members.find(m => m.id === contract.leadId);

      if (opts.json) {
        console.log(JSON.stringify({ contract, body, progress }, null, 2));
        return;
      }

      console.log(`CONTRACT: ${contract.title}\n`);
      console.log(`  Status:   ${contract.status.toUpperCase()}`);
      console.log(`  Priority: ${contract.priority}`);
      console.log(`  Lead:     ${lead?.displayName ?? 'unassigned'}`);
      console.log(`  Progress: ${progress.percentComplete}% (${progress.completedTasks}/${progress.totalTasks} tasks)`);
      if (progress.blockedTasks > 0) console.log(`  Blocked:  ${progress.blockedTasks} tasks`);
      if (contract.deadline) console.log(`  Deadline: ${new Date(contract.deadline).toLocaleDateString()}`);
      if (contract.reviewNotes) console.log(`  Review:   ${contract.reviewNotes}`);
      if (contract.rejectionCount > 0) console.log(`  Rejected: ${contract.rejectionCount} time(s)`);
      console.log(`\n  Goal: ${contract.goal}`);
      if (body.trim()) console.log(`\n${body.trim()}`);
    } catch {
      console.error(`Contract "${opts.id}" not found in project "${opts.project}".`);
      process.exit(1);
    }
    return;
  }

  // --- ACTIVATE ---
  if (action === 'activate') {
    if (!opts.project || !opts.id) {
      console.error('Usage: cc-cli contract activate --id <contract-id> --project <name>');
      process.exit(1);
    }

    try {
      const result = await client.updateContract(opts.project, opts.id, { status: 'active' });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Contract "${opts.id}" activated. Work begins.`);
      }
    } catch (err) {
      console.error(`Failed to activate: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  console.error('Usage: cc-cli contract [create|list|show|activate] [options]');
  process.exit(1);
}
