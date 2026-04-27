/**
 * Pressman — Clearinghouse merge-lane Employee (Project 1.12.1).
 *
 * Mirrors {@link ../continuity/sexton.ts} in shape: a thin
 * `hirePressman(daemon)` convenience that idempotently registers a
 * Pressman in the corp via `hireAgent` with the right defaults
 * (rank=worker, kind=employee, role=pressman). Used by tests + the
 * future bacteria-scaling path; the founder-facing path remains
 * `cc-cli hire --role pressman` (which auto-loads the Pressman
 * operational manual via `roleSpecificAgentsContent`).
 *
 * ### Why a separate file when cc-cli hire already works
 *
 * Three reasons:
 *
 *   - Tests need a way to construct a Pressman in a fixture corp
 *     without spinning up the daemon HTTP path.
 *   - The 1.12.3 bacteria-scaling integration spawns Pressmen on
 *     queue-depth pressure; it calls into hireAgent directly, and a
 *     `hirePressman` convenience keeps the call site honest about
 *     defaults.
 *   - Symmetry with `hireSexton` makes the codebase easier to read
 *     for the next person looking at "where do system roles get
 *     hired."
 *
 * Unlike Sexton, this function is NOT called from daemon boot.
 * Pressman is founder opt-in: a corp without a Pressman silently
 * falls through `isClearinghouseAwareCorp` and audit's approve path
 * skips `enterClearance`. The corp can ship without merge-lane
 * automation; nothing breaks.
 */

import { join } from 'node:path';
import {
  readConfig,
  MEMBERS_JSON,
  CORP_JSON,
  type Member,
  type Corporation,
  type TemplateHarness,
  pressmanRules,
} from '@claudecorp/shared';
import type { Daemon } from '../daemon.js';
import { hireAgent } from '../hire.js';
import { log } from '../logger.js';

export interface HirePressmanOpts {
  /**
   * Member.id of the agent doing the hiring. Defaults to the corp's
   * CEO (rank=master). Tests + bacteria can override for fixture
   * scenarios.
   */
  creatorId?: string;
  /**
   * Workspace name + Member.id basis. Defaults to 'pressman'. When
   * bacteria spawns multiple, callers should pass distinct names
   * (e.g. 'pressman-1', 'pressman-2').
   */
  agentName?: string;
  /** Display name shown in TUI + chits. Defaults to 'Pressman'. */
  displayName?: string;
}

export interface HirePressmanResult {
  /** True iff this call newly hired; false on idempotent no-op. */
  readonly hired: boolean;
  /** Slug of the Pressman (existing or newly hired). */
  readonly slug: string;
}

/**
 * Hire (or look up) a Pressman in the corp. Idempotent: existing
 * Pressmen are returned without modification; matching by both
 * displayName + role to handle the case where a corp has been
 * partially-migrated and a 'pressman'-roled agent exists under a
 * different display name.
 *
 * The agent's AGENTS.md is built from `pressmanRules(harness)` so
 * the operational manual is shipped at hire time, not lazily on
 * first wake. Same pattern as Sexton's IDENTITY.md content path.
 *
 * Throws if no CEO exists (the creator falls back to the master-rank
 * Member). The fixture is responsible for ensuring a CEO before
 * calling.
 */
export async function hirePressman(
  daemon: Daemon,
  opts: HirePressmanOpts = {},
): Promise<HirePressmanResult> {
  const corpRoot = daemon.corpRoot;
  const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));

  // Idempotent check — match on either the displayName or the role.
  const displayName = opts.displayName ?? 'Pressman';
  const existing = members.find((m) => m.displayName === displayName || m.role === 'pressman');
  if (existing) {
    log(`[pressman] hire skipped: existing Pressman '${existing.displayName}' (${existing.id})`);
    return { hired: false, slug: existing.id };
  }

  let creatorId = opts.creatorId;
  if (!creatorId) {
    const ceo = members.find((m) => m.rank === 'master');
    if (!ceo) {
      throw new Error('hirePressman: no CEO (rank=master) found in members.json — cannot resolve creatorId');
    }
    creatorId = ceo.id;
  }

  const corp = readConfig<Corporation>(join(corpRoot, CORP_JSON));
  const harness: TemplateHarness = corp.harness === 'claude-code' ? 'claude-code' : 'openclaw';

  const result = await hireAgent(daemon, {
    creatorId,
    agentName: opts.agentName ?? 'pressman',
    displayName,
    rank: 'worker',
    kind: 'employee',
    role: 'pressman',
    agentsContent: pressmanRules({ rank: 'worker', harness }),
  });

  log(`[pressman] hired '${result.member.displayName}' (${result.member.id})`);
  return { hired: true, slug: result.member.id };
}

/**
 * Re-export `pressmanRules` for callers that need to construct the
 * AGENTS.md content without going through `hirePressman` (e.g. CLI
 * tools that render a preview, or tests that compare expected
 * content). Equivalent to importing from `@claudecorp/shared` directly.
 */
export { pressmanRules as buildPressmanRules } from '@claudecorp/shared';
