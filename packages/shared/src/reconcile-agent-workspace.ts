/**
 * Reconcile a single agent's workspace to match a target harness.
 *
 * Unlike {@link migrateAgentWorkspaceFilenames} (which runs at daemon
 * startup across all agents and flags-but-never-resolves conflicts),
 * this helper is for the interactive `cc-cli agent set-harness` path:
 * it actively converges the workspace to the desired substrate, backing
 * up the loser when two copies of the same file exist.
 *
 * What it does, per call:
 *  1. Rename legacy bootstrap files (RULES.md → AGENTS.md,
 *     ENVIRONMENT.md → TOOLS.md). When both names are present, the
 *     newer file (by mtime) wins and the older is moved to a
 *     timestamped `.backup` sibling so content is never destroyed.
 *  2. For harness='claude-code': (re)write CLAUDE.md from the current
 *     template. The file is small and regeneration-safe — it only
 *     encodes the agent's display name and a list of @imports.
 *  3. For harness!='claude-code': if CLAUDE.md is present, move it
 *     aside with a timestamped backup. OpenClaw doesn't read CLAUDE.md,
 *     so leaving it lying around is clutter, but we don't delete
 *     outright — a user might have hand-edited it.
 *
 * Idempotent: running twice back-to-back produces no new changes on
 * the second run (same-named file already at the target, no conflict).
 */

import {
  existsSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildClaudeMd } from './templates/claude-md.js';

const LEGACY_RENAMES: ReadonlyArray<readonly [fromBasename: string, toBasename: string]> = [
  ['RULES.md', 'AGENTS.md'],
  ['ENVIRONMENT.md', 'TOOLS.md'],
];

export interface ReconcileAgentWorkspaceOpts {
  /** Absolute path to the agent's workspace directory. */
  agentDir: string;
  /** Display name used in the CLAUDE.md heading ("# I am {displayName}"). */
  displayName: string;
  /** Target harness this agent is being switched to. */
  harness: string;
}

export interface ReconcileAgentWorkspaceResult {
  /** Legacy file that didn't have a conflict — renamed outright. */
  renamed: Array<{ from: string; to: string }>;
  /** Both files existed. Older (by mtime) was moved to `backup`; newer now has the canonical basename. */
  conflicts: Array<{ from: string; to: string; backup: string }>;
  /** CLAUDE.md was written/rewritten (only on claude-code target). */
  claudeMdWritten: boolean;
  /** CLAUDE.md was moved aside to `backup` (only on non-claude-code target). Null otherwise. */
  claudeMdBackedUp: string | null;
}

export function reconcileAgentWorkspace(
  opts: ReconcileAgentWorkspaceOpts,
): ReconcileAgentWorkspaceResult {
  const { agentDir, displayName, harness } = opts;
  const result: ReconcileAgentWorkspaceResult = {
    renamed: [],
    conflicts: [],
    claudeMdWritten: false,
    claudeMdBackedUp: null,
  };

  if (!existsSync(agentDir)) return result;

  // 1. Legacy filename migration with conflict resolution
  for (const [fromName, toName] of LEGACY_RENAMES) {
    const fromPath = join(agentDir, fromName);
    const toPath = join(agentDir, toName);
    const fromExists = existsSync(fromPath);
    const toExists = existsSync(toPath);

    if (!fromExists && !toExists) continue;
    if (!fromExists && toExists) continue; // already migrated
    if (fromExists && !toExists) {
      renameSync(fromPath, toPath);
      result.renamed.push({ from: fromName, to: toName });
      continue;
    }

    // Both present — resolve by mtime
    const fromMtime = statSync(fromPath).mtimeMs;
    const toMtime = statSync(toPath).mtimeMs;
    const ts = timestampSuffix();

    if (toMtime >= fromMtime) {
      // Current file is newer-or-same — keep it, back up the legacy
      const backupPath = `${fromPath}.backup.${ts}`;
      renameSync(fromPath, backupPath);
      result.conflicts.push({ from: fromName, to: toName, backup: backupPath });
    } else {
      // Legacy file was edited more recently — promote it, back up the current
      const backupPath = `${toPath}.backup.${ts}`;
      renameSync(toPath, backupPath);
      renameSync(fromPath, toPath);
      result.conflicts.push({ from: fromName, to: toName, backup: backupPath });
    }
  }

  // 2. CLAUDE.md — write for claude-code, back up + remove for everything else
  const claudeMdPath = join(agentDir, 'CLAUDE.md');
  if (harness === 'claude-code') {
    writeFileSync(claudeMdPath, buildClaudeMd({ displayName }), 'utf-8');
    result.claudeMdWritten = true;
  } else if (existsSync(claudeMdPath)) {
    const backupPath = `${claudeMdPath}.backup.${timestampSuffix()}`;
    renameSync(claudeMdPath, backupPath);
    result.claudeMdBackedUp = backupPath;
  }

  return result;
}

function timestampSuffix(): string {
  // Colons + periods are illegal in NTFS filenames — normalize to hyphens.
  return new Date().toISOString().replace(/[:.]/g, '-');
}
