/**
 * Editor — Clearinghouse pre-push review Employee (Project 1.12.2).
 *
 * Mirrors {@link ./pressman.ts} in shape: a thin
 * `hireEditor(daemon)` convenience that idempotently registers an
 * Editor in the corp via `hireAgent` with the right defaults
 * (rank=worker, kind=employee, role=editor). Used by tests + the
 * future bacteria-scaling path; the founder-facing path remains
 * `cc-cli hire --role editor` (which auto-loads the Editor
 * operational manual via `roleSpecificAgentsContent`).
 *
 * NOT auto-hired on daemon boot. Editor is founder opt-in: a corp
 * without an Editor silently falls through `isEditorAwareCorp` and
 * audit's approve path skips Editor dispatch (firing enterClearance
 * directly with `reviewBypassed: true`). The corp can ship without
 * pre-push review; nothing breaks.
 */

import { join } from 'node:path';
import {
  readConfig,
  MEMBERS_JSON,
  CORP_JSON,
  type Member,
  type Corporation,
  type TemplateHarness,
  editorRules,
} from '@claudecorp/shared';
import type { Daemon } from '../daemon.js';
import { hireAgent } from '../hire.js';
import { log } from '../logger.js';

export interface HireEditorOpts {
  /**
   * Member.id of the agent doing the hiring. Defaults to the corp's
   * CEO (rank=master). Tests + bacteria can override.
   */
  creatorId?: string;
  /**
   * Workspace name + Member.id basis. Defaults to 'editor'. When
   * bacteria spawns multiple, callers should pass distinct names
   * (e.g. 'editor-1', 'editor-2').
   */
  agentName?: string;
  /** Display name shown in TUI + chits. Defaults to 'Editor'. */
  displayName?: string;
}

export interface HireEditorResult {
  /** True iff this call newly hired; false on idempotent no-op. */
  readonly hired: boolean;
  /** Slug of the Editor (existing or newly hired). */
  readonly slug: string;
}

/**
 * Hire (or look up) an Editor in the corp. Idempotent: existing
 * non-archived Editors are returned without modification, matching
 * by displayName OR role to handle partial-migration edge cases.
 *
 * Mirrors `hirePressman`'s archived-skip filter so callers can't
 * silently match a fired Editor (which would leave dispatch paths
 * intentionally skipping the slug while audit defers task closes
 * for it — same divergence Codex caught for Pressman on PR #194).
 */
export async function hireEditor(
  daemon: Daemon,
  opts: HireEditorOpts = {},
): Promise<HireEditorResult> {
  const corpRoot = daemon.corpRoot;
  const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));

  const displayName = opts.displayName ?? 'Editor';
  const existing = members.find(
    (m) => m.status !== 'archived' && (m.displayName === displayName || m.role === 'editor'),
  );
  if (existing) {
    log(`[editor] hire skipped: existing Editor '${existing.displayName}' (${existing.id})`);
    return { hired: false, slug: existing.id };
  }

  let creatorId = opts.creatorId;
  if (!creatorId) {
    const ceo = members.find((m) => m.rank === 'master');
    if (!ceo) {
      throw new Error('hireEditor: no CEO (rank=master) found in members.json — cannot resolve creatorId');
    }
    creatorId = ceo.id;
  }

  const corp = readConfig<Corporation>(join(corpRoot, CORP_JSON));
  const harness: TemplateHarness = corp.harness === 'claude-code' ? 'claude-code' : 'openclaw';

  const result = await hireAgent(daemon, {
    creatorId,
    agentName: opts.agentName ?? 'editor',
    displayName,
    rank: 'worker',
    kind: 'employee',
    role: 'editor',
    agentsContent: editorRules({ rank: 'worker', harness }),
  });

  log(`[editor] hired '${result.member.displayName}' (${result.member.id})`);
  return { hired: true, slug: result.member.id };
}

/**
 * Re-export `editorRules` for callers that need to construct the
 * AGENTS.md content without going through `hireEditor` (e.g. CLI
 * preview, tests). Equivalent to importing from `@claudecorp/shared`
 * directly.
 */
export { editorRules as buildEditorRules } from '@claudecorp/shared';
