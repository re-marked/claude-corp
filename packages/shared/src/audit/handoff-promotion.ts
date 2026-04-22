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
import type { HandoffFields } from '../types/chit.js';

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

  // 4. Close the current task chit as completed. updateChit is used
  // directly because closeChit's default status behavior assumes the
  // caller wants `closed` — we want `completed` for "task done per
  // acceptance criteria." findChitById → verify type → updateChit.
  if (currentStepId) {
    try {
      closeTaskAsCompleted(corpRoot, currentStepId, payload.createdBy);
      result.closedTaskId = currentStepId;
    } catch (err) {
      result.errors.push(`close-task: ${stringify(err)}`);
    }
  }

  // 5. Clear Casket. Next session boots idle; 1.3's chain walker
  // (when it ships) intercepts here to advance to the next chain
  // step instead.
  try {
    advanceCurrentStep(corpRoot, agentSlug, null, payload.createdBy);
  } catch (err) {
    result.errors.push(`clear-casket: ${stringify(err)}`);
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
  updatedBy: string,
): void {
  const hit = findChitById(corpRoot, taskChitId);
  if (!hit) return;
  if (hit.chit.type !== 'task') return;
  // Already terminal? Skip — audit re-approves on the same state
  // shouldn't double-close a chit that's already in its resting form.
  const terminal = new Set(['completed', 'rejected', 'failed', 'closed']);
  if (terminal.has(hit.chit.status)) return;
  const scope = chitScopeFromPath(corpRoot, hit.path);
  updateChit(corpRoot, scope, 'task', taskChitId, {
    status: 'completed',
    updatedBy,
  });
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
