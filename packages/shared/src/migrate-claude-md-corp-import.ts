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
 * ## Surgical, not regenerative
 *
 * The migration **inserts a single new section** (`## The corp manual`
 * + `@./CORP.md` import + short description) into the existing file.
 * It does NOT regenerate from `buildThinClaudeMd`. CLAUDE.md is the
 * surface where role-specific instructions live — the CEO and the
 * founder add content there over time, and a regenerative migration
 * would clobber that. Surgical-insert preserves whatever's already
 * there and only adds the missing import.
 *
 * Anchor strategy: insert before the first matching anchor heading,
 * checked in priority order. If none match (hand-written CLAUDE.md
 * that doesn't follow the template), append to the end of the file.
 *
 * Idempotent: agents whose CLAUDE.md already contains `@./CORP.md`
 * are skipped. Agents without CLAUDE.md (OpenClaw-only — they don't
 * get a CLAUDE.md file because OpenClaw reads the workspace bootstrap
 * natively) are also skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteSync } from './atomic-write.js';
import { readConfig } from './parsers/index.js';
import { MEMBERS_JSON } from './constants.js';
import type { Member } from './types/member.js';

const CORP_IMPORT_LINE = '@./CORP.md';

/**
 * The block we inject. Mirrors the corresponding section in the
 * current `buildThinClaudeMd` template — keeping the wording in
 * sync means an agent doesn't see a different framing depending
 * on whether their CLAUDE.md was newly scaffolded or migrated.
 */
const CORP_MANUAL_SECTION = `## The corp manual

@./CORP.md

This is the corp's full ops reference — chits, casket, audit, hand,
patrols, commands, escalation, the works. Regenerated on every
SessionStart by \`cc-cli wtf\`, so what you see here is current as
of this turn. Re-run \`cc-cli wtf\` mid-session if state changed
materially and you need a fresh snapshot.

`;

/**
 * Anchors checked in priority order. Insert position is *before*
 * the first matching heading — keeps the new section near the top
 * of the live-state cluster (above STATUS/TASKS/inbox), which is
 * where it conceptually belongs.
 */
const ANCHORS = [
  '## Your live operational state',
  '## Your inbox',
  "## What you'll get dynamically",
] as const;

export interface ClaudeMdCorpImportResult {
  /** Files updated — `@./CORP.md` section was inserted. */
  upgraded: Array<{ agentSlug: string; agentDir: string; insertedAt: 'anchor' | 'end' }>;
  /** Skipped — already has the import OR no CLAUDE.md OR archived OR no workspace. */
  skipped: Array<{ agentSlug: string; agentDir: string; reason: 'already-current' | 'no-claude-md' | 'archived' | 'no-workspace' }>;
  /** Errors — read or write failure. The migration continues past these. */
  errors: Array<{ agentSlug: string; agentDir: string; reason: string }>;
}

/**
 * Splice `CORP_MANUAL_SECTION` into `existing` content. Returns the
 * updated content + a tag indicating whether an anchor was found
 * (so the caller can log "inserted before anchor X" vs "appended").
 *
 * Pure — used by the migration walker but extracted so unit tests
 * can exercise the splice logic without touching the filesystem.
 */
export function insertCorpManualSection(existing: string): { content: string; insertedAt: 'anchor' | 'end' } {
  for (const anchor of ANCHORS) {
    const idx = existing.indexOf(anchor);
    if (idx !== -1) {
      return {
        content: existing.slice(0, idx) + CORP_MANUAL_SECTION + existing.slice(idx),
        insertedAt: 'anchor',
      };
    }
  }
  // No anchor present — append to end. Hand-written CLAUDE.md that
  // doesn't follow the template still gets the import, just at the
  // bottom rather than in the canonical position.
  const trailing = existing.endsWith('\n') ? '' : '\n';
  return { content: existing + trailing + '\n' + CORP_MANUAL_SECTION, insertedAt: 'end' };
}

/**
 * Walk members.json, surgical-insert `@./CORP.md` into any agent's
 * CLAUDE.md that's missing it. Safe to call at every daemon startup —
 * already-current files are skipped by the substring check.
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
      // OpenClaw agents won't have CLAUDE.md — they load the workspace
      // bootstrap natively. Nothing to migrate.
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

    const { content: updated, insertedAt } = insertCorpManualSection(content);

    try {
      atomicWriteSync(claudeMdPath, updated);
      result.upgraded.push({ agentSlug: member.id, agentDir: member.agentDir, insertedAt });
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
