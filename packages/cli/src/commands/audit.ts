/**
 * cc-cli audit — the 0.7.3 Audit Gate command.
 *
 * Invoked by Claude Code's Stop hook (and PreCompact hook for Partners).
 * Reads the hook-input JSON from stdin, composes an AuditInput from
 * the agent's Casket + task chit + tier-3 inbox + session transcript,
 * runs the pure audit engine, and emits a JSON decision to stdout.
 *
 * Also invoked manually by the founder with `--override --agent <x>
 * --reason "..."` to create a one-shot bypass for when the gate traps
 * an agent in a state audit can't evaluate.
 *
 * Flow (hook mode):
 *   1. Read stdin JSON → HookInput (graceful on empty/TTY — manual testing).
 *   2. Resolve corpRoot + agent member record (slug → kind, displayName).
 *   3. Check pending override marker; if present, consume + approve.
 *   4. Resolve current task:
 *        a. Casket exists + currentStep set → findChitById(currentStep).
 *        b. Casket exists + currentStep null → find most-recent active Task
 *           chit assigned to slug (fallback until 1.4's hand wires Casket).
 *        c. Casket missing → undefined (substrate gap; engine fails open).
 *   5. Query open tier-3 inbox-item chits scoped to agent.
 *   6. Parse transcript from hook_input.transcript_path.
 *   7. Call runAudit(input) → AuditDecision.
 *   8. Append to agent's audit-log.jsonl (observability).
 *   9. Emit decision JSON to stdout, exit 0.
 *
 * Flow (override mode):
 *   1. Require --agent, --reason, --from (founder member id).
 *   2. Write one-shot marker to chits/_log/pending-overrides/<slug>.json.
 *   3. Append to chits/_log/audit-overrides.jsonl for permanent record.
 *   4. Print confirmation; exit 0. Next Stop invocation for that agent
 *      consumes the marker and approves automatically.
 *
 * Fail-open philosophy: every error path in hook mode emits
 * `{decision: "approve"}` and logs to `.audit-errors.log` in the
 * agent's workspace. Missing a block because the audit crashed is a
 * softer failure than trapping an agent in a broken state forever.
 * The error log surfaces systemic audit problems without breaking
 * sessions mid-work.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import {
  MEMBERS_JSON,
  findChitById,
  queryChits,
  parseTranscript,
  parseTranscriptBeforeCompact,
  runAudit,
  getCurrentStep,
  casketExists,
  resolveKind,
  promotePendingHandoff,
  revertTaskFromUnderReview,
  buildPreCompactInstructions,
  buildCheckpointObservation,
  createChit,
  extractLatestUsageFromTranscript,
  type Chit,
  type ContractFields,
  type HookInput,
  type AuditDecision,
  type AuditInput,
  type HookEventName,
  type Member,
  type CheckpointRecentActivity,
} from '@claudecorp/shared';
import { getCorpRoot } from '../client.js';
import { readFileSync as fsReadSync } from 'node:fs';

export interface AuditOpts {
  agent?: string;
  override?: boolean;
  reason?: string;
  from?: string;
  json?: boolean;
}

export async function cmdAudit(opts: AuditOpts): Promise<void> {
  if (opts.override) {
    await handleOverride(opts);
    return;
  }
  await handleHook(opts);
}

// ─── Override mode (founder-only escape valve) ──────────────────────

async function handleOverride(opts: AuditOpts): Promise<void> {
  if (!opts.agent) fail('--agent <slug> required with --override');
  if (!opts.reason || opts.reason.trim().length < 3) {
    fail('--reason "..." required with --override (minimum 3 chars — be specific)');
  }
  if (!opts.from) fail('--from <member-id> required with --override (who\'s authorizing)');

  const corpRoot = await getCorpRoot();
  const pendingDir = join(corpRoot, 'chits', '_log', 'pending-overrides');
  const logPath = join(corpRoot, 'chits', '_log', 'audit-overrides.jsonl');
  mkdirSync(pendingDir, { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });

  const now = new Date().toISOString();
  const record = {
    agent: opts.agent,
    reason: opts.reason.trim(),
    createdAt: now,
    createdBy: opts.from,
  };

  // One-shot marker consumed by the next audit invocation for this agent.
  writeFileSync(join(pendingDir, `${opts.agent}.json`), JSON.stringify(record, null, 2), 'utf-8');

  // Permanent audit trail — overrides must always be traceable post-hoc.
  appendFileSync(logPath, JSON.stringify({ ...record, event: 'override-issued' }) + '\n', 'utf-8');

  console.log(
    `audit override issued for agent "${opts.agent}". The next audit invocation will approve ` +
      `once and clear the marker. Reason logged to chits/_log/audit-overrides.jsonl.`,
  );
}

// ─── Hook mode (invoked by Claude Code Stop / PreCompact) ───────────

async function handleHook(opts: AuditOpts): Promise<void> {
  // Read the hook input up front so the fail-open catch below can
  // branch its output format on the event name. stdin is read-once —
  // we can't recover the event after an exception if we don't have it.
  // readHookInputFromStdin already fail-softs to `{}` on any parse
  // error, so this read itself can't throw.
  const hookInput = readHookInputFromStdin();
  const event = normalizeEvent(hookInput.hook_event_name);

  // Every exception in hook mode falls through to fail-open: log the
  // error, emit the event-appropriate "do nothing" signal, exit 0.
  // Trapping a session in a broken state is the worst failure mode;
  // silent-skipped blocks are recoverable.
  //
  // Event-appropriate output (Codex P2 reviewer catch, PR #170):
  //   - Stop  → emit `{decision:'approve'}` JSON so Claude Code ends
  //     the gating cleanly. That's the audit envelope the Stop hook
  //     protocol consumes.
  //   - PreCompact → emit NOTHING. PreCompact stdout is consumed as
  //     summary-shaping text merged into the summarization prompt; a
  //     stray `{decision:'approve'}` would land as policy text inside
  //     the compaction's merged instructions and corrupt the summary.
  //     Empty stdout = "no extra instructions," which is exactly the
  //     fail-open semantics we want at the compact boundary.
  try {
    await runHookPath(opts, hookInput, event);
  } catch (err) {
    try {
      const corpRoot = await getCorpRoot();
      if (opts.agent) logAuditError(corpRoot, opts.agent, err);
    } catch {
      /* corpRoot resolution itself failed; nothing to log to */
    }
    if (event === 'PreCompact') {
      // No stdout. Exit 0 so Claude Code treats it as a clean no-op.
      return;
    }
    emitDecision({ decision: 'approve' });
  }
}

async function runHookPath(
  opts: AuditOpts,
  hookInput: HookInput,
  event: HookEventName,
): Promise<void> {
  const stopHookActive = hookInput.stop_hook_active === true;

  const corpRoot = await getCorpRoot();

  if (!opts.agent) {
    // No agent slug → can't resolve casket/member. Fail-open + log.
    // No promotion here either — without an agent slug we can't find
    // the workspace where .pending-handoff.json would live.
    logAuditError(corpRoot, 'unknown', new Error('--agent flag required on audit hook invocation'));
    emitDecision({ decision: 'approve' });
    return;
  }

  const slug = opts.agent;

  const member = resolveMember(corpRoot, slug);
  if (!member) {
    // Unknown agent; substrate gap. Fail-open. Skip promotion — no
    // member means we can't find their workspace anyway.
    logAuditError(corpRoot, slug, new Error(`member not found for slug: ${slug}`));
    emitDecision({ decision: 'approve' });
    return;
  }

  // Honor the explicit Member.kind field (1.1) when set; fall back to
  // rank-based inference only for pre-1.1 legacy records. inferKind
  // alone would silently ignore `cc-cli tame`-promoted Partners whose
  // rank stays worker — the PreCompact branch would then render the
  // employee template (empty) and skip the auto-checkpoint write.
  const kind = resolveKind(member);

  // PreCompact branches early — the contract is fundamentally different
  // from Stop. Claude Code merges our stdout into its summarization
  // prompt via mergeHookInstructions (leaked source:
  // services/compact/autoCompact.ts). So instead of running the audit
  // gate + emitting {decision}, we emit summary-shaping instructions
  // that bias what the summarizer preserves across the compact boundary.
  // Fail-open: if the template returns empty (e.g. employee kind for
  // now), emit nothing — Claude Code treats absent stdout as no extra
  // instructions, same as before the hook existed.
  if (event === 'PreCompact') {
    // Auto-checkpoint first — write a CHECKPOINT observation chit
    // capturing the Partner's state at the compact boundary BEFORE
    // stdout fires. The summary-shaping text biases what survives; the
    // checkpoint chit guarantees the Partner has a durable
    // externalization even if the summarizer drops something. Fail-soft:
    // any error in the checkpoint write falls through to the
    // summary-shaping path so we never lose that mechanism to a
    // persistence hiccup.
    const checkpointChitId = writeAutoCheckpoint(
      corpRoot,
      slug,
      member,
      kind,
      hookInput,
    );

    const instructions = buildPreCompactInstructions({
      hookInput,
      kind,
      agentDisplayName: member.displayName,
      agentSlug: slug,
    });
    logAuditDecision(
      corpRoot,
      slug,
      { decision: 'approve' },
      {
        event: 'pre-compact-instructions',
        trigger: hookInput.trigger ?? null,
        emitted: instructions.length > 0,
        customInstructionsPresent: typeof hookInput.custom_instructions === 'string'
          && hookInput.custom_instructions.trim().length > 0,
        checkpointChitId,
      },
    );
    if (instructions) process.stdout.write(instructions + '\n');
    // Do NOT emit AuditDecision JSON — PreCompact's output protocol is
    // raw text merged into the summary prompt, not the {decision,reason}
    // envelope. Emitting both would confuse the summarizer.
    //
    // Note: override markers are intentionally NOT consumed on PreCompact
    // (Codex P1 reviewer catch, PR #170). A founder-issued one-shot
    // override is meant to unblock the next Stop gate; burning it on a
    // PreCompact that doesn't even run the gate defeats the intended
    // one-shot semantics — the subsequent Stop would block again while
    // the marker was already gone. Consumption moved to AFTER this
    // branch so only the Stop-gate path clears it.
    return;
  }

  // Check override marker — Stop-only. If the founder explicitly
  // unblocked this agent, exit cleanly on this very invocation without
  // running the audit engine. PreCompact paths above don't touch the
  // marker so a one-shot override survives any intervening compactions.
  if (consumePendingOverride(corpRoot, slug)) {
    logAuditDecision(corpRoot, slug, { decision: 'approve' }, { reason: 'override-consumed' });
    await approveAndMaybePromote(corpRoot, slug);
    return;
  }

  const currentTask = resolveCurrentTask(corpRoot, slug);
  const openTier3Inbox = queryOpenTier3Inbox(corpRoot, slug);

  const transcriptPath =
    typeof hookInput.transcript_path === 'string' ? hookInput.transcript_path : '';
  const transcriptAvailable = Boolean(transcriptPath) && existsSync(transcriptPath);

  // Fail-open on transcript unavailable WHEN a task is active.
  // Rationale: the engine's evidence gate flags missing build/tests/
  // git-status as universal gaps. Without a transcript we can't see
  // ANY evidence — so every run would block with gaps the agent has
  // no observable way to satisfy (their real tool use happened but
  // we couldn't read it). That's not a gate; that's a trap. Idle
  // agents (currentTask === null) don't hit this because there's no
  // evidence gate to fall through to — the engine approves or falls
  // to the tier-3 inbox check, which is independent of transcript.
  if (currentTask !== null && currentTask !== undefined && !transcriptAvailable) {
    logAuditError(
      corpRoot,
      slug,
      new Error(
        `transcript_path missing or unreadable (value=${JSON.stringify(transcriptPath)}); ` +
          'fail-open on evidence gate — trapping a session on substrate unavailability is worse than missing one block',
      ),
    );
    logAuditDecision(
      corpRoot,
      slug,
      { decision: 'approve' },
      { event: 'transcript-unavailable-fail-open', taskId: currentTask.id },
    );
    await approveAndMaybePromote(corpRoot, slug);
    return;
  }

  const recent = transcriptAvailable
    ? parseTranscript(transcriptPath)
    : { toolCalls: [], touchedFiles: [], assistantText: [] };

  const auditInput: AuditInput = {
    stopHookActive,
    currentTask,
    openTier3Inbox,
    recent,
    event,
    kind,
    agentDisplayName: member.displayName,
  };

  const decision = runAudit(auditInput);

  logAuditDecision(corpRoot, slug, decision, {
    event,
    stopHookActive,
    taskId: currentTask?.id,
    tier3Count: openTier3Inbox.length,
  });

  if (decision.decision === 'approve') {
    await approveAndMaybePromote(corpRoot, slug);
  } else {
    // Block: revert the Casket-current task from under_review back to
    // in_progress via the 1.3 state machine so the agent sees the
    // right state after they address the audit reason and retry. Best-
    // effort — logged on failure, never blocks the block emission.
    try {
      const revert = revertTaskFromUnderReview(corpRoot, slug);
      if (revert.reverted || revert.reason) {
        logAuditDecision(corpRoot, slug, decision, {
          event: 'block-revert',
          revertedTaskId: revert.taskId ?? null,
          revertedReason: revert.reason ?? null,
        });
      }
    } catch (err) {
      logAuditError(corpRoot, slug, err);
    }
    emitDecision(decision);
  }
}

// ─── Promotion on approve ───────────────────────────────────────────

/**
 * Every approve path that holds a valid agent slug routes through here
 * so a pending handoff (from `cc-cli done`) gets promoted to WORKLOG.md
 * + handoff chit + task close + Casket clear before the session ends.
 *
 * Promotion is best-effort: if it fails, we still emit approve (the
 * agent's session still ends). Any errors are logged to the agent's
 * .audit-log.jsonl so the founder can inspect afterwards. Trapping
 * the session because promotion failed would violate the fail-open
 * invariant the audit command holds everywhere else.
 *
 * No-ops cleanly when there's no .pending-handoff.json — approves
 * that didn't come from a `cc-cli done` (e.g. override, idle, tier-3-
 * clear) skip the promotion path harmlessly.
 */
async function approveAndMaybePromote(corpRoot: string, slug: string): Promise<void> {
  try {
    const workspace = findAgentWorkspace(corpRoot, slug);
    if (workspace) {
      // Project 1.12: 1.12-aware corps defer the task close + chain
      // walk during promotion — those happen later (clearance-state
      // transition via enterClearance, then completed-state via
      // markSubmissionMerged when Pressman lands the merge).
      const { isClearinghouseAwareCorp } = await import('@claudecorp/daemon');
      const clearinghouseActive = isClearinghouseAwareCorp(corpRoot);
      const promotion = promotePendingHandoff(corpRoot, slug, workspace, {
        deferTaskClose: clearinghouseActive,
      });
      if (promotion.promoted) {
        logAuditDecision(
          corpRoot,
          slug,
          { decision: 'approve' },
          {
            event: 'handoff-promoted',
            worklogPath: promotion.worklogPath,
            handoffChitId: promotion.handoffChitId,
            closedTaskId: promotion.closedTaskId,
            clearinghouseActive,
            // Project 1.3: chain walker deltas surfaced for founder
            // visibility. dependentsNowReady + cascadedBlocked get
            // derived from the deltas the walker returned when the
            // closed task got promoted. Application of the state
            // transitions named in these deltas is task-watcher /
            // task-events' responsibility (they own re-dispatch and
            // Casket pointer updates); this log entry makes the
            // cascade observable without coupling.
            chainDeltas: promotion.chainDeltas,
            dependentsNowReady: promotion.chainDeltas
              .filter((d) => d.trigger === 'unblock')
              .map((d) => d.chitId),
            cascadedBlocked: promotion.chainDeltas
              .filter((d) => d.trigger === 'block')
              .map((d) => d.chitId),
            promotionErrors: promotion.errors,
          },
        );

        // Project 1.12: fire enterClearance to push branch + create
        // submission + advance task workflow. Best-effort: failures
        // log to the audit trail but don't block the approve emit
        // (the agent's session still ends; the founder can recover
        // via cc-cli clearinghouse submit or by inspecting the log).
        if (clearinghouseActive && promotion.closedTaskId) {
          await fireEnterClearance(corpRoot, slug, promotion.closedTaskId, workspace);
        }
      }
    }
  } catch (err) {
    logAuditError(corpRoot, slug, err);
  }
  emitDecision({ decision: 'approve' });
}

/**
 * Project 1.12: enterClearance side trip on audit approve. Resolves
 * the contract id from the task chit's parent contract, derives the
 * branch from the worktree, fires enterClearance, logs the result.
 *
 * Best-effort everywhere — the agent's session ends regardless of
 * outcome. Errors land in `.audit-log.jsonl` for retrospective.
 */
async function fireEnterClearance(
  corpRoot: string,
  slug: string,
  taskId: string,
  workspacePath: string,
): Promise<void> {
  try {
    const { enterClearance } = await import('@claudecorp/daemon');

    // Resolve contractId — task chits don't carry a parent ref;
    // walk contracts and find the one whose taskIds includes us.
    const contractId = findContractContainingTask(corpRoot, taskId);
    if (!contractId) {
      logAuditDecision(corpRoot, slug, { decision: 'approve' }, {
        event: 'enter-clearance-skipped',
        reason: 'no contract contains this task',
        taskId,
      });
      return;
    }

    // Derive branch via git in the worktree. Fall through with a
    // logged skip if it can't be read (worktree isn't a git repo,
    // detached HEAD, etc.) — agent gets to retry manually via
    // cc-cli clearinghouse submit if needed.
    const branch = readCurrentBranch(workspacePath);
    if (!branch || branch === 'HEAD' || branch === 'main') {
      logAuditDecision(corpRoot, slug, { decision: 'approve' }, {
        event: 'enter-clearance-skipped',
        reason: branch
          ? `worktree on '${branch}' — refusing to merge into itself`
          : 'could not read current branch',
        taskId,
        contractId,
      });
      return;
    }

    const result = await enterClearance({
      corpRoot,
      taskId,
      contractId,
      branch,
      submitter: slug,
      worktreePath: workspacePath,
      // PR 3 default: Editor doesn't exist yet, every submission
      // gets reviewBypassed: true. PR 4 will pass this from
      // Editor's approve / cap-hit decision.
      reviewBypassed: true,
      reviewRound: 0,
    });

    if (result.ok) {
      logAuditDecision(corpRoot, slug, { decision: 'approve' }, {
        event: 'enter-clearance-success',
        taskId,
        contractId,
        branch,
        submissionId: result.value.submissionId,
        pushedSha: result.value.pushedSha ?? null,
      });
    } else {
      logAuditDecision(corpRoot, slug, { decision: 'approve' }, {
        event: 'enter-clearance-failed',
        taskId,
        contractId,
        branch,
        category: result.failure.category,
        summary: result.failure.pedagogicalSummary,
        retryable: result.failure.retryable,
      });
    }
  } catch (err) {
    logAuditError(corpRoot, slug, err);
  }
}

/**
 * Find the contract chit whose taskIds includes the given task id.
 * Returns the contract's chit id or null when no contract claims it
 * (standalone task — clearinghouse flow doesn't apply).
 */
function findContractContainingTask(corpRoot: string, taskId: string): string | null {
  try {
    const result = queryChits<'contract'>(corpRoot, { types: ['contract'] });
    for (const cwb of result.chits) {
      const fields = cwb.chit.fields.contract as ContractFields;
      if (fields.taskIds?.includes(taskId)) return cwb.chit.id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the worktree's current branch via git. Returns null on any
 * failure (not a repo, detached HEAD, git missing, etc.) — caller
 * surfaces a skip-with-reason rather than crashing.
 */
function readCurrentBranch(worktreePath: string): string | null {
  try {
    // Synchronous spawn via child_process.execFileSync. Bounded
    // 5s timeout so a hung git can't lock the audit hook.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const output = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5000,
    });
    const branch = output.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

// ─── Stdin reader ───────────────────────────────────────────────────

/**
 * Read the hook input JSON from stdin. Claude Code writes the JSON
 * and closes stdin; a synchronous read of fd 0 picks it up. If stdin
 * is a TTY (manual test invocation), return an empty HookInput —
 * lets operators run `cc-cli audit --agent ceo` by hand to exercise
 * the fail-open path without hanging the terminal.
 */
function readHookInputFromStdin(): HookInput {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fsReadSync(0, 'utf-8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HookInput;
    }
    return {};
  } catch {
    return {};
  }
}

// ─── Resolvers ──────────────────────────────────────────────────────

function resolveMember(corpRoot: string, slug: string): Member | null {
  try {
    const membersPath = join(corpRoot, MEMBERS_JSON);
    if (!existsSync(membersPath)) return null;
    const members = JSON.parse(readFileSync(membersPath, 'utf-8')) as Member[];
    return members.find((m) => m.id === slug) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the task chit to audit. Casket is the single source of truth
 * — no fallback guessing. If currentStep is a valid task chit id, we
 * audit that task. If it's null, the agent is idle (approve cleanly,
 * nothing to gate). If Casket doesn't exist or points at a missing
 * chit, that's a substrate gap (fail-open).
 *
 * Returns:
 *   Chit<'task'>  — the task we're auditing
 *   null          — Casket exists, currentStep is null (agent is idle)
 *   undefined     — substrate gap (no Casket, or pointer → missing chit)
 *
 * The deliberate absence of a most-recent-active-task fallback is the
 * honest answer to "what if Casket is empty?" — Casket empty means
 * idle, not "guess my task." Whoever assigns work is responsible for
 * setting the Casket pointer (task-create does this when --assignee
 * is passed; 1.4's hand rewrite will extend the surface).
 */
/**
 * Write the auto-checkpoint observation chit for Project 1.7's
 * PreCompact path. Pure composition over shared primitives
 * (buildCheckpointObservation + createChit + parseTranscript +
 * resolveCurrentTask). Fail-soft: any exception returns null so the
 * caller can proceed to summary-shaping without losing that mechanism.
 *
 * Returns the new chit id on success, null on employee-kind (builder
 * opted out) or on any caught error. The id is useful for diagnostic
 * logging in the audit-log.jsonl entry so post-hoc inspection can
 * follow "PreCompact fired → checkpoint chit X written."
 */
function writeAutoCheckpoint(
  corpRoot: string,
  slug: string,
  member: Member,
  kind: 'partner' | 'employee',
  hookInput: HookInput,
): string | null {
  try {
    const task = resolveCurrentTask(corpRoot, slug);
    const casketRef =
      task && typeof task === 'object' && task !== null
        ? {
            chitId: task.id,
            title:
              typeof task.fields.task?.title === 'string' ? task.fields.task.title : null,
          }
        : null;

    let recent: CheckpointRecentActivity | null = null;
    const transcriptPath =
      typeof hookInput.transcript_path === 'string' ? hookInput.transcript_path : '';
    if (transcriptPath && existsSync(transcriptPath)) {
      // Codex P2 (PR #170): on manual-compact the most recent user turn
      // IS the `/compact` command, so plain parseTranscript returns
      // activity since that turn — usually empty (hook fires before the
      // assistant responds). Use the before-compact variant to skip
      // past the `/compact` turn and capture the agent's real last-
      // intent activity. On auto-compact (threshold-triggered, no user
      // turn), the variant's behavior matches parseTranscript — same
      // last user turn, same slice.
      const activity =
        hookInput.trigger === 'manual'
          ? parseTranscriptBeforeCompact(transcriptPath)
          : parseTranscript(transcriptPath);
      recent = { assistantText: activity.assistantText ?? [] };
    }
    // Token snapshot at the compact boundary. Fail-soft — extractor
    // returns null if the transcript is absent/malformed/emits no
    // usage events; the checkpoint still writes without the Token
    // snapshot line. The daemon's in-memory lastAgentUsage map is
    // richer but lives in a separate process — reading the transcript
    // keeps this CLI-process-local.
    const tokens = transcriptPath ? extractLatestUsageFromTranscript(transcriptPath) : null;

    const spec = buildCheckpointObservation({
      hookInput,
      kind,
      agentDisplayName: member.displayName,
      agentSlug: slug,
      casket: casketRef,
      recent,
      tokens,
    });

    if (!spec) return null;

    const checkpoint = createChit(corpRoot, {
      type: 'observation',
      scope: spec.scope,
      createdBy: spec.createdBy,
      tags: [...spec.tags],
      body: spec.body,
      ephemeral: spec.ephemeral,
      fields: spec.fields,
    });
    return checkpoint.id;
  } catch (err) {
    logAuditError(corpRoot, slug, err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}

function resolveCurrentTask(
  corpRoot: string,
  slug: string,
): Chit<'task'> | null | undefined {
  if (!casketExists(corpRoot, slug)) return undefined;

  const currentStep = getCurrentStep(corpRoot, slug);
  if (currentStep === null) return null; // idle
  if (typeof currentStep !== 'string') return undefined; // Casket malformed

  const hit = findChitById(corpRoot, currentStep);
  if (hit && hit.chit.type === 'task') return hit.chit as Chit<'task'>;
  // Casket points at a chit that's missing or the wrong type — treat as
  // substrate gap rather than silently proceeding without audit.
  return undefined;
}

function queryOpenTier3Inbox(corpRoot: string, slug: string): Chit<'inbox-item'>[] {
  try {
    // queryChits returns ChitWithBody[] ({ chit, body, path }), not
    // raw Chit[] — the prior shape cast the wrapper directly to Chit
    // which passed tsc only via `as` but accessed .fields on the
    // wrapper (undefined at runtime), so every filter returned []
    // and tier-3 items never actually blocked the audit gate.
    //
    // Typed generic narrows chit to Chit<'inbox-item'> with no cast
    // needed; .map pulls out the chit payload; filter predicates
    // reach fields through the real path.
    const result = queryChits<'inbox-item'>(corpRoot, {
      types: ['inbox-item'],
      statuses: ['active'],
      scopes: [`agent:${slug}` as const],
      limit: 200,
    });
    return result.chits
      .map((w) => w.chit)
      .filter((c) => {
        const f = c.fields['inbox-item'];
        // Tier 3 + still-active + NOT carried forward. Carry-forward
        // is 0.7.4's explicit escape valve: the agent has acknowledged
        // the item and documented what they're waiting on, so it
        // doesn't block the audit gate even though status remains
        // 'active' (the item isn't resolved, just deferred). The next
        // session's wtf header still surfaces carried items for
        // visibility until real resolution lands.
        return f?.tier === 3 && f?.carriedForward !== true;
      });
  } catch {
    return [];
  }
}

// ─── Override marker consumption ────────────────────────────────────

function consumePendingOverride(corpRoot: string, slug: string): boolean {
  const pendingPath = join(corpRoot, 'chits', '_log', 'pending-overrides', `${slug}.json`);
  if (!existsSync(pendingPath)) return false;

  try {
    const record = JSON.parse(readFileSync(pendingPath, 'utf-8')) as {
      agent: string;
      reason: string;
      createdAt: string;
      createdBy: string;
    };

    // Consume: delete the one-shot marker so a single override doesn't
    // approve forever.
    unlinkSync(pendingPath);

    // Permanent trail of consumption.
    const logPath = join(corpRoot, 'chits', '_log', 'audit-overrides.jsonl');
    appendFileSync(
      logPath,
      JSON.stringify({ ...record, event: 'override-consumed', consumedAt: new Date().toISOString() }) +
        '\n',
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Normalizers ────────────────────────────────────────────────────

function normalizeEvent(raw: unknown): HookEventName {
  const known: HookEventName[] = ['Stop', 'PreCompact', 'SessionStart', 'UserPromptSubmit'];
  if (typeof raw === 'string' && (known as string[]).includes(raw)) return raw as HookEventName;
  // Unknown event (including missing hook_event_name) → default to Stop.
  // That's the most conservative mapping: Stop audits the same way the
  // other events would, and the prompt template's Stop wording is the
  // safe default.
  return 'Stop';
}

// ─── Output + logging ───────────────────────────────────────────────

function emitDecision(decision: AuditDecision): void {
  process.stdout.write(JSON.stringify(decision) + '\n');
}

function logAuditDecision(
  corpRoot: string,
  slug: string,
  decision: AuditDecision,
  context: Record<string, unknown>,
): void {
  try {
    const agentWorkspace = findAgentWorkspace(corpRoot, slug);
    if (!agentWorkspace) return;
    const path = join(agentWorkspace, '.audit-log.jsonl');
    appendFileSync(
      path,
      JSON.stringify({
        ts: new Date().toISOString(),
        slug,
        decision: decision.decision,
        // Reason is verbose on block; store a short preview for the log
        // and let the actual block response carry the full prompt.
        reasonPreview: decision.reason ? decision.reason.slice(0, 160) : undefined,
        ...context,
      }) + '\n',
      'utf-8',
    );
  } catch {
    /* best-effort observability */
  }
}

function logAuditError(corpRoot: string, slug: string, err: unknown): void {
  try {
    const agentWorkspace = findAgentWorkspace(corpRoot, slug);
    const path = agentWorkspace
      ? join(agentWorkspace, '.audit-errors.log')
      : join(corpRoot, 'chits', '_log', 'audit-errors.log');
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `[${new Date().toISOString()}] slug=${slug} error=${err instanceof Error ? err.message : String(err)}\n` +
        (err instanceof Error && err.stack ? `  ${err.stack}\n` : ''),
      'utf-8',
    );
  } catch {
    /* even error logging can fail on permissions; nothing to do */
  }
}

function findAgentWorkspace(corpRoot: string, slug: string): string | null {
  // Walk members.json to find the agent's agentDir, resolve absolute.
  // agentDir can be stored either as corp-relative (the common shape)
  // or as an absolute path (rare but supported by other codepaths —
  // e.g. agents whose workspaces live outside the corp tree). Mirror
  // cmdDone's logic here: when agentDir is absolute, use it verbatim.
  // `path.join(corpRoot, absolutePath)` does NOT collapse absolute
  // paths on Node (that's `path.resolve`), so a naive join yields a
  // bogus path like `<corp>/<absolute-drive>...` which silently fails
  // every downstream read.
  try {
    const membersPath = join(corpRoot, MEMBERS_JSON);
    if (!existsSync(membersPath)) return null;
    const members = JSON.parse(readFileSync(membersPath, 'utf-8')) as Member[];
    const member = members.find((m) => m.id === slug);
    if (!member?.agentDir) return null;
    return isAbsolute(member.agentDir) ? member.agentDir : join(corpRoot, member.agentDir);
  } catch {
    return null;
  }
}

// ─── CLI plumbing ───────────────────────────────────────────────────

function fail(msg: string): never {
  console.error(`cc-cli audit: ${msg}`);
  process.exit(1);
}
