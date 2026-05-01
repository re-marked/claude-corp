/**
 * Pre-compact signal fragment — Project 1.7.
 *
 * Injects a nudge when a Partner's context window is about to be
 * autocompacted by Claude Code. Fires only when:
 *
 *   - agent kind is `partner` (employees use Claude Corp's own wake /
 *     SLUMBER machinery, which is already compaction-aware; the signal
 *     is a Partner-specific feature since Partners ride Claude Code's
 *     native `/compact`)
 *   - harness is `claude-code` (OpenClaw agents don't go through
 *     autocompact; the signal has no substrate to attach to)
 *   - the daemon has observed a recent usage snapshot (sessionTokens +
 *     sessionModel populated on FragmentContext)
 *   - tokens are in the `[ourSignalAt, autoCompactAt)` window per
 *     calculateCompactionThreshold — i.e., past our 30k-runway mark but
 *     not yet past Claude Code's 13k-autocompact mark
 *
 * The purpose of the fragment is to give the Partner time to persist
 * "soul material" — observations, memories, in-progress-thought —
 * to durable storage (BRAIN/, observation chits, WORKLOG.md) BEFORE
 * Claude Code's summarization model scrapes context. The summarizer is
 * good, but it compresses everything into a single synthetic summary
 * turn. Anything the Partner explicitly crystallizes into files
 * survives independently of that summary.
 *
 * Fragment is short + high-signal. Over-explaining here eats tokens
 * from exactly the context we're trying to save.
 */

import type { Fragment, FragmentContext } from './types.js';
import { calculateCompactionThreshold, formatThresholdSummary, inferKind } from '@claudecorp/shared';

/**
 * Backward-compat kind resolution: honor explicit ctx.agentKind first,
 * fall back to inferKind(ctx.agentRank) for pre-1.1 Partner records
 * that predate the structural `kind` field. Mirrors resolveKind in
 * wtf-state.ts. A strict `ctx.agentKind === 'partner'` check would
 * fail-closed for every legacy Partner, silently disabling the nudge
 * across upgraded corps until every Member record is backfilled —
 * exactly the upgrade friction the refactor is trying to avoid.
 */
function resolveAgentKind(ctx: FragmentContext): 'employee' | 'partner' | null {
  if (ctx.agentKind === 'partner' || ctx.agentKind === 'employee') return ctx.agentKind;
  if (typeof ctx.agentRank === 'string' && ctx.agentRank.length > 0) {
    return inferKind(ctx.agentRank);
  }
  return null;
}

export const preCompactSignalFragment: Fragment = {
  id: 'pre-compact-signal',
  // Order: very early — this is a NOW signal. Ahead of workspace (10),
  // context (20), history (30) so the Partner reads it before anything
  // else pulls their attention.
  order: 5,
  applies: (ctx) => {
    if (resolveAgentKind(ctx) !== 'partner') return false;
    if (ctx.harness !== 'claude-code') return false;
    if (typeof ctx.sessionTokens !== 'number' || !ctx.sessionModel) return false;
    const state = calculateCompactionThreshold(ctx.sessionTokens, ctx.sessionModel);
    return state.inSignalWindow;
  },
  render: (ctx) => {
    const state = calculateCompactionThreshold(ctx.sessionTokens!, ctx.sessionModel!);
    return `# Pre-Compact Signal

Your context is approaching Claude Code's autocompact threshold:
**${formatThresholdSummary(state)}**

Autocompact will summarize everything into one synthetic turn. Anything
you DON'T crystallize into durable storage before then gets reduced to
the summarizer's best guess.

**Crystallize now — before \`/compact\` fires:**

- \`cc-cli observe "<insight>" --from <you> --category <DECISION|LEARNED|CHECKPOINT>\`
  for anything you want to remember across the compact boundary.
  CHECKPOINT is the dedicated category for "where I am right now" —
  the Partner equivalent of a handoff note.
- Write any mid-flight reasoning into your BRAIN/ files directly.
  Bullet-point notes survive the summary untouched.
- Your Casket \`current_step\` already tracks the active task chit; it
  moves via \`cc-cli done\` / \`cc-cli hand\` / chain-walker on task
  close. No mid-session Casket edit is needed — the pointer is already
  durable across the compact boundary.

After this turn, continue as normal. The PreCompact hook will shape the
summary itself when compact fires — but the durable artifacts you write
now are what actually persist.`;
  },
};
