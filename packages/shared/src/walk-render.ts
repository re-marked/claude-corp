/**
 * walk-render.ts — Project 2.2.1 — render walk-position as a string
 * block for the wtf header (and any future surface that wants the
 * same shape: dispatch fragments, walk-show CLI, TUI walk view).
 *
 * Pure function over WalkPosition + WalkProgress data — no chit
 * store reads, no I/O. Caller (the wtf-state orchestrator)
 * pre-resolves the walk via getWalkPosition + getWalkProgress and
 * passes both alongside `currentSlug` + `now` for "by you" framing
 * and relative-time labels.
 *
 * ### Three rendering states
 *
 * Audited and pinned during the Project 2.2 spec design pass:
 *
 *   1. **Walk-shaped task with full spec** — multi-line block:
 *        Walk: <name>  (cast <X> ago by <Y>)
 *        Current step: <id>  (step <i> of <N>)
 *          Previous: <prev> — completed by <Z>, <X> ago
 *          Next: <next> → blocked on this step
 *
 *   2. **Walk-shaped task with audit-degraded step** — same multi-line
 *      block PLUS an "audit-degraded" tag on the current-step line.
 *      Distinguishes pre-spec contracts (walk linkage exists; this
 *      step has no expectedOutput) from genuinely-ad-hoc tasks. The
 *      agent still sees they're on a walk; just knows the audit gate
 *      won't enforce mechanical-output for THIS step. Other walk
 *      surfaces (sexton patrol, handoff metadata) operate normally.
 *
 *   3. **Genuinely ad-hoc task** — one-liner:
 *        Walk: ad-hoc (no blueprint) — single-step task, no
 *        walk-aware audit will fire on this work.
 *
 * Conflating (2) and (3) would have agents on pre-spec walks
 * inferring "I'm ad-hoc, skip the walk surfaces" when they aren't.
 * The distinction matters mechanically.
 *
 * ### Why pre-rendered string flows through wtf-header opts
 *
 * Dependency-clean separation: wtf-state.ts is the orchestrator that
 * reads chits and computes data. wtf-header.ts is a pure template
 * that receives strings. This module sits between as the rendering
 * layer. wtf-header doesn't import this module; it receives the
 * walk block as a pre-rendered string opt. No import cycle risk.
 */

import type { WalkPosition, WalkProgress, WalkStep } from './walk.js';

// ─── Public types ──────────────────────────────────────────────────

/**
 * Input to renderWalkPositionBlock. `walkPos` null signals ad-hoc
 * (caller skips the getWalkPosition call entirely or it returned
 * null for any of its five documented null-return cases). Caller
 * controls the clock (`now`) so the renderer is deterministic and
 * testable.
 */
export interface RenderWalkInput {
  /** From getWalkPosition. Null = ad-hoc / no walk linkage. */
  readonly walkPos: WalkPosition | null;
  /**
   * From getWalkProgress on the contract. Null when walkPos is null,
   * OR when walkPos.contract has no resolvable progress (rare data
   * drift). Renderer degrades gracefully — uses what's available.
   */
  readonly walkProgress: WalkProgress | null;
  /** Slug of the agent the wtf header is being rendered for. Drives "by you" framing on prev steps. */
  readonly currentSlug: string;
  /** Current time for relative-age labels. Caller owns the clock. */
  readonly now: Date;
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Render walk-position as a string block. See module docstring for
 * the three rendering states. Ad-hoc returns a single line; walk-
 * shaped returns a multi-line block (no trailing newline — caller
 * inserts blank-line spacing as needed in the surrounding template).
 */
export function renderWalkPositionBlock(input: RenderWalkInput): string {
  if (input.walkPos === null) {
    return 'Walk: ad-hoc (no blueprint) — single-step task, no walk-aware audit will fire on this work.';
  }
  return renderWalkShaped(input.walkPos, input.walkProgress, input.currentSlug, input.now);
}

// ─── Walk-shaped rendering ─────────────────────────────────────────

function renderWalkShaped(
  walkPos: WalkPosition,
  walkProgress: WalkProgress | null,
  currentSlug: string,
  now: Date,
): string {
  const lines: string[] = [];

  // Line 1: "Walk: <name>  (cast <X> ago by <Y>)"
  // Cast time + author come from the contract chit.
  const contractCreatedAt = walkPos.contract.createdAt;
  const contractCreatedBy = walkPos.contract.createdBy;
  const castAgo = formatAge(contractCreatedAt, now);
  lines.push(`Walk: ${walkPos.blueprintName}  (cast ${castAgo} by ${contractCreatedBy})`);

  // Line 2: "Current step: <id>  (step <i> of <N>)<audit-degraded?>"
  // audit-degraded suffix when expectedOutput is null on the current
  // step's task (pre-spec contracts where the step lacks mechanical
  // output enforcement). Tag explicitly so agents understand this
  // step's audit behavior without reading code.
  const auditDegraded =
    walkPos.expectedOutput === null
      ? ' — audit-degraded (no expectedOutput on this step)'
      : '';
  lines.push(
    `Current step: ${walkPos.stepId}  (step ${walkPos.stepIndex} of ${walkPos.totalSteps})${auditDegraded}`,
  );

  // Lines 3+: Previous + Next sub-lines, indented. Renderer skips
  // each sub-line when it has nothing to say (top-of-chain has no
  // previous; terminal step has no next). Walk progress data drives
  // the prev/next status framing; if walkProgress is null we degrade
  // to a thinner block (just walk + current step).
  if (walkProgress !== null) {
    const prevLine = renderPreviousLine(walkPos, walkProgress, currentSlug, now);
    if (prevLine !== null) lines.push(prevLine);

    const nextLine = renderNextLine(walkPos, walkProgress);
    if (nextLine !== null) lines.push(nextLine);
  }

  return lines.join('\n');
}

/**
 * Render the "  Previous: ..." line, or null when there's no
 * previous step (top of chain) or previous step lookup fails.
 *
 * For linear walks (the common case), renders the single dependency.
 * For DAG fan-in (multiple dependencies), shows up to 3 with each
 * step's outcome; appends "+N more" for excess. Outcome framing
 * uses task status from walkProgress — completed steps say
 * "completed by <slug>, <X> ago"; failed steps say "failed by
 * <slug>"; in-progress steps say "in-progress by <slug>".
 */
function renderPreviousLine(
  walkPos: WalkPosition,
  walkProgress: WalkProgress,
  currentSlug: string,
  now: Date,
): string | null {
  const depIds = walkPos.step.dependsOn ?? [];
  if (depIds.length === 0) return null;

  // Look up each dependency's WalkStep entry to get task status + assignee.
  const prevEntries = depIds
    .map((depId) => walkProgress.steps.find((s) => s.stepId === depId))
    .filter((s): s is typeof walkProgress.steps[number] => s !== undefined);

  if (prevEntries.length === 0) return null;

  const cap = 3;
  const shown = prevEntries.slice(0, cap);
  const overflow = prevEntries.length - shown.length;

  const parts = shown.map((step) => formatPrevStep(step, walkProgress, currentSlug, now));
  const overflowSuffix = overflow > 0 ? `, +${overflow} more` : '';
  return `  Previous: ${parts.join('; ')}${overflowSuffix}`;
}

/**
 * Render the "  Next: ..." line, or null when terminal step (no
 * downstream steps depend on this one).
 *
 * For linear walks: single successor with status. For DAG fan-out:
 * up to 3 successors with each task status; "+N more" for excess.
 */
function renderNextLine(
  walkPos: WalkPosition,
  walkProgress: WalkProgress,
): string | null {
  // Find steps whose dependsOn includes this step's id.
  const successors = walkProgress.steps.filter((s) =>
    (s.step.dependsOn ?? []).includes(walkPos.stepId),
  );
  if (successors.length === 0) return null;

  const cap = 3;
  const shown = successors.slice(0, cap);
  const overflow = successors.length - shown.length;

  const parts = shown.map((step) => formatNextStep(step));
  const overflowSuffix = overflow > 0 ? `, +${overflow} more` : '';
  return `  Next: ${parts.join('; ')}${overflowSuffix}`;
}

// ─── Step-level formatting ─────────────────────────────────────────

/**
 * Format a previous-step entry as "<id> — <outcome>". Outcome is
 * derived from the prev task's workflowStatus + assignee. When the
 * task isn't found (taskId null in the WalkStep), say so honestly.
 */
function formatPrevStep(
  step: WalkStep,
  walkProgress: WalkProgress,
  currentSlug: string,
  now: Date,
): string {
  if (step.taskId === null || step.taskStatus === null) {
    return `${step.stepId} — no task`;
  }

  const status = step.taskStatus;
  // "by you" attribution compares the task chit's assignee field
  // (the LAST-WRITTEN assignee — slot-id once a specific Employee
  // picked the work up, or role-id while still in the role queue)
  // against the agent's current slug. The earlier draft compared
  // step.assigneeRole (the blueprint role like 'backend-engineer')
  // to the slot — always false. Self-audit found this and pinned
  // the fix to use the task's runtime assignee via taskAssignee.
  const assigneeIsMe = step.taskAssignee !== null && step.taskAssignee === currentSlug;
  const byClause = assigneeIsMe ? 'by you' : '';

  // status verb
  let verb: string;
  switch (status) {
    case 'completed':
      verb = 'completed';
      break;
    case 'failed':
      verb = 'failed';
      break;
    case 'rejected':
      verb = 'rejected';
      break;
    case 'cancelled':
      verb = 'cancelled';
      break;
    case 'blocked':
      verb = 'blocked';
      break;
    case 'in_progress':
      verb = 'in-progress';
      break;
    case 'under_review':
      verb = 'under review';
      break;
    case 'clearance':
      verb = 'in clearance';
      break;
    default:
      verb = status;
  }

  const ago = step.taskUpdatedAt ? formatAge(step.taskUpdatedAt, now) : 'unknown';
  const byPart = byClause ? ` ${byClause}` : '';
  return `${step.stepId} — ${verb}${byPart}, ${ago}`;
}

/**
 * Format a next-step entry as "<id> → <state>". State is the
 * task's workflowStatus rendered in human-friendly framing
 * relative to the agent's current position (e.g. "blocked on
 * this step" when the next step is queued/dispatched waiting on
 * the current step's completion).
 */
function formatNextStep(step: WalkStep): string {
  if (step.taskId === null || step.taskStatus === null) {
    return `${step.stepId} → no task`;
  }
  const status = step.taskStatus;
  let state: string;
  switch (status) {
    case 'queued':
    case 'dispatched':
      state = 'blocked on this step';
      break;
    case 'in_progress':
      state = 'in-progress';
      break;
    case 'blocked':
      state = 'blocked';
      break;
    case 'under_review':
      state = 'under review';
      break;
    case 'clearance':
      state = 'in clearance';
      break;
    case 'completed':
      state = 'completed';
      break;
    case 'failed':
      state = 'failed';
      break;
    case 'rejected':
      state = 'rejected';
      break;
    case 'cancelled':
      state = 'cancelled';
      break;
    default:
      state = status;
  }
  return `${step.stepId} → ${state}`;
}

// ─── Local age formatter ───────────────────────────────────────────

/**
 * Inline copy of formatAge from wtf-state.ts. Inlined here to avoid
 * an import cycle between walk-render and wtf-state — wtf-state is
 * the orchestrator that imports walk-render to call
 * renderWalkPositionBlock; if walk-render imported formatAge from
 * wtf-state, the cycle would break ESM resolution. Future cleanup
 * could extract formatAge into a tiny utility module both consumers
 * import from; out of scope for v1.
 */
function formatAge(iso: string, now: Date): string {
  const createdMs = Date.parse(iso);
  if (Number.isNaN(createdMs)) return 'unknown age';

  const deltaMs = now.getTime() - createdMs;
  if (deltaMs < 0) return 'just now';

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return seconds <= 1 ? 'just now' : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
