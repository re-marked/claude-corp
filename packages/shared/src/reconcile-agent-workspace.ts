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
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildThinClaudeMd } from './templates/claude-md.js';
import { buildHookSettings } from './templates/hook-settings.js';
import { inferKind } from './wtf-state.js';
import { createCasketIfMissing } from './casket.js';

const LEGACY_RENAMES: ReadonlyArray<readonly [fromBasename: string, toBasename: string]> = [
  ['RULES.md', 'AGENTS.md'],
  ['ENVIRONMENT.md', 'TOOLS.md'],
];

export interface ReconcileAgentWorkspaceOpts {
  /** Absolute path to the agent's workspace directory. */
  agentDir: string;
  /** Display name used in the CLAUDE.md heading. */
  displayName: string;
  /** Target harness this agent is being switched to. */
  harness: string;
  /**
   * Agent slug (members.json id). Required when target harness is
   * 'claude-code' — baked into the .claude/settings.json hook commands
   * as `--agent <slug>`. Ignored for other harnesses. Optional here
   * (not required) so legacy callers that pre-date 0.7.2 don't break;
   * when missing for a claude-code target, we fall back to using
   * `displayName` (lowercased) as the slug, which is the convention
   * agent-setup uses.
   */
  agentSlug?: string;
  /**
   * Agent rank — drives kind inference (Partner vs Employee), which
   * determines the hook set written to .claude/settings.json and the
   * kind-specific critical rule in CLAUDE.md. Optional for the same
   * backwards-compat reason as agentSlug; defaults to 'worker'
   * (employee) when absent — safer default since Employees get a
   * strict subset of Partner hooks.
   */
  rank?: string;
  /**
   * Corp name — interpolated into the CLAUDE.md identity line ("You
   * are X, a Y in the <corpName> corporation"). Optional; falls back
   * to the last path segment of agentDir's ancestry when not passed.
   */
  corpName?: string;
  /**
   * Corp root absolute path — needed to locate + write the agent's
   * Casket chit at `agents/<slug>/chits/casket/casket-<slug>.md` inside
   * the corp tree. When both this and `agentSlug` are provided, reconcile
   * backfills a Casket chit for the agent if one doesn't already exist
   * (idempotent). Without it, the Casket step is silently skipped —
   * preserves backwards-compat with tests that exercise reconcile
   * against bare tmpdirs with no surrounding corp structure.
   */
  corpRoot?: string;
  /**
   * Member id of the writer recorded in the Casket chit's createdBy
   * field on backfill. Defaults to the agentSlug itself — Casket is
   * agent-owned state, so the agent being its own author matches the
   * substrate semantics.
   */
  casketCreatedBy?: string;
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

  // 2. CLAUDE.md — write (thin, 0.7 shape) for claude-code, back up for everything else.
  //    Also writes .claude/settings.json with the hook wiring so the
  //    switched-to-claude-code agent gets SessionStart / PreCompact / Stop /
  //    UserPromptSubmit hooks firing `cc-cli wtf` + `cc-cli audit` / inbox check.
  const claudeMdPath = join(agentDir, 'CLAUDE.md');
  if (harness === 'claude-code') {
    const rank = opts.rank ?? 'worker'; // safer default — Employees get a strict subset of Partner hooks
    const kind = inferKind(rank);
    const agentSlug = opts.agentSlug ?? displayName.toLowerCase().replace(/\s+/g, '-');
    const corpName = opts.corpName ?? deriveCorpName(agentDir);

    writeFileSync(
      claudeMdPath,
      buildThinClaudeMd({ kind, displayName, role: rank, corpName, workspacePath: agentDir }),
      'utf-8',
    );
    result.claudeMdWritten = true;

    const claudeDir = join(agentDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settings = buildHookSettings({ kind, agentSlug });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify(settings, null, 2) + '\n',
      'utf-8',
    );
  } else if (existsSync(claudeMdPath)) {
    const backupPath = `${claudeMdPath}.backup.${timestampSuffix()}`;
    renameSync(claudeMdPath, backupPath);
    result.claudeMdBackedUp = backupPath;
  }

  // 3. Casket backfill — substrate-agnostic, runs for every harness.
  //    Only attempts when the caller gave us both corpRoot and agentSlug;
  //    without those we can't locate the chit store, so we degrade to a
  //    no-op (tests that exercise reconcile on bare tmpdirs rely on this
  //    degradation). Idempotent: a Casket that already exists is left
  //    untouched. Non-fatal on error — reconcile's primary job is file
  //    migration + hook wiring, and a missing Casket can be fixed on the
  //    next hire path without blocking the reconcile here.
  if (opts.corpRoot && opts.agentSlug) {
    try {
      createCasketIfMissing(
        opts.corpRoot,
        opts.agentSlug,
        opts.casketCreatedBy ?? opts.agentSlug,
      );
    } catch {
      /* non-fatal — logged by the eventual first audit pass */
    }
  }

  return result;
}

function timestampSuffix(): string {
  // Colons + periods are illegal in NTFS filenames — normalize to hyphens.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Derive a reasonable corpName from an absolute agentDir when the caller
 * didn't pass it explicitly. Agent workspaces live under
 * `<corpRoot>/agents/<slug>/` or `<corpRoot>/projects/<p>/agents/<slug>/`
 * or similar. Walk up until we find the first segment that isn't a
 * structural directory name (agents, projects, teams). That's the corp
 * root's basename — the corp's human-readable name.
 *
 * Fallback: if we can't find one, use the agent's parent directory
 * basename. Ugly but never empty, so the CLAUDE.md identity line
 * doesn't render with nothing.
 */
function deriveCorpName(agentDir: string): string {
  const structural = new Set(['agents', 'projects', 'teams', 'chits']);
  const segments = agentDir.split(/[/\\]/).filter(Boolean);
  // Walk from right to left, skip structural names + any segment that looks like a slug (follows a structural segment)
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    const prev = i > 0 ? segments[i - 1]! : null;
    if (structural.has(seg)) continue;
    if (prev && structural.has(prev)) continue; // this is a slug/name under structural
    return seg;
  }
  return segments[0] ?? 'corp';
}
