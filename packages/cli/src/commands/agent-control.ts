import { isAbsolute, join } from 'node:path';
import {
  readConfigOr,
  readConfig,
  writeConfig,
  reconcileAgentWorkspace,
  type Member,
  type AgentConfig,
  type ReconcileAgentWorkspaceResult,
  MEMBERS_JSON,
} from '@claudecorp/shared';
import { isDaemonRunning, DaemonClient } from '@claudecorp/daemon';
import { getClient, getCorpRoot } from '../client.js';

export async function cmdAgentControl(opts: {
  action: string;
  agent?: string;
  json: boolean;
}) {
  if (!opts.agent) {
    console.error(`Usage: claudecorp-cli agent ${opts.action} --agent <name-or-id>`);
    process.exit(1);
  }

  const client = getClient();
  const corpRoot = await getCorpRoot();
  const members = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);

  // Resolve agent by name or id (normalize spaces/hyphens)
  const normalize = (s: string) => s.toLowerCase().replace(/[\s-_]+/g, '');
  const needle = normalize(opts.agent!);
  const member = members.find(m =>
    m.id === opts.agent ||
    normalize(m.displayName) === needle ||
    (m.agentDir && normalize(m.agentDir).includes(needle)),
  );

  if (!member) {
    console.error(`Agent "${opts.agent}" not found. Available:`);
    for (const m of members.filter(m => m.type === 'agent')) {
      console.log(`  ${m.id.padEnd(20)} ${m.displayName}`);
    }
    process.exit(1);
  }

  if (opts.action === 'start') {
    const result = await client.startAgent(member.id);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Started ${member.displayName} (port ${result.port}, ${result.status})`);
    }
  } else if (opts.action === 'stop') {
    const result = await client.stopAgent(member.id);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Stopped ${member.displayName}.`);
    }
  }
}

/**
 * cc-cli agent set-harness --agent <id> --harness <name>
 *
 * Updates the agent's harness choice in both the Member record
 * (members.json) and the agent's own config.json. Validates the harness
 * name against the running daemon's registered harnesses when possible;
 * when the daemon isn't running, validates against a known-good set and
 * warns that the config may reference a harness that can't actually route.
 *
 * Does NOT restart the agent — prints a reminder when the daemon is live
 * since the change doesn't take effect until next dispatch (daemon reads
 * config.json per-dispatch, so most of the time no restart is needed,
 * but a warning keeps expectations clear).
 */
export async function cmdAgentSetHarness(opts: {
  agent?: string;
  harness?: string;
  corp?: string;
  json: boolean;
}): Promise<void> {
  if (!opts.agent || !opts.harness) {
    console.error('Usage: cc-cli agent set-harness --agent <name-or-id> --harness <name> [--corp <name>]');
    process.exit(1);
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const membersPath = join(corpRoot, MEMBERS_JSON);
  const members = readConfigOr<Member[]>(membersPath, []);

  const normalize = (s: string) => s.toLowerCase().replace(/[\s-_]+/g, '');
  const needle = normalize(opts.agent);
  const member = members.find((m) =>
    m.id === opts.agent ||
    normalize(m.displayName) === needle ||
    (m.agentDir && normalize(m.agentDir).includes(needle)),
  );
  if (!member) {
    console.error(`Agent "${opts.agent}" not found.`);
    process.exit(1);
  }

  // Validate harness name against the running daemon when available.
  // Without a running daemon we still accept the change (the user might
  // be configuring ahead of daemon startup) but warn if it's not the
  // known-good 'openclaw'.
  const { running, port } = isDaemonRunning();
  let validated = false;
  if (running && port) {
    try {
      const harnesses = await new DaemonClient(port).listHarnesses();
      if (!harnesses.registered.includes(opts.harness)) {
        console.error(
          `Harness "${opts.harness}" is not registered. Registered: ${harnesses.registered.join(', ') || '(none)'}.`,
        );
        process.exit(1);
      }
      validated = true;
    } catch {
      // Daemon reachable but /harnesses call failed — fall through to
      // optimistic write with a warning below.
    }
  }
  if (!validated && opts.harness !== 'openclaw') {
    console.warn(
      `Warning: daemon not reachable; couldn't verify harness "${opts.harness}" is registered. Writing anyway.`,
    );
  }

  // Update Member in members.json
  const next = { ...member, harness: opts.harness };
  const updated = members.map((m) => (m.id === member.id ? next : m));
  writeConfig(membersPath, updated);

  // Update agent's own config.json if present
  let configUpdated = false;
  if (member.agentDir) {
    const configPath = join(corpRoot, member.agentDir, 'config.json');
    try {
      const cfg = readConfig<AgentConfig>(configPath);
      writeConfig(configPath, { ...cfg, harness: opts.harness });
      configUpdated = true;
    } catch {
      // Agent created before PR 2 might not have a config.json — not fatal
    }
  }

  // Reconcile the workspace to match the target harness: migrate legacy
  // filenames + write/remove CLAUDE.md. Without this, switching to
  // claude-code leaves an agent missing CLAUDE.md (so its workspace
  // files never reach the system prompt), and switching back to openclaw
  // leaves a stale CLAUDE.md that OpenClaw ignores but that clutters
  // the workspace and confuses anyone inspecting it.
  let reconcileResult: ReconcileAgentWorkspaceResult = {
    renamed: [], conflicts: [], claudeMdWritten: false, claudeMdBackedUp: null,
  };
  if (member.agentDir) {
    const agentAbs = isAbsolute(member.agentDir) ? member.agentDir : join(corpRoot, member.agentDir);
    reconcileResult = reconcileAgentWorkspace({
      agentDir: agentAbs,
      displayName: member.displayName,
      harness: opts.harness,
    });
  }

  const result = {
    ok: true,
    agent: member.displayName,
    agentId: member.id,
    harness: opts.harness,
    membersUpdated: true,
    configUpdated,
    daemonRunning: running,
    workspace: reconcileResult,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Set ${member.displayName} harness → ${opts.harness}`);
  if (configUpdated) console.log('  Updated: members.json + config.json');
  else console.log('  Updated: members.json (no config.json found)');
  if (reconcileResult.renamed.length > 0) {
    for (const r of reconcileResult.renamed) {
      console.log(`  Migrated: ${r.from} → ${r.to}`);
    }
  }
  if (reconcileResult.conflicts.length > 0) {
    for (const c of reconcileResult.conflicts) {
      console.log(`  Resolved conflict: ${c.from} / ${c.to} — older copy backed up to ${c.backup}`);
    }
  }
  if (reconcileResult.claudeMdWritten) console.log('  Wrote: CLAUDE.md');
  if (reconcileResult.claudeMdBackedUp) {
    console.log(`  Moved: CLAUDE.md → ${reconcileResult.claudeMdBackedUp} (not used by ${opts.harness})`);
  }
  if (running) {
    console.log('  Daemon is running — change applies on next dispatch.');
  } else {
    console.log('  Daemon not running — start it to route with the new harness.');
  }
}

export async function cmdAgentFire(opts: {
  agent?: string;
  action: 'fire' | 'remove';
  cascade: boolean;
  json: boolean;
}): Promise<void> {
  if (!opts.agent) {
    console.error('Usage: cc-cli agent fire|remove --agent <name> [--cascade]');
    process.exit(1);
  }

  const client = getClient();
  const corpRoot = await getCorpRoot();
  const members = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);

  const normalize = (s: string) => s.toLowerCase().replace(/[\s-_]+/g, '');
  const needle = normalize(opts.agent);
  const target = members.find((m) =>
    m.id === opts.agent ||
    normalize(m.displayName) === needle ||
    (m.agentDir && normalize(m.agentDir).includes(needle)),
  );

  if (!target) {
    console.error(`Agent "${opts.agent}" not found.`);
    process.exit(1);
  }

  // Use CEO as requester (highest authority available from CLI context)
  const ceo = members.find((m) => m.rank === 'master');
  if (!ceo) {
    console.error('CEO not found — cannot determine requester.');
    process.exit(1);
  }

  const data = await client.post(
    `/agents/${encodeURIComponent(target.id)}/fire`,
    { requesterId: ceo.id, action: opts.action, cascade: opts.cascade },
  ) as Record<string, unknown>;

  if (!data.ok) {
    console.error(`Error: ${data.error ?? 'unknown error'}`);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const firedCount = (data.firedAgents as string[] | undefined)?.length ?? 1;
  const label = opts.action === 'fire' ? 'Archived' : 'Removed';
  const extra = firedCount > 1 ? ` and ${firedCount - 1} subordinate(s)` : '';
  console.log(`${label} ${target.displayName}${extra}.`);
}
