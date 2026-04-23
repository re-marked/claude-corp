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
  runAudit,
  getCurrentStep,
  casketExists,
  inferKind,
  promotePendingHandoff,
  type Chit,
  type HookInput,
  type AuditDecision,
  type AuditInput,
  type HookEventName,
  type Member,
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
  // Every exception in hook mode falls through to fail-open: log the
  // error, emit approve, exit 0. Trapping a session in a broken state
  // is the worst failure mode; silent-skipped blocks are recoverable.
  try {
    await runHookPath(opts);
  } catch (err) {
    try {
      const corpRoot = await getCorpRoot();
      if (opts.agent) logAuditError(corpRoot, opts.agent, err);
    } catch {
      /* corpRoot resolution itself failed; nothing to log to */
    }
    emitDecision({ decision: 'approve' });
  }
}

async function runHookPath(opts: AuditOpts): Promise<void> {
  const hookInput = readHookInputFromStdin();
  const stopHookActive = hookInput.stop_hook_active === true;
  const event = normalizeEvent(hookInput.hook_event_name);

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

  // Check override marker FIRST — even before stop_hook_active. If
  // the founder explicitly unblocked, the agent should exit cleanly
  // on this very invocation, not wait for an extra turn.
  if (consumePendingOverride(corpRoot, slug)) {
    logAuditDecision(corpRoot, slug, { decision: 'approve' }, { reason: 'override-consumed' });
    approveAndMaybePromote(corpRoot, slug);
    return;
  }

  const member = resolveMember(corpRoot, slug);
  if (!member) {
    // Unknown agent; substrate gap. Fail-open. Skip promotion — no
    // member means we can't find their workspace anyway.
    logAuditError(corpRoot, slug, new Error(`member not found for slug: ${slug}`));
    emitDecision({ decision: 'approve' });
    return;
  }

  const kind = inferKind(member.rank);
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
    approveAndMaybePromote(corpRoot, slug);
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
    approveAndMaybePromote(corpRoot, slug);
  } else {
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
function approveAndMaybePromote(corpRoot: string, slug: string): void {
  try {
    const workspace = findAgentWorkspace(corpRoot, slug);
    if (workspace) {
      const promotion = promotePendingHandoff(corpRoot, slug, workspace);
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
            promotionErrors: promotion.errors,
          },
        );
      }
    }
  } catch (err) {
    logAuditError(corpRoot, slug, err);
  }
  emitDecision({ decision: 'approve' });
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
