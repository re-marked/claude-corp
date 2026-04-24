import { getClient, getCorpRoot, getFounder, getCeo, getMembers } from '../client.js';
import {
  getProjectByName,
  listContracts,
  listAllContracts,
  readContract,
  getContractProgress,
  contractPath,
  resolveBlueprint,
  listBlueprintChits,
  castFromBlueprint,
  updateChit,
  BlueprintVarError,
  BlueprintParseError,
  BlueprintCastError,
  type ChitScope,
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
  from?: string;
  json: boolean;
}) {
  const corpRoot = await getCorpRoot();

  const action = opts.action ?? 'list';

  // --- START (blueprint-backed Contract creation + activation) ---
  // Project 1.8 alias: `cc-cli contract start --blueprint <name>
  // --project <project>` is a one-command equivalent to
  // `cc-cli blueprint cast ... --scope project:<project>` followed by
  // `cc-cli contract activate`. Saves two explicit steps for the
  // common "CEO picks a blueprint, kicks off a project" flow.
  //
  // Re-parses its own argv (process.argv.slice(3)) so --vars +
  // --step-role (repeatable key=value flags) are supported without
  // bloating the top-level CLI parseArgs config. Everything else
  // (project, title, goal, lead, priority, deadline, from, json)
  // flows through via the opts object the dispatcher already passes.
  if (action === 'start') {
    await handleStart(corpRoot, opts);
    return;
  }

  const client = getClient();

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
      const leadStr = String(opts.lead).replace(/^@/, ''); // Strip @ prefix if present
      const normalize = (s: string) => String(s).toLowerCase().replace(/\s+/g, '-');
      const lead = members.find(m =>
        m.type === 'agent' && (normalize(m.displayName) === normalize(leadStr) || m.id === leadStr),
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

  console.error('Usage: cc-cli contract [create|list|show|activate|start] [options]');
  process.exit(1);
}

// ─── start — blueprint-backed Contract creation + activation ────────

/**
 * Parse repeatable `key=value` flag arguments from process.argv.
 * Used for --vars and --step-role which the top-level CLI parseArgs
 * doesn't know about; we reach into argv and pull them out by name.
 * Splits on the FIRST `=` so values can contain `=`.
 *
 * Returns `Record<string, string>` keyed by the k portion. Empty or
 * malformed (no `=`) pairs throw with the flag label in the message.
 */
function collectRepeatedKeyValue(flagName: string): Record<string, string> {
  const argv = process.argv.slice(3);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flagName) continue;
    const raw = argv[i + 1];
    if (raw === undefined) {
      console.error(`error: ${flagName} expects key=value (no value provided)`);
      process.exit(1);
    }
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      console.error(
        `error: ${flagName} expects key=value (got ${JSON.stringify(raw)}) — keys must be non-empty`,
      );
      process.exit(1);
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    if (!key) {
      console.error(`error: ${flagName} expects key=value — got empty key in ${JSON.stringify(raw)}`);
      process.exit(1);
    }
    out[key] = value;
    i++; // skip the value position
  }
  return out;
}

async function handleStart(
  corpRoot: string,
  opts: Parameters<typeof cmdContract>[0],
): Promise<void> {
  if (!opts.blueprint) {
    console.error(
      'Usage: cc-cli contract start --blueprint <name> --project <project> [--vars k=v]... [--step-role stepId=role]... [--title ...] [--goal ...] [--priority ...] [--lead ...] [--deadline ...] [--from <member>]',
    );
    process.exit(1);
  }
  if (!opts.project) {
    console.error('error: --project <name> required for contract start');
    process.exit(1);
  }

  const scope: ChitScope = `project:${opts.project}`;

  // Blueprint lookup: precedence is project-scope → corp-scope. Active
  // only — cast requires active, so don't even surface drafts here.
  const hit =
    resolveBlueprint(corpRoot, opts.blueprint, {
      scopes: [scope, 'corp'],
      activeOnly: true,
    }) ??
    // Fallback full-scope scan (project/team scopes are non-obvious
    // without a registry; the scan catches blueprints the precedence
    // above doesn't cover).
    (() => {
      const all = listBlueprintChits(corpRoot, { includeNonActive: false });
      return (
        all.find((cwb) => {
          const bp = cwb.chit.fields.blueprint;
          return bp.name === opts.blueprint || cwb.chit.id === opts.blueprint;
        }) ?? null
      );
    })();

  if (!hit) {
    console.error(`error: active blueprint '${opts.blueprint}' not found`);
    console.error('       (use `cc-cli blueprint list --all` to see drafts + closed)');
    process.exit(1);
  }

  const createdBy = opts.from ?? 'founder';
  const callerVars = collectRepeatedKeyValue('--vars');
  const stepRoleOverrides = collectRepeatedKeyValue('--step-role');

  const contractOverrides: NonNullable<
    Parameters<typeof castFromBlueprint>[3]['contractOverrides']
  > = {};
  if (opts.title !== undefined) contractOverrides.title = opts.title;
  if (opts.goal !== undefined) contractOverrides.goal = opts.goal;
  if (opts.priority !== undefined) {
    const p = opts.priority;
    if (!['critical', 'high', 'normal', 'low'].includes(p)) {
      console.error(`error: --priority must be critical|high|normal|low (got ${JSON.stringify(p)})`);
      process.exit(1);
    }
    contractOverrides.priority = p as 'critical' | 'high' | 'normal' | 'low';
  }
  if (opts.lead !== undefined) contractOverrides.leadId = opts.lead;
  if (opts.deadline !== undefined) contractOverrides.deadline = opts.deadline;

  // Cast. Every BlueprintError class translates to the same exit-2
  // user-visible failure; cast primitive carries the stepId + field
  // context so the printed message is debuggable.
  let result: ReturnType<typeof castFromBlueprint>;
  try {
    result = castFromBlueprint(corpRoot, hit.chit, callerVars, {
      scope,
      createdBy,
      ...(Object.keys(stepRoleOverrides).length > 0 ? { stepRoleOverrides } : {}),
      ...(Object.keys(contractOverrides).length > 0 ? { contractOverrides } : {}),
    });
  } catch (err) {
    let kind = 'other';
    if (err instanceof BlueprintVarError) kind = 'var';
    else if (err instanceof BlueprintParseError) kind = 'parse';
    else if (err instanceof BlueprintCastError) kind = 'cast';
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, errorKind: kind, message: err instanceof Error ? err.message : String(err) }, null, 2));
    } else {
      console.error(`✗ contract start failed [${kind}]`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(2);
  }

  // Activate the newly-cast Contract (draft → active). The separate
  // step exists because cast is a library primitive that doesn't
  // decide lifecycle — contract start IS the lifecycle decision point.
  // Using updateChit directly (not the daemon client) so `contract
  // start` works without a running daemon — fresh-corp workflow.
  updateChit(corpRoot, scope, 'contract', result.contract.id, {
    status: 'active',
    updatedBy: createdBy,
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          blueprint: { name: hit.chit.fields.blueprint.name, id: hit.chit.id },
          contract: {
            id: result.contract.id,
            title: result.contract.fields.contract.title,
            status: 'active',
          },
          tasks: result.tasks.map((t) => ({
            id: t.id,
            title: t.fields.task.title,
            assignee: t.fields.task.assignee,
            dependsOn: t.dependsOn,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `✓ Started ${hit.chit.fields.blueprint.name} in project:${opts.project}`,
  );
  console.log('');
  console.log(`  Contract: ${result.contract.id} (active)`);
  console.log(`    title:   ${result.contract.fields.contract.title}`);
  console.log(`    goal:    ${result.contract.fields.contract.goal}`);
  console.log('');
  console.log(`  ${result.tasks.length} task${result.tasks.length === 1 ? '' : 's'}:`);
  for (const t of result.tasks) {
    const deps = t.dependsOn.length > 0 ? `  (${t.dependsOn.length} dep${t.dependsOn.length === 1 ? '' : 's'})` : '';
    console.log(`    ${t.id}  →  ${t.fields.task.assignee}${deps}`);
  }
  console.log('');
  console.log(`  Tasks are in 'queued' state. Dispatch the first with:`);
  for (const t of result.tasks) {
    if (t.dependsOn.length === 0) {
      console.log(`    cc-cli hand --chit ${t.id} --to ${t.fields.task.assignee}`);
    }
  }
}
