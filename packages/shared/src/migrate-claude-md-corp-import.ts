/**
 * Backfill `@./CORP.md` import in CLAUDE.md for existing claude-code
 * agents that pre-date Project 1.13's import-not-stdout fix.
 *
 * Project 1.13 added `@./CORP.md` to `buildThinClaudeMd` and trimmed
 * `cc-cli wtf` stdout to header-only. New corps get the import at
 * scaffold time. Existing corps still have the old CLAUDE.md
 * (no `@./CORP.md` line) — without this migration they'd lose CORP.md
 * entirely after upgrade: hook stdout no longer carries it, and
 * their @imports list doesn't reference it.
 *
 * The migration regenerates CLAUDE.md from the current template using
 * the member's recorded kind/role/displayName/agentDir. Idempotent:
 * agents whose CLAUDE.md already contains `@./CORP.md` are skipped.
 * Agents without CLAUDE.md (OpenClaw-only — they don't get a
 * CLAUDE.md file because OpenClaw reads the workspace bootstrap
 * natively) are also skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteSync } from './atomic-write.js';
import { readConfig } from './parsers/index.js';
import { buildThinClaudeMd } from './templates/claude-md.js';
import { MEMBERS_JSON } from './constants.js';
import type { Member } from './types/member.js';

const CORP_IMPORT_LINE = '@./CORP.md';

export interface ClaudeMdCorpImportResult {
  /** Files rewritten with the current template (now include `@./CORP.md`). */
  upgraded: Array<{ agentSlug: string; agentDir: string }>;
  /** Skipped because the file already contains the import OR no CLAUDE.md exists. */
  skipped: Array<{ agentSlug: string; agentDir: string; reason: 'already-current' | 'no-claude-md' | 'archived' | 'no-workspace' }>;
  /** Errors — read or write failure. The migration continues past these. */
  errors: Array<{ agentSlug: string; agentDir: string; reason: string }>;
}

/**
 * Walk members.json for the corp, regenerate CLAUDE.md for any agent
 * whose existing CLAUDE.md is missing the `@./CORP.md` import. Safe
 * to call at every daemon startup — already-current files are skipped
 * by the substring check, so the second invocation is a no-op.
 *
 * Returns a structured result the caller logs. Failure to read
 * members.json returns an empty result rather than throwing — the
 * daemon shouldn't refuse to boot just because the migration can't run.
 */
export function migrateClaudeMdForCorpImport(corpRoot: string): ClaudeMdCorpImportResult {
  const result: ClaudeMdCorpImportResult = { upgraded: [], skipped: [], errors: [] };

  let members: Member[];
  try {
    members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  } catch {
    return result;
  }

  const corpName = corpRoot.split(/[/\\]/).pop() ?? 'corp';

  for (const member of members) {
    if (member.type !== 'agent') continue;
    if (member.status === 'archived') {
      result.skipped.push({ agentSlug: member.id, agentDir: member.agentDir ?? '', reason: 'archived' });
      continue;
    }
    if (!member.agentDir) {
      result.skipped.push({ agentSlug: member.id, agentDir: '', reason: 'no-workspace' });
      continue;
    }

    const claudeMdPath = join(member.agentDir, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      // OpenClaw agents won't have CLAUDE.md — that's fine, they
      // load the workspace bootstrap natively. Nothing to migrate.
      result.skipped.push({ agentSlug: member.id, agentDir: member.agentDir, reason: 'no-claude-md' });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(claudeMdPath, 'utf-8');
    } catch (err) {
      result.errors.push({
        agentSlug: member.id,
        agentDir: member.agentDir,
        reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (content.includes(CORP_IMPORT_LINE)) {
      result.skipped.push({ agentSlug: member.id, agentDir: member.agentDir, reason: 'already-current' });
      continue;
    }

    // Regenerate from current template. Kind defaults to 'partner' for
    // pre-1.1 agents (the AgentKind doc-comment treats undefined as
    // partner — every pre-split agent was persistent-named). Role
    // falls back to rank when the member predates the role-registry.
    const fresh = buildThinClaudeMd({
      kind: member.kind ?? 'partner',
      displayName: member.displayName,
      role: member.role ?? member.rank,
      corpName,
      workspacePath: member.agentDir,
    });

    try {
      atomicWriteSync(claudeMdPath, fresh);
      result.upgraded.push({ agentSlug: member.id, agentDir: member.agentDir });
    } catch (err) {
      result.errors.push({
        agentSlug: member.id,
        agentDir: member.agentDir,
        reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return result;
}
