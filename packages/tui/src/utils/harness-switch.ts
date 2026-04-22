/**
 * Apply a harness switch to a single agent — the same filesystem
 * mutations that `cc-cli agent set-harness` performs, extracted as a
 * pure function so both the CLI (via cmdAgentSetHarness) and the TUI
 * (via /harness modal) converge on one implementation.
 *
 * The three steps, in order:
 *  1. Update `members.json` — set the agent's `harness` field.
 *  2. Update the agent's per-workspace `config.json` if present.
 *  3. Run `reconcileAgentWorkspace` to migrate legacy filenames and
 *     write/remove CLAUDE.md to match the target substrate.
 *
 * Synchronous and deterministic: no network I/O, no spawned processes,
 * no promises. Call it; read the returned reconcile result.
 */

import { join } from 'node:path';
import {
  readConfig,
  writeConfig,
  reconcileAgentWorkspace,
  MEMBERS_JSON,
  type Member,
  type AgentConfig,
  type ReconcileAgentWorkspaceResult,
} from '@claudecorp/shared';

export interface ApplyHarnessSwitchOpts {
  corpRoot: string;
  /** The agent being switched — needed for id, displayName, agentDir. */
  member: Member;
  /** New harness id, e.g., 'claude-code' or 'openclaw'. */
  targetHarness: string;
}

export function applyHarnessSwitch(opts: ApplyHarnessSwitchOpts): ReconcileAgentWorkspaceResult {
  const { corpRoot, member, targetHarness } = opts;

  // 1. Update members.json
  const membersPath = join(corpRoot, MEMBERS_JSON);
  const members = readConfig<Member[]>(membersPath);
  const updated = members.map(m => m.id === member.id ? { ...m, harness: targetHarness } : m);
  writeConfig(membersPath, updated);

  // 2. Update agent's own config.json if present. Agents created before
  // the harness field existed won't have a config.json, which is fine —
  // members.json is the source of truth for routing.
  if (member.agentDir) {
    const configPath = join(corpRoot, member.agentDir, 'config.json');
    try {
      const cfg = readConfig<AgentConfig>(configPath);
      writeConfig(configPath, { ...cfg, harness: targetHarness });
    } catch { /* no config.json — fine */ }
  }

  // 3. Reconcile the workspace. Without agentDir there's nothing to
  // reconcile (no workspace on disk), so we return an empty result.
  if (!member.agentDir) {
    return { renamed: [], conflicts: [], claudeMdWritten: false, claudeMdBackedUp: null };
  }
  return reconcileAgentWorkspace({
    agentDir: join(corpRoot, member.agentDir),
    displayName: member.displayName,
    harness: targetHarness,
    // Passed so reconcile backfills the Casket chit for agents whose
    // workspace pre-dated Casket lifecycle (0.7.3 prep). Idempotent —
    // existing Caskets are preserved untouched.
    corpRoot,
    agentSlug: member.id,
    casketCreatedBy: member.id,
  });
}
