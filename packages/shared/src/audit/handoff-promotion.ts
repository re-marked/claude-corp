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
  closeChit,
  chitScopeFromPath,
} from '../chits.js';
import { advanceCurrentStep, getCurrentStep } from '../casket.js';
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
  /**
   * Path to the written WORKLOG.md (null when nothing to promote).
   *
   * @deprecated Project 1.6 — WORKLOG.md write removed; the handoff
   * chit is the canonical record. Field preserved as `null` for
   * backward-compat with audit.ts's observability logging; next
   * major version removes the field from the type entirely.
   */
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

  // 2. WORKLOG.md write REMOVED (Project 1.6). Pre-1.6 this path
  // overwrote WORKLOG.md with an <handoff> XML block + a Session
  // Summary markdown section, both machine-readable (Dredge parsed
  // the markdown; readWorklogHandoff parsed the XML). Now both
  // readers are gone — wtf reads the handoff CHIT, Dredge is
  // deleted. The chit is the canonical handoff record.
  //
  // Side benefit: the old behavior FULL-OVERWROTE WORKLOG.md,
  // which destroyed any agent-authored work log content on every
  // audit approve. Removing the write stops that destruction —
  // WORKLOG.md now stays a durable agent journal (written by the
  // agent via their Write tool, read by dreams / context-fragment
  // / workspace-fragment as "recent history" hints).
  //
  // Audit trail tradeoff: handoff chits have 24h TTL with
  // destroy-if-not-promoted. Consumed handoffs get GC'd one day
  // later. If indefinite audit visibility on session handoffs
  // becomes a pain point, flip the handoff type's destructionPolicy
  // to 'keep-forever' (then consumed handoffs go cold, not
  // destroyed). Deferred — file-level audit for handoff cadence
  // hasn't been requested.

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

// renderWorklogMarkdown + xmlEscape deleted in Project 1.6 — the
// handoff chit is now the canonical record. The matching helper for
// rendering chit fields as XML (when wtf needs XML output for its
// handoff block) lives in wtf-state.ts's handoffChitToXml.

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

// ─── Consumer side — Project 1.6 ───────────────────────────────────

/**
 * Read the agent's most-recently-created active handoff chit without
 * mutating it. Diagnostic / peek path — safe to call from debug tools
 * and `cc-cli wtf --peek` without triggering consumption semantics.
 *
 * "Latest" is by createdAt desc — normal flow produces exactly one
 * active handoff per session boundary, but if drift produces multiple
 * (concurrent writers, migration stragglers), peek returns the newest
 * and leaves the rest for a future sweep.
 *
 * Returns null when no active handoff exists for the agent — the
 * steady state during a session in progress (pre-first-done) or for
 * agents that haven't cycled a session yet.
 */
export function peekLatestHandoffChit(
  corpRoot: string,
  agentSlug: string,
): Chit<'handoff'> | null {
  try {
    const { chits } = queryChits<'handoff'>(corpRoot, {
      types: ['handoff'],
      statuses: ['active'],
      // Template literal of ChitScope shape — TS narrows the type via
      // `agent:${string}`'s union inclusion; the prior `as const` was
      // a no-op on a variable-templated string and read misleadingly.
      scopes: [(`agent:${agentSlug}`) as `agent:${string}`],
      sortBy: 'createdAt',
      sortOrder: 'desc',
      limit: 1,
    });
    const first = chits[0];
    return first ? first.chit : null;
  } catch {
    // Corrupt store / missing scope → no handoff, not an error. The
    // caller (wtf / dredge) degrades to no-handoff-block output.
    return null;
  }
}

/**
 * Read the latest active handoff chit AND close it atomically —
 * "atomic" here means the close fires from the same findChitById the
 * peek did, so concurrent wtf invocations compete via optimistic
 * concurrency at the chit layer.
 *
 * The close flips status: 'active' → 'closed' via closeChit (terminal).
 * The chit-lifecycle scanner's destroy-if-not-promoted policy then
 * GCs it at TTL age (24h default). Project 1.6 removed the WORKLOG.md
 * handoff write — the chit is now the ONLY session-handoff record;
 * when the chit GCs at TTL, the handoff trail is gone. If multi-day
 * handoff recall becomes a pain point, flip the handoff type's
 * destructionPolicy to 'keep-forever' so consumed handoffs go cold
 * instead of destroying. See the 1.6 PR tradeoff note.
 *
 * Returns the consumed chit so callers (wtf's handoff block) can
 * render its fields into output. Returns null when no active handoff
 * exists (steady-state in-session; no-op for callers).
 *
 * Concurrent consumption: if two wtf invocations race on the same
 * handoff, one's closeChit throws ChitConcurrentModificationError
 * (or hits the terminal-already-closed guard) — caller treats it as
 * "already consumed" and proceeds with no handoff block. Idempotent
 * in practice: whichever call wins owns the consumption; the loser
 * renders the same no-handoff fallback.
 */
export function consumeHandoffChit(
  corpRoot: string,
  agentSlug: string,
  consumedBy: string,
): Chit<'handoff'> | null {
  const chit = peekLatestHandoffChit(corpRoot, agentSlug);
  if (!chit) return null;
  try {
    closeChit(
      corpRoot,
      `agent:${agentSlug}` as const,
      'handoff',
      chit.id,
      'closed',
      consumedBy,
    );
  } catch {
    // Close failed (concurrent consumer closed first, or storage
    // write race). The handoff is effectively "already consumed"
    // from this caller's perspective — treat as no-handoff.
    return null;
  }
  return chit;
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
    // Next step is for someone else — chain ownership passes in THIS
    // contract. Keep scanning — the closed task might appear in
    // another contract whose next step IS assigned to us. Practically
    // each task belongs to exactly one contract so the loop finishes
    // without another match, but the early-return bug (review P5)
    // silently skipped legitimate second-contract matches.
    continue;
  }
  return null;
}

function stringify(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
