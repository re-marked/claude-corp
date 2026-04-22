import { readFileSync } from 'node:fs';
import { getClient, getCorpRoot, getFounder, getCeo } from '../client.js';
import {
  resolveModelAlias,
  getProjectByName,
  getRole,
  isKnownRole,
  roleIds,
  inferKind,
  type AgentKind,
} from '@claudecorp/shared';

export async function cmdHire(opts: {
  name: string;
  rank: string;
  soul?: string;
  model?: string;
  project?: string;
  harness?: string;
  supervisor?: string;
  kind?: string;
  role?: string;
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

  // --kind validation (Project 1.1). Optional flag; when given it must
  // be 'employee' or 'partner'. When omitted we pass through undefined
  // and the daemon infers from rank via resolveKind — matches pre-1.1
  // behavior so existing hire scripts continue working.
  let kind: AgentKind | undefined;
  if (opts.kind !== undefined) {
    if (opts.kind !== 'employee' && opts.kind !== 'partner') {
      console.error(`--kind must be 'employee' or 'partner' (got: ${opts.kind})`);
      process.exit(1);
    }
    kind = opts.kind;
  }

  // --role validation (Project 1.1). Optional, but when given must
  // match a registry entry. If --role is set without --kind we can
  // suggest the registry default, but we DON'T override explicit kind
  // — the founder may deliberately hire a Partner into a role whose
  // default is Employee (e.g. taming via direct hire rather than
  // earned promotion).
  let role: string | undefined;
  if (opts.role !== undefined) {
    if (!isKnownRole(opts.role)) {
      console.error(
        `--role must be a known role id. Got: ${opts.role}. Known: ${roleIds().join(', ')}`,
      );
      process.exit(1);
    }
    role = opts.role;
    if (!kind) {
      // Infer kind from the role's default when the caller didn't
      // specify either. Founder can still override with explicit --kind.
      kind = getRole(role)!.defaultKind;
    }
  }

  // As a last resort, fall back to rank-based kind inference so the
  // Member record always carries an explicit kind post-1.1. The daemon
  // would do this anyway; doing it here makes the value visible in
  // the CLI confirmation output below.
  if (!kind) {
    kind = inferKind(opts.rank);
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
    kind,
    ...(role ? { role } : {}),
  } as any);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const projectInfo = opts.project ? ` into project "${opts.project}"` : '';
    const harnessInfo = harness ? ` on harness "${harness}"` : '';
    const kindInfo = ` [${kind}${role ? ` · ${role}` : ''}]`;
    console.log(
      `Hired ${opts.name} (${opts.rank})${kindInfo} as ${agentName}${model ? ` on ${model}` : ''}${harnessInfo}${projectInfo}.`,
    );
  }
}
