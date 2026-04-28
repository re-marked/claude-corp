/**
 * Role-aware AGENTS.md dispatch.
 *
 * The hire flow falls back to `defaultRules(rank)` when the caller
 * doesn't supply explicit `agentsContent`. For roles that ship with
 * pre-written operational manuals (Pressman, future: Editor), we want
 * those manuals to apply automatically when the founder runs
 * `cc-cli hire --role <id>` — the role registry already knows what
 * the role IS; this dispatch knows what the role's session needs to
 * READ on every wake.
 *
 * Returns `undefined` for roles without a pre-written manual; the
 * caller falls back to `defaultRules`. New roles slot in here without
 * touching the daemon-side hire path.
 */

import { pressmanRules } from './pressman-bootstrap.js';
import { editorRules } from './editor-bootstrap.js';
import type { TemplateHarness } from './rules.js';

export interface RoleSpecificRulesOpts {
  /** Role id from packages/shared/src/roles.ts. Optional — undefined returns undefined. */
  role?: string;
  /** Agent rank — passed through to defaultRules at the base of the composed content. */
  rank: string;
  /** Harness that will execute this agent's turns. */
  harness?: TemplateHarness;
}

/**
 * Look up a pre-written AGENTS.md for the named role. When the role
 * has one, the returned string is the FULL agentsContent (rank-default
 * rules + role-specific operational block, already composed).
 *
 * Returns undefined when no role is supplied OR the role doesn't ship
 * with a pre-written manual. Caller falls back to defaultRules.
 */
export function roleSpecificAgentsContent(opts: RoleSpecificRulesOpts): string | undefined {
  if (!opts.role) return undefined;
  switch (opts.role) {
    case 'pressman':
      return pressmanRules({
        rank: opts.rank,
        ...(opts.harness ? { harness: opts.harness } : {}),
      });
    case 'editor':
      return editorRules({
        rank: opts.rank,
        ...(opts.harness ? { harness: opts.harness } : {}),
      });
    default:
      return undefined;
  }
}
