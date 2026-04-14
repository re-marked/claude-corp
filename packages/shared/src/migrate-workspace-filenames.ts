/**
 * Migrate agent workspace filenames from legacy names to OpenClaw-
 * recognized basenames.
 *
 * Rationale: OpenClaw's `loadWorkspaceBootstrapFiles` auto-injects only
 * files whose basename is in a hardcoded VALID_BOOTSTRAP_NAMES set
 * (AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md,
 * BOOTSTRAP.md, MEMORY.md). Claude Corp historically wrote RULES.md +
 * ENVIRONMENT.md, which were silently dropped — meaning rules +
 * environment content never reached the agent's system prompt.
 *
 * New agents (PR 4+) get the correct names at creation time. This
 * utility fixes up existing corps on daemon startup. Idempotent + safe:
 * only renames when the old file exists AND the new file doesn't.
 * Conflicts (both files present) are flagged and left untouched — the
 * user may have edited them separately.
 */

import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const LEGACY_RENAMES: ReadonlyArray<readonly [fromBasename: string, toBasename: string]> = [
  ['RULES.md', 'AGENTS.md'],
  ['ENVIRONMENT.md', 'TOOLS.md'],
];

export interface WorkspaceMigrationResult {
  /** Successful renames — old basename became new basename in this agent dir. */
  renamed: Array<{ agentDir: string; from: string; to: string }>;
  /** Conflicts — both legacy AND new basenames exist; left untouched. */
  conflicts: Array<{ agentDir: string; from: string; to: string }>;
  /** Errors — rename attempt threw; old file likely still in place. */
  errors: Array<{ agentDir: string; from: string; to: string; reason: string }>;
}

/**
 * Walk `<corpRoot>/agents/` (corp-scoped agents) AND
 * `<corpRoot>/projects/*\/agents/` (project-scoped agents), renaming
 * legacy RULES.md → AGENTS.md and ENVIRONMENT.md → TOOLS.md.
 *
 * Safe to call at every daemon startup — if nothing's legacy, nothing
 * happens. Returns a summary so the caller can log outcomes.
 */
export function migrateAgentWorkspaceFilenames(corpRoot: string): WorkspaceMigrationResult {
  const result: WorkspaceMigrationResult = { renamed: [], conflicts: [], errors: [] };

  // Corp-scoped agents
  const corpAgentsDir = join(corpRoot, 'agents');
  if (existsSync(corpAgentsDir)) {
    migrateAgentsDir(corpAgentsDir, result);
  }

  // Project-scoped agents: corpRoot/projects/<projectName>/agents/<agentName>/
  const projectsDir = join(corpRoot, 'projects');
  if (existsSync(projectsDir)) {
    try {
      for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!projectEntry.isDirectory()) continue;
        const projectAgentsDir = join(projectsDir, projectEntry.name, 'agents');
        if (existsSync(projectAgentsDir)) {
          migrateAgentsDir(projectAgentsDir, result);
        }
      }
    } catch {
      // Permission error listing projects dir — skip silently; not fatal.
    }
  }

  return result;
}

function migrateAgentsDir(agentsParentDir: string, result: WorkspaceMigrationResult): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(agentsParentDir, { withFileTypes: true });
  } catch {
    return; // can't read this dir, move on
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentDir = join(agentsParentDir, entry.name);

    for (const [fromName, toName] of LEGACY_RENAMES) {
      const fromPath = join(agentDir, fromName);
      const toPath = join(agentDir, toName);
      const fromExists = existsSync(fromPath);
      const toExists = existsSync(toPath);

      if (!fromExists) continue; // legacy file absent — nothing to do

      if (toExists) {
        // Both present: user likely edited both separately OR migration
        // was partially applied. Don't clobber either — flag it.
        result.conflicts.push({ agentDir, from: fromName, to: toName });
        continue;
      }

      try {
        renameSync(fromPath, toPath);
        result.renamed.push({ agentDir, from: fromName, to: toName });
      } catch (err) {
        result.errors.push({
          agentDir,
          from: fromName,
          to: toName,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
