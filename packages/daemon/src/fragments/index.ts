import type { Fragment, FragmentContext } from './types.js';
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

const FRAGMENTS: Fragment[] = [
  autoemonFragment,
  brainFragment,
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

/** Compose the system message from applicable fragments. */
export function composeSystemMessage(ctx: FragmentContext): string {
  return FRAGMENTS
    .filter((f) => f.applies(ctx))
    .map((f) => f.render(ctx))
    .join('\n\n');
}

export type { FragmentContext, Fragment, FragmentFn } from './types.js';
