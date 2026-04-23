/**
 * Handoff promotion — the I/O dance that turns an approved
 * `.pending-handoff.json` (written by cc-cli done) into durable state.
 *
 * On audit approve, this function:
 *   1. Reads .pending-handoff.json from the agent's workspace.
 *   2. Writes WORKLOG.md with the handoff payload wrapped in the
 *      <handoff>...</handoff> XML Dredge knows how to parse. The current
 *      Dredge fragment (packages/daemon/src/fragments/dredge.ts) looks
 *      for a `## Session Summary` section — we include both the XML
 *      block (1.6-forward, structured) and a legible markdown form
 *      under that heading (current Dredge-compat) so the handoff
 *      works across the migration window without coupling.
 *   3. Creates a handoff chit (`type: 'handoff'`) carrying the same
 *      fields the pending file does. Ephemeral, scoped to the agent.
 *      Project 1.6's Dredge rewrite will read these instead of the
 *      free-form `## Session Summary`; shipping the chit today means
 *      1.6 has something to consume the day it lands.
 *   4. Closes the agent's current task chit as `completed` — uses the
 *      Casket's currentStep as the task id. If Casket is idle or
 *      pointer is malformed, this step is a no-op (audit already
 *      approved; no task to close is fine).
 *   5. Clears the Casket's currentStep to null so next session starts
 *      idle. When 1.3's chain walker lands, it'll take over this step
 *      (advance to next chain task instead of idle when a chain is
 *      active).
 *   6. Deletes `.pending-handoff.json` — the promotion is complete.
 *
 * Best-effort at every step: failures don't unwind previous steps
 * (no transactional rollback across files). A failure mid-promotion
 * leaves partial state visible in git diff — the founder can inspect
 * and finish manually. The alternative (rollback on failure) is worse:
 * two failure modes in one function, complex recovery logic, and the
 * "partial commit" state is already detectable.
 *
 * Returns a summary of what happened so the audit command can append
 * an observability line to .audit-log.jsonl.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  createChit,
  findChitById,
  updateChit,
  chitScopeFromPath,
} from '../chits.js';
import { advanceCurrentStep, getCurrentStep } from '../casket.js';
import { atomicWriteSync } from '../atomic-write.js';
import { validateTransition, TaskTransitionError } from '../task-state-machine.js';
import { advanceChain, nextReadyTask, type DependentDelta } from '../chain.js';
import { queryChits } from '../chits.js';
import type { Chit, HandoffFields, TaskFields } from '../types/chit.js';

export interface PendingHandoffPayload {
  predecessorSession: string;
  completed: string[];
  nextAction: string;
  openQuestion: string | null;
  sandboxState: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string;
}

export interface HandoffPromotionResult {
  /** True when a .pending-handoff.json was found and promoted. */
  promoted: boolean;
  /** Path to the written WORKLOG.md (null when nothing to promote). */
  worklogPath: string | null;
  /** Handoff chit id written (null when nothing to promote). */
  handoffChitId: string | null;
  /** Task chit id that was closed (null when no current task or already terminal). */
  closedTaskId: string | null;
  /**
   * Chain-walker deltas from the closed task's close event — dependents
   * that became newly-ready (trigger: 'unblock') or cascaded to blocked
   * (trigger: 'block'). Surfaced for audit observability; applying the
   * state transitions named here is the caller's responsibility (audit
   * command logs them to `.audit-log.jsonl` for the founder / daemon to
   * consume when the task-events integration lands).
   */
  chainDeltas: readonly DependentDelta[];
  /** Errors encountered mid-promotion (continue anyway; observability only). */
  errors: string[];
}

/**
 * Try to promote a pending handoff for the given agent. No-op when
 * there's no pending file — safe to call unconditionally on audit
 * approve. Never throws; all errors accumulate in the result.
 */
export function promotePendingHandoff(
  corpRoot: string,
  agentSlug: string,
  workspacePath: string,
): HandoffPromotionResult {
  const result: HandoffPromotionResult = {
    promoted: false,
    worklogPath: null,
    handoffChitId: null,
    closedTaskId: null,
    chainDeltas: [],
    errors: [],
  };

  const pendingPath = join(workspacePath, '.pending-handoff.json');
  if (!existsSync(pendingPath)) return result;

  let payload: PendingHandoffPayload;
  try {
    payload = JSON.parse(readFileSync(pendingPath, 'utf-8')) as PendingHandoffPayload;
  } catch (err) {
    result.errors.push(`parse-pending-handoff: ${stringify(err)}`);
    return result;
  }

  // Resolve the current task chit id from Casket. The audit already
  // decided to approve, so even if we can't read Casket here the
  // promotion should still write WORKLOG + handoff — the agent's work
  // shouldn't be lost just because the pointer resolution failed.
  let currentStepId: string | null = null;
  try {
    const cs = getCurrentStep(corpRoot, agentSlug);
    currentStepId = typeof cs === 'string' ? cs : null;
  } catch (err) {
    result.errors.push(`read-casket: ${stringify(err)}`);
  }

  // 2. WORKLOG.md — both XML-structured and human-readable markdown.
  const worklogPath = join(workspacePath, 'WORKLOG.md');
  try {
    const worklogContent = renderWorklogMarkdown(payload, currentStepId);
    atomicWriteSync(worklogPath, worklogContent);
    result.worklogPath = worklogPath;
  } catch (err) {
    result.errors.push(`write-worklog: ${stringify(err)}`);
  }

  // 3. Handoff chit. Ephemeral; the 0.6 lifecycle scanner destroys
  // unconsumed ones, keeping the per-agent chit store tidy across
  // many successful handoffs.
  try {
    const chitFields: HandoffFields = {
      predecessorSession: payload.predecessorSession,
      currentStep: currentStepId ?? '(unresolved)',
      completed: payload.completed,
      nextAction: payload.nextAction,
      openQuestion: payload.openQuestion,
      sandboxState: payload.sandboxState,
      notes: payload.notes,
    };
    const chit = createChit(corpRoot, {
      type: 'handoff',
      scope: `agent:${agentSlug}` as const,
      fields: { handoff: chitFields },
      createdBy: payload.createdBy,
      references: currentStepId ? [currentStepId] : [],
      body:
        `Handoff from \`${payload.predecessorSession}\` for \`${agentSlug}\`. ` +
        `See WORKLOG.md in the workspace for the markdown-rendered version.\n`,
    });
    result.handoffChitId = chit.id;
  } catch (err) {
    result.errors.push(`create-handoff-chit: ${stringify(err)}`);
  }

  // 4. Close the current task chit as completed AND transition the
  // 1.3 state machine (under_review → completed via audit-approve
  // trigger) AND capture the handoff's completed[] into
  // TaskFields.output so downstream chain steps can read what this
  // step produced without grepping the body. All three happen in one
  // updateChit so the terminal write is atomic relative to queries.
  if (currentStepId) {
    try {
      closeTaskAsCompleted(corpRoot, currentStepId, payload);
      result.closedTaskId = currentStepId;
    } catch (err) {
      result.errors.push(`close-task: ${stringify(err)}`);
    }
  }

  // 5a. Invoke the 1.3 chain walker on the closed task to compute
  // dependent deltas (unblock for newly-ready chits, block for
  // cascaded-failure). We surface the deltas via the result so the
  // caller can log them; we do NOT apply the state transitions here
  // because the audit-command layer owns that side (it has the
  // daemon context for re-dispatching, logging, updating other
  // Caskets). Future commit wires the delta application into
  // task-events.ts; for now this gives us real audit observability
  // of the cascade, bridging 1.3's pure primitive to the real flow.
  if (currentStepId) {
    try {
      const advance = advanceChain(corpRoot, currentStepId);
      result.chainDeltas = advance.dependentDeltas;
    } catch (err) {
      result.errors.push(`advance-chain: ${stringify(err)}`);
    }
  }

  // 5b. Advance THIS agent's Casket. Project 1.4 closes the 1.3
  // gap that used to unconditionally clear here:
  //
  //   - If the closed task was part of a Contract, walk the
  //     Contract's taskIds for the next ready step assigned to
  //     this same agent → point Casket at it, so the next session
  //     picks up immediately instead of booting idle.
  //   - Otherwise (task was standalone, OR next step is for
  //     someone else, OR contract done) → clear Casket to null,
  //     next session boots idle.
  //
  // We do NOT apply cascade deltas here (applyChainAdvance on
  // dependents of THIS close). task-watcher observes the terminal
  // close via fs.watch and fires applyChainAdvance there, which is
  // the single cascade-application point across the corp — firing
  // it here too would double-notify dependents' assignees (the
  // shared helper isn't aware of inter-caller dedup).
  let nextCasketStep: string | null = null;
  if (currentStepId) {
    try {
      nextCasketStep = findNextSameAgentChainStep(corpRoot, currentStepId, agentSlug);
    } catch (err) {
      result.errors.push(`next-chain-step: ${stringify(err)}`);
    }
  }
  try {
    advanceCurrentStep(corpRoot, agentSlug, nextCasketStep, payload.createdBy);
  } catch (err) {
    result.errors.push(`advance-casket: ${stringify(err)}`);
  }

  // 6. Delete pending. Even if previous steps errored, the pending
  // has been consumed — re-running promotion on the same payload
  // would create duplicate chits / double-close. Honest forward-only.
  try {
    unlinkSync(pendingPath);
  } catch (err) {
    result.errors.push(`delete-pending: ${stringify(err)}`);
  }

  result.promoted = true;
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Render the pending payload as WORKLOG.md. Two representations in
 * one file: the XML <handoff> block for structured consumers
 * (1.6-forward Dredge + audit replay tools) and a human-readable
 * `## Session Summary` section the CURRENT Dredge fragment parses.
 * The two are redundant during the migration window; 1.6 removes the
 * `## Session Summary` half.
 */
function renderWorklogMarkdown(
  payload: PendingHandoffPayload,
  currentStep: string | null,
): string {
  const lines: string[] = [];
  lines.push('<handoff>');
  lines.push(`  <predecessor-session>${xmlEscape(payload.predecessorSession)}</predecessor-session>`);
  lines.push(`  <current-step>${xmlEscape(currentStep ?? '(unresolved)')}</current-step>`);
  lines.push(`  <completed>`);
  for (const c of payload.completed) lines.push(`    <item>${xmlEscape(c)}</item>`);
  lines.push(`  </completed>`);
  lines.push(`  <next-action>${xmlEscape(payload.nextAction)}</next-action>`);
  if (payload.openQuestion) {
    lines.push(`  <open-question>${xmlEscape(payload.openQuestion)}</open-question>`);
  }
  if (payload.sandboxState) {
    lines.push(`  <sandbox-state>${xmlEscape(payload.sandboxState)}</sandbox-state>`);
  }
  if (payload.notes) lines.push(`  <notes>${xmlEscape(payload.notes)}</notes>`);
  lines.push(`  <created-at>${payload.createdAt}</created-at>`);
  lines.push(`  <created-by>${xmlEscape(payload.createdBy)}</created-by>`);
  lines.push(`</handoff>`);
  lines.push('');
  lines.push('## Session Summary');
  lines.push('');
  lines.push(`**Session:** ${payload.predecessorSession}`);
  lines.push(`**Task:** ${currentStep ?? '(none)'}`);
  lines.push(`**Next action:** ${payload.nextAction}`);
  if (payload.completed.length > 0) {
    lines.push('');
    lines.push('**Completed:**');
    for (const c of payload.completed) lines.push(`- ${c}`);
  }
  if (payload.openQuestion) {
    lines.push('');
    lines.push(`**Open question:** ${payload.openQuestion}`);
  }
  if (payload.sandboxState) {
    lines.push('');
    lines.push(`**Sandbox state:** ${payload.sandboxState}`);
  }
  if (payload.notes) {
    lines.push('');
    lines.push(`**Notes:** ${payload.notes}`);
  }
  lines.push('');
  return lines.join('\n');
}

function closeTaskAsCompleted(
  corpRoot: string,
  taskChitId: string,
  payload: PendingHandoffPayload,
): void {
  const hit = findChitById(corpRoot, taskChitId);
  if (!hit) return;
  if (hit.chit.type !== 'task') return;
  // Already terminal? Skip — audit re-approves on the same state
  // shouldn't double-close a chit that's already in its resting form.
  const terminal = new Set(['completed', 'rejected', 'failed', 'closed']);
  if (terminal.has(hit.chit.status)) return;

  const chit = hit.chit as Chit<'task'>;
  const currentWs = chit.fields.task.workflowStatus;

  // 1.3 state machine transition. Under normal flow the task is in
  // 'under_review' (flipped by `cc-cli done` before it wrote the
  // pending file). In substrate-gap cases (pre-1.3 chits missing
  // workflowStatus, override paths that bypassed done.ts's
  // transition, manual Casket pokes) the state may be whatever —
  // we still want to mark the task completed. Fall back gracefully:
  //   - workflowStatus present AND state machine accepts
  //     audit-approve from it → apply the validated next state
  //     (always 'completed' per the rules table).
  //   - workflowStatus missing OR state machine rejects → skip the
  //     workflowStatus update but still close the chit (chit.status
  //     moves to 'completed' so queries see it as done).
  // Either way downstream consumers see a completed task.
  const fieldUpdate: Partial<TaskFields> = {
    // Capture the agent's completed[] array as the canonical
    // task-level output. Joined with newlines for human readability;
    // Blueprint typed-I/O (Project 2.1) can layer a schema on top.
    // Empty completed[] → empty string, explicitly distinct from
    // undefined (the agent said 'done' but listed nothing — rare
    // but legal).
    output: payload.completed.join('\n'),
  };
  if (currentWs) {
    try {
      const nextWs = validateTransition(currentWs, 'audit-approve', chit.id);
      fieldUpdate.workflowStatus = nextWs;
    } catch (err) {
      // Leave workflowStatus at whatever it was; chit.status still
      // flips to 'completed' below. Surface in audit log for the
      // founder to inspect later — the promotion isn't rolled back
      // because audit has already decided to approve.
      if (err instanceof TaskTransitionError) {
        // Annotate the output so inspectors see the mismatch.
        fieldUpdate.output = (fieldUpdate.output ?? '') + `\n[note: workflowStatus transition skipped — ${err.message}]`;
      } else {
        throw err;
      }
    }
  }

  const scope = chitScopeFromPath(corpRoot, hit.path);
  updateChit(corpRoot, scope, 'task', taskChitId, {
    status: 'completed',
    fields: { task: fieldUpdate } as never,
    updatedBy: payload.createdBy,
  });
}

/**
 * Audit-block counterpart to the approve-path promotion. Called from
 * audit.ts when a handoff gets blocked; reverts the Casket-current
 * task's workflowStatus from under_review back to in_progress so the
 * agent can address the audit reason and retry `cc-cli done`.
 *
 * Best-effort — substrate gaps (missing Casket / task chit / pre-1.3
 * workflowStatus) skip with a logged reason rather than throw, same
 * fail-open posture as promotePendingHandoff.
 */
export interface RevertUnderReviewResult {
  reverted: boolean;
  taskId?: string;
  reason?: string;
}

export function revertTaskFromUnderReview(
  corpRoot: string,
  agentSlug: string,
): RevertUnderReviewResult {
  let currentStep: string | null | undefined;
  try {
    const cs = getCurrentStep(corpRoot, agentSlug);
    currentStep = typeof cs === 'string' ? cs : null;
  } catch (err) {
    return { reverted: false, reason: `read-casket: ${stringify(err)}` };
  }
  if (!currentStep) return { reverted: false, reason: 'no Casket currentStep to revert' };

  const hit = findChitById(corpRoot, currentStep);
  if (!hit || hit.chit.type !== 'task') {
    return { reverted: false, reason: `currentStep ${currentStep} did not resolve to a task chit` };
  }
  const chit = hit.chit as Chit<'task'>;
  const ws = chit.fields.task.workflowStatus;
  if (!ws) {
    return { reverted: false, taskId: chit.id, reason: 'task has no workflowStatus (pre-1.3)' };
  }

  let next;
  try {
    next = validateTransition(ws, 'audit-block', chit.id);
  } catch (err) {
    if (err instanceof TaskTransitionError) {
      return { reverted: false, taskId: chit.id, reason: err.message };
    }
    throw err;
  }

  const scope = chitScopeFromPath(corpRoot, hit.path);
  updateChit(corpRoot, scope, 'task', chit.id, {
    fields: { task: { workflowStatus: next } } as never,
    updatedBy: agentSlug,
  });

  return { reverted: true, taskId: chit.id };
}

/**
 * Walk the Contract(s) that contain the just-closed task and return
 * the id of the next ready task assigned to the same agent — the
 * Casket-advance target. Returns null when:
 *   - the closed task isn't in any Contract (standalone work)
 *   - the Contract has no more ready steps
 *   - the next ready step exists but is assigned to someone else
 *     (chain ownership passes to a different agent; this agent's
 *     Casket clears)
 *
 * Uses queryChits + nextReadyTask primitives; no new I/O surface
 * beyond what existed for 1.3. Tie-breaking on multiple contracts
 * containing the same task: first matching contract wins. In
 * practice each task belongs to exactly one contract, so the order
 * doesn't matter for normal corps.
 */
function findNextSameAgentChainStep(
  corpRoot: string,
  closedStepId: string,
  agentSlug: string,
): string | null {
  const { chits: contracts } = queryChits(corpRoot, {
    types: ['contract'],
    limit: 0,
  });
  for (const { chit } of contracts) {
    const taskIds =
      ((chit.fields as { contract?: { taskIds?: readonly string[] } }).contract?.taskIds) ?? [];
    if (!taskIds.includes(closedStepId)) continue;
    const next = nextReadyTask(corpRoot, chit.id, closedStepId);
    if (!next) continue;
    const nextAssignee = (next.fields.task as TaskFields).assignee;
    if (nextAssignee === agentSlug) return next.id;
    // Next step is for someone else — chain ownership passes; this
    // agent's Casket should clear, NOT advance to a task they're
    // not assigned to. Return null explicitly.
    return null;
  }
  return null;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stringify(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
