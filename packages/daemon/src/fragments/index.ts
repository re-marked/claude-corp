import type { Fragment, FragmentContext } from './types.js';
import { atomicWriteSync, buildWtfOutput } from '@claudecorp/shared';
import { join } from 'node:path';
import { workspaceFragment } from './workspace.js';
import { taskExecutionFragment } from './task-execution.js';
import { backReportingFragment } from './back-reporting.js';
import { ceoReportingFragment } from './ceo-reporting.js';
import { delegationFragment } from './delegation.js';
import { receivingDelegationFragment } from './receiving-delegation.js';
import { escalationChainFragment } from './escalation-chain.js';
import { blockerEscalationFragment } from './blocker-escalation.js';
import { failureRecoveryFragment } from './failure-recovery.js';
import { channelEtiquetteFragment } from './channel-etiquette.js';
import { antiRationalizationFragment } from './anti-rationalization.js';
import { fixNowFragment } from './fix-now.js';
import { outputEfficiencyFragment } from './output-efficiency.js';
import { blastRadiusFragment } from './blast-radius.js';
import { fileLockingFragment } from './file-locking.js';
import { contextFragment } from './context.js';
import { historyFragment } from './history.js';
import { debateProtocolFragment } from './debate-protocol.js';
import { agentCommunicationFragment } from './agent-communication.js';
import { inboxFragment } from './inbox.js';
import { ccCliFragment } from './cc-cli.js';
import { dredgeFragment } from './dredge.js';
import { coordinatorFragment } from './coordinator.js';
import { toolResultManagementFragment } from './tool-result-management.js';
import { contextPersistenceFragment } from './context-persistence.js';
import { scratchpadFragment } from './scratchpad.js';
import { checkpointFragment } from './checkpoint.js';
import { autoemonFragment } from './autoemon.js';
import { brainFragment } from './brain.js';
import { cultureFragment } from './culture.js';

const FRAGMENTS: Fragment[] = [
  autoemonFragment,
  brainFragment,
  cultureFragment,
  workspaceFragment,
  toolResultManagementFragment,
  contextPersistenceFragment,
  scratchpadFragment,
  taskExecutionFragment,
  backReportingFragment,
  ceoReportingFragment,
  delegationFragment,
  receivingDelegationFragment,
  escalationChainFragment,
  blockerEscalationFragment,
  failureRecoveryFragment,
  channelEtiquetteFragment,
  fixNowFragment,
  antiRationalizationFragment,
  outputEfficiencyFragment,
  checkpointFragment,
  blastRadiusFragment,
  fileLockingFragment,
  debateProtocolFragment,
  agentCommunicationFragment,
  inboxFragment,
  dredgeFragment,
  coordinatorFragment,
  ccCliFragment,
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
