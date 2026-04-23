import type { Fragment, FragmentContext } from './types.js';
import { atomicWriteSync, buildWtfOutput } from '@claudecorp/shared';
import { join } from 'node:path';
import { workspaceFragment } from './workspace.js';
import { contextFragment } from './context.js';
import { historyFragment } from './history.js';
import { inboxFragment } from './inbox.js';
// Project 1.6: Dredge fragment deleted. Its role (inject predecessor
// handoff into every dispatch) is now wtf's, which runs once per
// session boundary instead of once per turn — correct cadence for a
// one-shot handoff signal, and avoids duplicate injection.
import { autoemonFragment } from './autoemon.js';
import { cultureFragment } from './culture.js';

const FRAGMENTS: Fragment[] = [
  autoemonFragment,
  cultureFragment,
  workspaceFragment,
  inboxFragment,
  contextFragment,
  historyFragment,
].sort((a, b) => a.order - b.order);

/**
 * Compose the system message from applicable fragments, prepended (for
 * OpenClaw agents) with the Project 0.7 `buildWtfOutput` — the same
 * CORP.md + situational header that `cc-cli wtf` emits for Claude Code
 * hooks. Unified content across both substrates; only the trigger
 * differs (CLI subprocess via hook vs direct function call via harness
 * dispatch).
 *
 * Claude Code agents skip the wtf prepend here because their
 * SessionStart hook fires `cc-cli wtf` independently — injecting
 * twice would double the system-reminder block. The `harness` field
 * on FragmentContext disambiguates.
 *
 * Degrades gracefully: if any required context field is missing, or
 * if buildWtfOutput throws on state resolution, the prepend is skipped
 * and the fragment pipeline still runs. The agent doesn't lose context
 * entirely from a single wtf read failure.
 *
 * Side effect: writes CORP.md to the agent's workspace on every
 * dispatch so the agent can re-read it cheaply via their Read tool
 * without re-running the full wtf resolution. Atomic write; non-fatal
 * on error.
 */
export function composeSystemMessage(ctx: FragmentContext): string {
  const sections: string[] = [];

  const shouldPrependWtf =
    ctx.harness !== 'claude-code' &&
    ctx.corpRoot &&
    ctx.agentMemberId &&
    ctx.agentDir;

  if (shouldPrependWtf) {
    try {
      const now = new Date();
      const wtf = buildWtfOutput({
        corpRoot: ctx.corpRoot,
        corpName: ctx.corpRoot.split(/[/\\]/).pop() ?? 'corp',
        agentSlug: ctx.agentMemberId!,
        displayName: ctx.agentDisplayName,
        rank: ctx.agentRank ?? 'worker',
        workspacePath: ctx.agentDir,
        generatedAt: now.toISOString(),
        now,
        // Project 1.1 — explicit kind + role when the dispatch
        // context resolver populates them from the Member record.
        // Legacy contexts without these fields fall back to rank
        // inference + the role-is-rank display stand-in.
        ...(ctx.agentKind ? { kind: ctx.agentKind } : {}),
        ...(ctx.agentRole ? { roleId: ctx.agentRole } : {}),
        // Project 1.6: OpenClaw dispatch is the consumption point
        // for the handoff chit on this substrate (Claude Code hits
        // consumption via the SessionStart `cc-cli wtf` hook). First
        // dispatch of a new session picks up the active handoff +
        // closes it; subsequent dispatches find no active handoff
        // and render the header without a handoff block.
        consumeHandoff: true,
      });

      // Write CORP.md so the agent can re-read cheaply via Read tool.
      // Non-fatal on failure — the in-memory content still injects below.
      try {
        atomicWriteSync(join(ctx.agentDir, 'CORP.md'), wtf.corpMd);
      } catch {
        /* non-fatal */
      }

      sections.push(`${wtf.header}\n---\n\n${wtf.corpMd}`);
    } catch {
      // Any failure (member missing, corp state corrupt, etc.) → skip
      // the prepend, let fragments carry the session. The agent won't
      // boot blind — they'll get the legacy fragment content until
      // state resolves.
    }
  }

  const fragmentContent = FRAGMENTS
    .filter((f) => f.applies(ctx))
    .map((f) => f.render(ctx))
    .join('\n\n');

  if (fragmentContent.trim()) sections.push(fragmentContent);

  return sections.join('\n\n');
}

export type { FragmentContext, Fragment, FragmentFn } from './types.js';
