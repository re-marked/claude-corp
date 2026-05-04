/**
 * Chit — unified record primitive for Claude Corp.
 *
 * Every work-record in the corp (task, observation, contract, casket,
 * handoff, dispatch-context, pre-brain-entry, step-log) is a Chit of a
 * specific type. Common frontmatter carries identity, lifecycle, and links;
 * the `fields.<type>` block carries type-specific payload validated against
 * the type registry in chit-types.ts.
 *
 * Types here are pure — no runtime, no I/O. The registry and validators
 * live in chit-types.ts; CRUD lives in chits.ts.
 */

import type { ExpectedOutputSpec } from './expected-output.js';

// ─── Type registry (type names + per-type field shapes) ─────────────

/**
 * Registry of chit type id → per-type field shape. Adding a new chit type
 * means adding one entry here AND one entry in chit-types.ts's registry
 * config. The ChitTypeId union below is derived from this map's keys, so
 * the two can never drift.
 */
export interface FieldsForType {
  task: TaskFields;
  contract: ContractFields;
  observation: ObservationFields;
  casket: CasketFields;
  handoff: HandoffFields;
  'dispatch-context': DispatchContextFields;
  'pre-brain-entry': PreBrainEntryFields;
  'step-log': StepLogFields;
  'inbox-item': InboxItemFields;
  escalation: EscalationFields;
  blueprint: BlueprintFields;
  'sweeper-run': SweeperRunFields;
  kink: KinkFields;
  'breaker-trip': BreakerTripFields;
  'clearance-submission': ClearanceSubmissionFields;
  'review-comment': ReviewCommentFields;
  'lane-event': LaneEventFields;
  'pattern-observation': PatternObservationFields;
}

/**
 * Valid chit type ids, derived from the FieldsForType map. Keeping this
 * derived rather than hand-written means the union and the registry can't
 * get out of sync.
 */
export type ChitTypeId = keyof FieldsForType;

// ─── Status and scope vocabularies ──────────────────────────────────

/**
 * Full lifecycle vocabulary across all chit types. Type-specific lifecycles
 * are expressed in chit-types.ts by which subset of statuses a type accepts;
 * this enum is the full set.
 */
export type ChitStatus =
  | 'draft'
  | 'active'
  | 'review'
  /**
   * Project 1.12: contract is past review and waiting for all its
   * tasks' clearance-submissions to merge through the Clearinghouse
   * phase. Per-type registry gates which chit types can use this
   * status — adding it here doesn't make every chit type eligible.
   */
  | 'clearance'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'closed'
  | 'burning'
  /**
   * Reached only by the chit-lifecycle scanner: TTL-aged ephemeral chit
   * whose type has destructionPolicy='keep-forever' (observations) and
   * had no promotion signal. File stays on disk, stays queryable, but
   * scanner stops revisiting on subsequent ticks. Manually re-warmable
   * via `cc-cli chit update --status active`.
   */
  | 'cold';

/**
 * Scope determines ownership and where the chit lives on disk
 * (`<corpRoot>/<scope>/chits/<type>/<id>.md`). Scope is derived from file
 * path at read/write time and passed explicitly to CRUD functions — it's
 * not stored in frontmatter, so Chit itself doesn't carry it.
 */
export type ChitScope =
  | 'corp'
  | `agent:${string}`
  | `project:${string}`
  | `team:${string}`;

// ─── Common shared fields + the main Chit shape ─────────────────────

/**
 * Fields every chit carries regardless of type. Factored out so filter
 * engines and query predicates that only touch the shared substrate can
 * type against ChitCommon without pulling in the generic.
 */
export interface ChitCommon {
  /** Short-readable hash: `chit-<type-prefix>-<8-hex>`. */
  id: string;
  /** Current lifecycle status; valid subset is type-specific (see registry). */
  status: ChitStatus;
  /** True for auto-expiring chits (observations, handoffs, dispatch-contexts, role-level pre-brain-entries). */
  ephemeral: boolean;
  /** ISO timestamp of auto-destruction deadline. Meaningful when ephemeral=true; ignored otherwise. */
  ttl?: string;
  /** Member id of the original author. Founder is implied when a CLI call omits --from. */
  createdBy: string;
  /** Member id of the most recent writer. Populated on first update (undefined on initial write). Audit trail for post-hoc deviation-catching. */
  updatedBy?: string;
  /** ISO timestamp of creation. Immutable after initial write. */
  createdAt: string;
  /** ISO timestamp of the most recent write. Bumped by every update. Load-bearing for optimistic concurrency. */
  updatedAt: string;
  /** Loose relational pointers to other chits. Closing a referenced chit has no cascade. */
  references: string[];
  /** Hard dependency edges. Chain walker uses these; terminal-failure of a dep flags dependents as blocked. */
  dependsOn: string[];
  /** Free-form cross-cutting labels. The Postel's-law seam — strict schema + loose tags. */
  tags: string[];
  /**
   * Per-instance override of the type's registry `destructionPolicy`.
   * When present, the chit-lifecycle scanner uses this instead of the
   * registry default on the TTL-aged tie-breaker.
   *
   * Load-bearing for `inbox-item` chits where policy varies by tier:
   * Tier 1 ambients override to `destroy-if-not-promoted` (auto-clear
   * noise); Tier 2/3 inherit the registry default `keep-forever` (go
   * cold on TTL-age, preserve audit trail). Other types with
   * instance-by-instance policy variation can use the same hook —
   * registry default is the per-type baseline, this field is the
   * escape valve.
   *
   * Undefined = inherit registry default. Intentionally optional so
   * chits that don't need the override don't have to think about it
   * (the vast majority — tasks, contracts, caskets never age out, so
   * the field is a no-op on their types regardless).
   */
  destructionPolicy?: 'destroy-if-not-promoted' | 'keep-forever';
}

/**
 * A chit of a specific type. Generic parameter narrows the `fields` block
 * to the type-specific payload; defaulting to the full ChitTypeId union
 * produces the discriminated union a caller gets when the type isn't known
 * at compile time (e.g. readChit without narrowing).
 *
 * Written as a distributive conditional type alias rather than a bare
 * generic interface because a mapped-type `fields` block inside an
 * interface collapses to an intersection (all `fields.<type>` keys
 * present) when T is the wide union. The conditional form distributes
 * over T, producing a union-of-variants where each variant has exactly
 * one `fields` key matching its `type` discriminant — which is the
 * actual shape of the data.
 */
export type Chit<T extends ChitTypeId = ChitTypeId> = T extends ChitTypeId
  ? ChitCommon & { type: T; fields: { [K in T]: FieldsForType[K] } }
  : never;

// ─── Per-type field shapes ──────────────────────────────────────────
// Minimal v1 shapes — each type carries what REFACTOR.md's schema example
// names plus obvious audit fields. Migrations in 0.3/0.4/0.5 will expand
// TaskFields / ContractFields / ObservationFields to match what the
// existing bespoke types (Task, Contract, Observation) currently carry.

/**
 * Fine-grained task workflow state — the ten-state machine Project 1.3
 * makes mechanical. Distinct from chit.status (coarse universal
 * lifecycle: draft/active/terminal). Every transition between these
 * states is governed by task-state-machine.ts's validator; invalid
 * attempts throw TaskTransitionError rather than silently mutating.
 *
 * The state is observable in cc-cli task list + wtf output so the
 * founder can see WHAT PHASE a task is in, not just "active or not."
 *
 * ## State lifecycle (REFACTOR.md 1.3)
 *
 *     draft → queued → dispatched → in_progress
 *                                       ├─→ blocked ⇄ in_progress
 *                                       ├─→ under_review → completed | in_progress
 *                                       └─→ (failed | cancelled)
 *
 * - `draft`         — created, no assignee yet. The authoring agent /
 *                     founder is shaping it; not handed to anyone.
 * - `queued`        — assignee set (via task-create --assignee OR via
 *                     `cc-cli hand`). Waiting for the daemon to actually
 *                     deliver to the assignee's Casket / session.
 * - `dispatched`    — daemon has delivered. Sits on the target's Casket;
 *                     target's next session will pick it up.
 * - `in_progress`   — target agent's session has touched the task (first
 *                     tool-use observed in dispatch.ts, or explicit claim).
 * - `blocked`       — a blocker chit was filed against it via
 *                     `cc-cli block` (1.4.1). Auto-resumes when all
 *                     blockers reach terminal-success.
 * - `under_review`  — `cc-cli done` fired; the pending handoff awaits
 *                     audit-gate approval (0.7.3's Stop hook).
 * - `completed`     — audit approved; chain walker has advanced Casket.
 *                     Terminal-success.
 * - `rejected`      — audit blocked the handoff (e.g. acceptance
 *                     criteria not met, tier-3 inbox unresolved). The
 *                     task returns to `in_progress` via a separate
 *                     transition; `rejected` itself is terminal for
 *                     chain-walker purposes (downstream tasks blocked)
 *                     until someone re-opens or substitutes.
 * - `failed`        — circuit-breaker trip (1.10), repeated audit
 *                     blocks, or explicit failure declaration.
 *                     Terminal-failure.
 * - `cancelled`     — founder-only `cc-cli task cancel` escape hatch.
 *                     Terminal-failure.
 *
 * Terminal states: completed | rejected | failed | cancelled.
 * chit.status transitions in lockstep: terminal workflowStatus ⇒
 * non-active chit.status, preventing chit-layer queries from surfacing
 * finished work as open.
 *
 * Design note: `draft` and `queued` replace the earlier `pending` and
 * `assigned` names. "Pending" was ambiguous (pending assignment?
 * pending start?); "queued" + "dispatched" split the former "assigned"
 * into pre-delivery vs post-delivery, which the chain walker needs to
 * distinguish. Migration path: pre-1.3 tasks with workflowStatus
 * 'pending' | 'assigned' are mapped at read time (see tasks.ts
 * deriveTaskStatus) and rewritten to the new names on next update.
 */
export type TaskWorkflowStatus =
  | 'draft'
  | 'queued'
  | 'dispatched'
  | 'in_progress'
  | 'blocked'
  | 'under_review'
  /**
   * Project 1.12: task passed audit AND Editor review (or hit the
   * review-round cap and proceeded via reviewBypassed). Its
   * clearance-submission is queued or processing in the Pressman
   * lane. Transitions to `completed` when the submission merges, or
   * `failed` if the Pressman flow exhausts retries.
   */
  | 'clearance'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export interface TaskFields {
  /** Human-readable task title. Queryable in frontmatter rather than only as body H1. */
  title: string;
  /** Relative urgency for chain-walker prioritization. */
  priority: 'critical' | 'high' | 'normal' | 'low';
  /** Member id or role of the assigned worker. Null means unassigned (draft state). */
  assignee?: string | null;
  /** Concrete, checkable criteria that define "done." Null means not-yet-specified. */
  acceptanceCriteria?: string[] | null;
  /**
   * Task complexity — structured signal that routes real decisions:
   *
   *   - `trivial`  — one-liner (typo, var rename, version bump). Haiku-suitable.
   *                  Shouldn't trigger bacteria split on its own; many trivial
   *                  tasks stack on one Employee cheaply.
   *   - `small`    — bounded scope, typically one file, no cross-cutting
   *                  changes. Haiku-suitable.
   *   - `medium`   — multi-file, tests expected, some design thinking.
   *                  Opus-worthy. One of these counts more than three trivials
   *                  toward a bacteria-split threshold.
   *   - `large`    — enough work that it SHOULD probably be decomposed into a
   *                  contract. Planner treats a `large` task as a hint to
   *                  decompose before accepting the hand; bacteria treats
   *                  queue of large tasks as split-worthy even at low count.
   *
   * Null = unassessed. Agents drafting tasks SHOULD set this; tasks migrated
   * from pre-chits are left null and can be backfilled on first touch.
   *
   * NOT wall-clock time — agents don't experience time like humans. The enum
   * signals effort + decomposition + resource-allocation shape, not duration.
   */
  complexity?: 'trivial' | 'small' | 'medium' | 'large' | null;
  /** Member id of the Partner who most recently handed this task (audit trail — who's accountable for it landing on this Casket). Null if never handed. */
  handedBy?: string | null;
  /** ISO timestamp of the most recent hand. Null if never handed. */
  handedAt?: string | null;
  /**
   * Project 2.1 — ISO timestamp marking when the assigned worker first
   * started executing this task (the `dispatched → in_progress`
   * transition). Used by walk-aware audit (Project 2.3) as the `since`
   * boundary for `commit-on-branch` and `chit-of-type` expected-output
   * checks: "did the agent produce this output during their work on
   * THIS step," not "did this output ever exist somewhere."
   *
   * Set by the caller that fires the `claim` trigger via the 1.3 state
   * machine. As of 2026-05-02, no caller fires `claim` yet — the trigger
   * is defined in TRANSITION_RULES but unwired in code. Will be set when
   * a downstream sub-project (likely 2.3's audit-time fallback or an
   * earlier dispatch-side wiring PR) calls `validateTransition('
   * dispatched', 'claim')` on first agent activity. Pre-2.1 chits + any
   * task that hasn't transitioned to in_progress yet are null.
   *
   * Distinct from `reviewerClaim.claimedAt` (Editor's review claim,
   * Project 1.12.2) — that's when an Editor claims a task FOR REVIEW,
   * not when the assigned worker starts executing the step. Different
   * lifecycle event, different actor, different scope. The path
   * disambiguates them in TypeScript; the doc disambiguates for human
   * readers.
   */
  claimedAt?: string | null;
  /** ISO timestamp when the task should be done. Null for open-ended. */
  dueAt?: string | null;
  /** Chit id of the Loop driving this task (auto-advance tasks tied to recurring work). Null for standalone tasks. */
  loopId?: string | null;
  /** Fine-grained workflow state — see TaskWorkflowStatus docstring for the 10-state lifecycle. Coexists with chit.status (coarse draft/active/terminal). */
  workflowStatus?: TaskWorkflowStatus | null;
  /** Project.id the task belongs to. New tasks prefer `scope=project:<name>`; this field preserves the link for migrated tasks that pre-date scope-encoding. */
  projectId?: string | null;
  /** Team.id the task belongs to. Same legacy-link role as projectId. */
  teamId?: string | null;
  /**
   * Structured step-to-step I/O (Project 1.3). Prose summary written
   * by the executing agent as part of `cc-cli done` — the canonical
   * task-level result that downstream tasks in the chain read via
   * `depends_on[i].fields.task.output` without grepping the task body
   * or the worklog.
   *
   * Scope:
   *   - SEMANTIC summary — "what this step produced" in 1-5 sentences
   *     (changed files, key decisions, observable outcome). Not a full
   *     worklog, not the raw command outputs. Callers needing the
   *     full build log reach for commit history / CI artifacts.
   *   - Audit-gate-promoted: populated by done.ts at handoff-to-chit
   *     promotion time from the `completed[]` array the agent passes.
   *     Absent on draft/queued/in_progress/blocked tasks — present
   *     means the task at least reached under_review.
   *   - Blueprint-defined tasks (Project 2.1) can specify an
   *     `expected_output` shape the prose should hit; typed-schema
   *     I/O layers on top of this field rather than replacing it.
   *
   * Null / undefined both mean "no output captured yet." Agents reading
   * a dependency's output should handle undefined as "the producing
   * step didn't write an output summary" rather than as a failure.
   */
  output?: string | null;
  /**
   * Project 2.1 — pre-expanded ExpectedOutputSpec carried over from the
   * blueprint step at cast time. Co-located with `output` because the
   * pair is symmetric: `expectedOutput` is the SHAPE this step is
   * supposed to produce; `output` is the agent's prose summary of what
   * actually was produced. Walk-aware audit (Project 2.3) reads
   * `expectedOutput` and runs `checkExpectedOutput` against the
   * concrete spec — no template engine needed at audit time, because
   * the cast pipeline already substituted Handlebars vars (`feature`,
   * `topic`, etc.) using the cast-time vars context. Re-expansion at
   * audit time isn't possible without storing the cast vars, and
   * pre-expansion is the cleaner solution: spec data co-located with
   * task data, expansion happens once not per audit fire, and tasks
   * reflect their cast moment regardless of later blueprint edits.
   *
   * Null / absent means the originating blueprint step had no
   * expectedOutput declared (or this task wasn't cast from a blueprint
   * at all — ad-hoc tasks). Walk-aware audit treats null as "no
   * mechanical-output check on this step" — graceful degradation.
   * Other walk surfaces (visibility in 2.2, sexton patrol in 2.4) still
   * operate normally.
   *
   * Validated via the same validateExpectedOutput helper used for
   * BlueprintStep.expectedOutput. The structural shape is identical;
   * only the absence of unresolved `{{vars}}` in templated fields
   * distinguishes a task's expectedOutput from a blueprint step's.
   */
  expectedOutput?: ExpectedOutputSpec | null;
  /**
   * Project 1.12.2 — Editor review counter. Increments at each
   * Editor `reject`. Survives across audit cycles (an under_review →
   * blocked → in_progress → under_review oscillation by the author
   * keeps the same counter). When this reaches the role's
   * `editorReviewRoundCap` (default 3), `editorReviewCapHit` flips
   * true and the next audit-approve bypasses Editor.
   *
   * Distinct from `review-comment.reviewRound`: this counter tracks
   * "how many times Editor said no on this task," while a comment's
   * reviewRound is "which review pass produced this comment." When
   * Editor files a comment in round N, the comment's reviewRound is
   * N+1 (1-indexed; round 1 is the first review pass after 0 prior
   * rejections).
   *
   * Null / undefined === 0 prior rejections — pre-1.12.2 chits and
   * fresh tasks both read as no review history.
   */
  editorReviewRound?: number | null;
  /**
   * Project 1.12.2 — set true when `editorReviewRound` reaches the
   * role's cap. Audit reads this and bypasses Editor on next approve,
   * firing enterClearance with `reviewBypassed: true` so the
   * submission proceeds to the Pressman lane without further Editor
   * iteration. NOT a permanent gate — re-creating the task or
   * resetting via cc-cli would clear it.
   */
  editorReviewCapHit?: boolean | null;
  /**
   * Project 1.12.2 — set true by audit's approve path on
   * editor-aware corps when this task is review-eligible (audit
   * approved + clearinghouse-aware + editor-aware + !capHit).
   * EditorReviewWatcher + the editor sweep both treat this as the
   * "Editor: please look at this" signal, decoupling the audit
   * trigger from the Editor's wake mechanism. Cleared by Editor's
   * `approveReview` / `rejectReview` when the task exits the review
   * cycle.
   */
  editorReviewRequested?: boolean | null;
  /**
   * Project 1.12.2 — non-null while an Editor session is mid-review
   * on this task. Prevents two Editors (when bacteria scales the
   * pool in 1.12.3) from racing on the same task. Claim atomically
   * before reading the diff; release on approve / reject / abandon.
   * `claimedAt` is an ISO timestamp; stale claims (claimer not
   * alive) get reaped by the editor sweep, mirroring
   * `findOrphanedProcessingSubmissions` for the Pressman lane.
   */
  reviewerClaim?: { slug: string; claimedAt: string } | null;
  /**
   * Project 1.12.2 — branch the author committed their work on,
   * captured by audit at `editorReviewRequested = true` time.
   * Editor's `acquireEditorWorktree` checks this branch out into
   * its own isolated worktree (`.clearinghouse/editor-wt-N`) so
   * Editor reviews a stable snapshot regardless of what the
   * author's sandbox does between audit and Editor's wake.
   *
   * Cleared on approve (the branch info has moved into the
   * clearance-submission chit at that point) and on reject (the
   * author's next `cc-cli done` re-fires audit, which captures
   * the current branch fresh — could be the same branch, could
   * differ if they rebased / re-branched between rounds).
   *
   * Null / undefined means "Editor has nothing to review on this
   * task right now." pickNextReview filters on non-null.
   */
  branchUnderReview?: string | null;
}

export interface ContractFields {
  /** Human-readable contract title. */
  title: string;
  /** Goal statement — what success looks like at the contract level. */
  goal: string;
  /** Chit ids of the tasks inside this contract, in intended order. Chain semantics read from each task's dependsOn. */
  taskIds: string[];
  /** Contract-level urgency, reuses the task priority enum for consistency. */
  priority?: 'critical' | 'high' | 'normal' | 'low';
  /** Member id of the Partner owning this contract's execution. Null for drafts. */
  leadId?: string | null;
  /** Optional blueprint that cooked this contract — for provenance + re-cook. */
  blueprintId?: string | null;
  /** Optional deadline (ISO timestamp). Null means open-ended. */
  deadline?: string | null;
  /** ISO timestamp when the Warden approved this contract. Null until approval. */
  completedAt?: string | null;
  /** Member id of the Warden who reviewed. Null until reviewed. */
  reviewedBy?: string | null;
  /** Warden's approval note or rejection reason (free-form). Null until review. */
  reviewNotes?: string | null;
  /** How many times the Warden rejected this contract before approval. Non-negative integer. */
  rejectionCount?: number;
  /** Project.id the contract belongs to. Contracts always live under a project; this preserves the link through migration and for callers that reverse-resolve to Contract.projectId. The contract's scope (project:<name>) encodes the project name in path; this field carries the id. */
  projectId?: string | null;
}

export interface ObservationFields {
  /** Observation category. Each category has different weight in dream distillation (Project 4.1). */
  category: 'FEEDBACK' | 'DECISION' | 'DISCOVERY' | 'PREFERENCE' | 'NOTICE' | 'CORRECTION';
  /** Who or what this observation is about (member id, "corp", a concept). */
  subject: string;
  /** Author-rated 1-5 significance. Combined with category in weight scoring. */
  importance: 1 | 2 | 3 | 4 | 5;
  /** Optional object the subject is observed interacting with (e.g. subject=mark, object=cascade-archive-errors). */
  object?: string | null;
  /** Optional one-line title. Free-form; observations don't always have tidy titles. */
  title?: string | null;
  /** Ambient context when the observation was captured — what else was going on. Free-form prose, supports dream distillation's pattern-detection. */
  context?: string | null;
}

export interface CasketFields {
  /** Chit id of the work the agent is currently on. Null when idle. The only functional field on a Casket. */
  currentStep: string | null;
  /** ISO timestamp of the last currentStep change. Observability, not load-bearing. */
  lastAdvanced?: string | null;
  /** Total number of sessions that have run for this agent. Bookkeeping. */
  sessionCount?: number;
}

export interface HandoffFields {
  /** Session id of the predecessor that wrote this handoff (e.g. "toast-17"). */
  predecessorSession: string;
  /** Chit id of the work the predecessor was mid-way through (usually a task). */
  currentStep: string;
  /** What the predecessor finished before handing off. */
  completed: string[];
  /** What the successor should do next. Dredge injects this directly into the boot prompt. */
  nextAction: string;
  /** Unresolved question the predecessor wants the successor to see. */
  openQuestion?: string | null;
  /** Git branch, tree state, last commit — anything environmental the successor needs. */
  sandboxState?: string | null;
  /** Free-form notes. */
  notes?: string | null;
}

export interface DispatchContextFields {
  /** Member id of the agent who handed the work. */
  sourceAgent: string;
  /** Member id of the agent who received (or the role if resolved from a pool). */
  targetAgent: string;
  /** Chit id of the work being handed — usually a task or escalation. */
  workChitId: string;
  /** Contract id if this dispatch is part of a larger contract. */
  contractId?: string | null;
  /** Free-form reason or context the source wants the target to see. */
  reason?: string | null;
}

export interface PreBrainEntryFields {
  /** The role this entry belongs to (backend-engineer, qa-engineer, etc.). Entries are scoped to the role, not individual Employees. */
  role: string;
  /** What kind of memory this is — determines how dream distillation weights it. */
  memoryType: 'rule' | 'fact' | 'preference' | 'insight';
  /** Confidence from backing evidence. Derived from number of promoting observations or direct author attestation. */
  confidence: 'low' | 'medium' | 'high';
  /** Chit ids of observations that support this entry — provenance chain back to source. */
  provenance?: string[];
}

export interface StepLogFields {
  /** Chit id of the task this step logs progress against. */
  taskChitId: string;
  /** Free-form phase name: "plan", "implement", "verify", etc. */
  phase: string;
  /** Lifecycle state of this specific step execution. */
  outcome: 'started' | 'in-progress' | 'completed' | 'failed';
  /** Free-form details from the execution session — what happened, what went wrong. */
  details?: string | null;
}

/**
 * Escalation — Employee-to-Partner "I need a judgment call" chit (Project
 * 1.4). Distinct from a task (which is work to DO) and from a blocker
 * (which is work that unblocks another piece of work). An escalation is a
 * DECISION request: the Employee hit something above their pay grade and
 * wants a Partner's call before proceeding.
 *
 * ### Lifecycle stance
 *
 * Ephemeral by default (TTL 7d). Escalations aren't soul material — once
 * the Partner resolves, the outcome either becomes a new task (the
 * follow-up work) or is recorded in the originating task's
 * `output` / body / conversation log. The escalation chit itself is the
 * IN-FLIGHT signal; history lives on the chits it references.
 *
 * Statuses: `active → completed | rejected | closed`.
 *   - `active`    — landed on the Partner's Casket / inbox, pending decision.
 *   - `completed` — Partner resolved (resolution field describes how).
 *   - `rejected`  — Partner bounced back ("I'm not the right person, re-escalate").
 *   - `closed`    — superseded (Employee self-unblocked, or the originating
 *                   work closed before Partner got to it).
 *
 * ### Project 2 note
 *
 * REFACTOR.md calls out a `gate` chit primitive (Gas Town's gate-bead
 * analog) that will eventually subsume escalation, approval-requests,
 * design-questions, and review-blocks under a single "someone-must-make-
 * a-call" primitive. When that primitive lands in Project 2, this type
 * migrates to `fields.gate.kind = 'escalation'`. Shipping as its own
 * type now because the lifecycle + policy differ materially from task,
 * and tagging (the alternative) can't encode `ephemeral` or a different
 * terminal-state set.
 */
export interface EscalationFields {
  /**
   * Chit id of the work the Employee was on when they escalated. Typed
   * field (not `references[0]`) because this pointer is semantic, not
   * a loose relation — it's THE work the escalation is about.
   */
  originatingChit: string;
  /**
   * Employee's explanation of what they hit and what they need from the
   * Partner. Load-bearing for the Partner's ability to answer without
   * reading the whole task body. Min-length enforced at CLI boundary;
   * validator here allows any non-empty string so mid-lifecycle edits
   * (Partner extending the note before responding) don't trip validation.
   */
  reason: string;
  /** Member id of the Employee who escalated. */
  from: string;
  /** Member id of the Partner the escalation landed on. */
  to: string;
  /**
   * What kind of call the Partner is being asked to make. Drives UI
   * weighting + inbox tier in 1.4: `blocker` escalations get Tier 3
   * (founder visibility since a chain is stalled); `question` and
   * `review` get Tier 2 (important but not chain-stalling).
   */
  severity: 'blocker' | 'question' | 'review';
  /**
   * How the Partner closed it out (null while active).
   *   - `resolved`           — Partner answered; Employee can proceed.
   *   - `dismissed`          — Partner says "this isn't worth it" /
   *                            "you can decide yourself."
   *   - `converted-to-task`  — Partner created a real follow-up task;
   *                            convertedTaskId points at it.
   */
  resolution?: 'resolved' | 'dismissed' | 'converted-to-task' | null;
  /** Partner's free-form note on the decision. Provides the "what to do next" Employee reads on resume. Null while active. */
  resolutionNotes?: string | null;
  /** When resolution='converted-to-task', chit id of the created task. Null otherwise. */
  convertedTaskId?: string | null;
}

/**
 * Tier for inbox items — determines the ceremony required to resolve them.
 * The sender determines the tier (recipient cannot self-downgrade); the
 * audit gate only blocks on unresolved Tier 3 items.
 *
 * - **Tier 1 (ambient)** — broadcasts, system events, digests. Auto-expire
 *   after 24h if not touched. Dismissible with \`--not-important\` alone.
 * - **Tier 2 (direct)** — @mentions, peer DMs, inter-agent handoffs. Go
 *   cold after 7d (preserved audit trail). Dismiss requires a real reason.
 * - **Tier 3 (critical)** — founder DMs, escalations, task assignments,
 *   audit failures. Go cold after 30d. Dismiss rejects \`--not-important\`
 *   at the CLI boundary; must respond, dismiss with specific reason, or
 *   carry-forward with justification.
 */
export type InboxItemTier = 1 | 2 | 3;

/**
 * Source vocabulary for inbox items — where the notification came from.
 * Used by the wtf header + resolution routing (\`cc-cli inbox respond\`
 * dispatches differently based on source).
 */
export type InboxItemSource = 'channel' | 'dm' | 'hand' | 'escalation' | 'system';

/**
 * Fields for an inbox-item chit — a lightweight notification pointing
 * at underlying content (a channel message, a DM, a handed task, a
 * system event). Created by the daemon on the recipient's behalf
 * (router on @mention detection, hand command on task dispatch, etc.).
 * Agents never author inbox-items for themselves — they are always
 * the RECIPIENT.
 *
 * Per-instance \`destructionPolicy\` override on the chit's common fields
 * drives tier-varying lifecycle: Tier 1 gets \`destroy-if-not-promoted\`,
 * Tier 2/3 get \`keep-forever\` (cool on TTL age instead of destroying).
 */
export interface InboxItemFields {
  /** Tier — sender-determined, not recipient-overridable. */
  tier: InboxItemTier;
  /** Sender member id (e.g. 'mark' for founder, 'herald' for herald), or 'system' for daemon-emitted notifications. */
  from: string;
  /** One-line preview rendered in the wtf header and \`cc-cli inbox list\`. Keep under ~80 chars. */
  subject: string;
  /** What kind of thing generated this notification. Drives how \`cc-cli inbox respond\` dispatches. */
  source: InboxItemSource;
  /** Source-specific reference — channel name for 'channel', null for most others. */
  sourceRef?: string | null;
  /** Set when the chit is closed. 'responded' for active engagement; 'dismissed' for the CLI dismiss paths. */
  resolution?: 'responded' | 'dismissed' | null;
  /** Required on Tier 2+ dismissals; the CLI rejects under-threshold text on Tier 3. */
  dismissalReason?: string | null;
  /** Set when resolution is deferred with justification — agent had a decision but isn't able to act right now. Counts as resolution for audit but keeps the item visible in future wtf. */
  carriedForward?: boolean | null;
  /** Reason if carriedForward. Required when carriedForward is true. */
  carryReason?: string | null;
}

/**
 * One step inside a Blueprint — the machine-readable equivalent of a
 * runbook numbered step. Cast converts each step into a Task chit in
 * the resulting Contract, preserving the `dependsOn` DAG via step ids.
 *
 * Step ids are scoped to THEIR OWN blueprint — they're not chit ids.
 * When cast produces Task chits, the chain walker rewrites `dependsOn`
 * from step-id references to Task chit-id references so the DAG
 * composes with the rest of the chit substrate.
 */
export interface BlueprintStep {
  /** Unique within this blueprint. Referenced by other steps' dependsOn. Kebab-case convention (`scan-caskets`, `detect-stalls`). */
  id: string;
  /** Short human-readable label. Becomes the Task chit's `fields.task.title` after cast, with Handlebars expanded. */
  title: string;
  /** Longer description of what the step does + why. Becomes the Task chit body after cast. Handlebars-templated. */
  description?: string;
  /** Step ids this step waits on. Forms a DAG; cycles are rejected at validate-time. Defaults to [] (top of chain). */
  dependsOn?: string[];
  /** Acceptance criteria inherited onto the Task chit. Each item templated through Handlebars with cast-time vars. */
  acceptanceCriteria?: string[];
  /** Role registry id the cast-time Task chit is assigned to. Null defers the decision to cast-time via an explicit `--assign-<stepId> <role>` flag. */
  assigneeRole?: string | null;
  /**
   * Code-module name for kind=sweeper blueprints (Project 1.9). When set,
   * cast dispatches a native code module (registered in the sweepers
   * registry at `packages/daemon/src/watchdog/sweepers/index.ts`) rather
   * than an AI agent. Absent on a sweeper-step means AI dispatch —
   * step.description becomes the agent prompt.
   *
   * Kebab-case, matches the module's exported name. Meaningless on
   * kind=contract blueprints; the validator permits it but the cast
   * primitives enforce kind-routing at dispatch. Absent by default.
   */
  moduleRef?: string | null;
  /**
   * Project 2.1 — what this step is expected to mechanically produce.
   * Walk-aware audit (Project 2.3) calls a per-kind checker against this
   * spec at `cc-cli done` time and blocks the handoff if the expected
   * output isn't present. See ExpectedOutputSpec for the discriminated
   * union of supported kinds (chit-of-type / branch-exists /
   * commit-on-branch / file-exists / tag-on-task / task-output-nonempty
   * / multi).
   *
   * Null / absent means walk-aware audit doesn't enforce mechanical
   * output for this step — graceful degradation for pre-2.1 blueprints
   * + steps where AC checks are sufficient. Other walk surfaces
   * (visibility in 2.2, sexton patrol in 2.4) operate normally; only
   * the audit-time mechanical-output check is skipped.
   *
   * Templated string fields inside the spec (branchPattern, pathPattern,
   * withTags) are Handlebars-expanded against cast-time vars, matching
   * the existing 1.8 template-expansion model.
   */
  expectedOutput?: ExpectedOutputSpec | null;
}

/**
 * A blueprint variable — a slot the caller fills at cast time. Validator
 * checks that every `{{var}}` reference in the blueprint's strings
 * resolves from this list (or from a default).
 */
export interface BlueprintVar {
  /** Variable name. Referenced as `{{name}}` inside step strings (title / description / acceptanceCriteria / assigneeRole). */
  name: string;
  /** Simple type check at cast time. Strings are the common case; int + bool exist for threshold-style patrol vars. */
  type: 'string' | 'int' | 'bool';
  /** When absent and no default, cast fails unless caller provides the var via `--vars name=value`. Null default means "required but user must set null explicitly." */
  default?: string | number | boolean | null;
  /** Free-form one-line description rendered in `cc-cli blueprint show` so callers know what the variable is for. */
  description?: string;
}

/**
 * Fields for a blueprint chit — the mold. Cast converts one of these
 * into a Contract chit + a tree of Task chits that walk via the chain
 * walker. Blueprints are chits (Project 1.8) so the same query /
 * lifecycle / scoping substrate applies — `cc-cli chit list --type
 * blueprint --tag patrol` is a real query, blueprints can reference
 * each other, and the scope (`agent:<slug>` / `project:<name>` /
 * corp) determines authorship + override precedence.
 *
 * Origin discriminates three paths into the blueprint store:
 *   - `authored` — a member wrote it via `cc-cli blueprint new` and
 *     filled in steps. Most common path during the corp's life.
 *   - `builtin` — seeded on corp init from the claudecorp package.
 *     Reseeded on `cc-cli update --blueprints`.
 *
 * Path 3 from the 1.8 design (AI-assisted pattern capture from
 * observed repetition) is deferred to 1.9 / 4.2 where the observation
 * + dream machinery can actually detect the patterns.
 */
/**
 * Fields for a sweeper-run chit (Project 1.9). A sweeper-run records
 * one dispatch of a sweeper — Sexton's worker modules that do the
 * mechanical maintenance work she orchestrates. Each patrol cycle
 * produces one or more sweeper-run chits, one per sweeper she
 * dispatches.
 *
 * Ephemeral by default (7d TTL). A sweeper-run that produced no
 * referenced observations after TTL is noise by definition — the
 * lifecycle scanner's destroy-if-not-promoted policy clears those
 * automatically. A sweeper-run that DID spawn a promoted observation
 * (Sexton noticed a pattern, wrote it up as a non-ephemeral
 * observation referencing the sweeper-run) survives.
 *
 * Sweeper-runs don't participate in the chain walker. They're not
 * tasks; they don't have dependsOn semantics. Their status lifecycle
 * is simple: active (running) → closed (done) | burning (aborted).
 * The outcome field carries the pass/fail/cancelled semantics that
 * would be workflowStatus on a Task chit.
 */
export interface SweeperRunFields {
  /** Chit id of the sweeper blueprint this run was cast from. Load-bearing: every sweeper-run traces back to its source blueprint. */
  blueprintId: string;
  /**
   * Member id of the initiator. Usually Sexton; can be the founder when
   * `cc-cli sweeper new --prompt "..."` triggers a first-run-after-
   * authoring dispatch for approval gating.
   */
  triggeredBy: string;
  /**
   * Optional free-form text explaining why this dispatch happened —
   * the patrol step that invoked it, an ad-hoc pattern Sexton noticed,
   * a founder-initiated re-run. Surfaces in observability so the
   * founder can trace "why did this sweeper fire at 03:47?"
   */
  triggerContext?: string;
  /**
   * Code-module name for code sweepers (matches the sweepers registry
   * key). Null for AI sweepers (dispatch goes to a Claude agent; the
   * prompt comes from the blueprint step's description). Copied off
   * the blueprint step at cast time so the sweeper-run is self-
   * describing without re-reading the blueprint.
   */
  moduleRef?: string | null;
  /**
   * Terminal outcome of the run. `running` is the default at create
   * time; transitions to `success` / `failure` / `cancelled` happen
   * when the sweeper's execution finishes. Distinct from chit status
   * (active/closed) because chit status describes the chit's
   * lifecycle, outcome describes what actually happened in the run.
   */
  outcome: 'running' | 'success' | 'failure' | 'cancelled';
  /**
   * Chit ids of any observation chits the sweeper produced during
   * this run. Sexton reads these via a query when integrating patrol
   * results; dreams can traverse them to synthesize patterns across
   * many sweeper-runs.
   */
  observationsProduced?: string[];
  /**
   * Free-form conclusion from the sweeper. Short — a sentence or two
   * about what the sweeper concluded and what action (if any) was
   * taken. Surfaces in observability and in Sexton's integration of
   * patrol results.
   */
  decision?: string;
}

export interface BlueprintFields {
  /**
   * Human-typeable identifier. Kebab-case, unique within the blueprint's
   * scope (agent / project / corp). This is what `cc-cli blueprint cast
   * <name>` resolves against — the chit id (`chit-b-a1b2c3d4`) works
   * too, but nobody wants to type that. Load-bearing: every CLI-side
   * blueprint reference flows through this field.
   *
   * Uniqueness-per-scope is enforced at the CLI boundary (`blueprint
   * new` / `blueprint cast` lookup), not in the chit-type validator,
   * because the validator doesn't have access to scope state.
   */
  name: string;
  /**
   * What shape the blueprint casts into. Drives which cast primitive
   * the CLI routes to:
   *   - `contract` (default when absent) — casts into Contract + Task
   *     chits via `castFromBlueprint`. The 1.8-shipped shape. Used by
   *     `cc-cli contract start --blueprint ...` and by Sexton's patrol
   *     blueprints (patrol blueprints ARE Contract-cast because each
   *     patrol is a walk through N checks, one per step).
   *   - `sweeper` — casts into a single `sweeper-run` chit via
   *     `castSweeperFromBlueprint` (Project 1.9). A sweeper blueprint
   *     describes one focused maintenance task; the sweeper-run chit
   *     records one dispatch of that task. Dispatch fans out to either
   *     a code module (step.moduleRef set) or an AI agent (moduleRef
   *     absent, step.description becomes the prompt).
   *
   * Absent-as-contract (rather than requiring `kind: 'contract'` on
   * every existing blueprint) keeps 1.8-era blueprints from needing a
   * migration write. The cast primitives both check this field; the
   * wrong cast path for a given kind rejects with a clear error.
   */
  kind?: 'contract' | 'sweeper';
  /** The step DAG — the castable body of the blueprint. Must be non-empty; cycles rejected at validate. */
  steps: BlueprintStep[];
  /** Variables the caller fills at cast time. Optional — a blueprint can be fully static. Empty array and absent are equivalent. */
  vars?: BlueprintVar[];
  /** Where this blueprint came from. Drives UI hints (builtin shows a badge) + update behavior (builtins get reseeded on `cc-cli update`, authored don't). */
  origin: 'authored' | 'builtin';
  /** Short human-readable label shown in `cc-cli blueprint list`. Distinct from the chit body (which holds prose for the human author reading the file). */
  title?: string | null;
  /** One-line summary shown in list output. Not Handlebars-templated — this is metadata about the blueprint itself, not a cast-time template. */
  summary?: string | null;
}

/**
 * Kink — an operational problem/finding emitted by sweepers (and
 * potentially future daemon-internal detectors). Distinct from
 * observation chits (which are agent-voice self-witnessing that
 * feeds BRAIN via dreams): kinks are system-voice operational state
 * that wants attention or records that a mechanical fix happened.
 *
 * Mixing the two channels would pollute observation-stream-as-soul-
 * material with mechanical noise + misdirect dream distillation
 * into trying to synthesize patterns from "5 slots crashed today"
 * as if it were preference. Kinks are their own stream.
 *
 * Lifecycle: ephemeral, 7d TTL, destroy-if-not-promoted. If a kink
 * went unreferenced for 7 days, either it got fixed without being
 * closed explicitly (stale but moot) or nobody cared; scanner
 * burns it. Promotion via the standard 4-signal rule covers the
 * "this recurring pattern matters" case — a postmortem observation
 * that cites the kink id will preserve it.
 *
 * Dedup contract: writers (the sweeper runner + any future direct
 * callers) check for an existing active kink with the same
 * `(source, subject)` before creating a new one. If found, they
 * increment `occurrenceCount` + bump `updatedAt` on the existing
 * kink rather than creating a duplicate. This keeps agentstuck
 * from filing 60 identical kinks when the same 5 slots stay stuck
 * across an hour of patrols.
 */
export interface KinkFields {
  /**
   * Origin of the kink. Convention: `<subsystem>:<detector>`. Examples:
   *   - `sweeper:silentexit`
   *   - `sweeper:agentstuck`
   *   - `sweeper:chit-hygiene`
   *   - `daemon:boot`                  (future use: startup problems)
   *   - `harness:claude-code`          (future use: harness anomalies)
   *
   * Filterable by prefix, so Sexton can query all sweeper-emitted
   * kinks separately from daemon-emitted ones.
   */
  source: string;
  /**
   * What the kink is ABOUT. Typically a member id (`ceo`, `toast-2`)
   * when the kink concerns an agent's state; a chit id when the
   * kink concerns a specific chit (e.g. malformed chit flagged by
   * chit-hygiene). Forms half the dedup key with `source` — two
   * active kinks with the same `(source, subject)` pair collapse
   * to one via occurrenceCount-bumping.
   */
  subject: string;
  /**
   * How loudly this wants attention.
   *   info   — routine, informational; a normal-path event worth
   *            recording but not acting on (log rotation fired;
   *            silentexit respawned a slot cleanly).
   *   warn   — not a crisis, but something a human should notice
   *            within hours (agent stuck mid-task; phantom-cleanup
   *            found a workspace without a member record).
   *   error  — data integrity / operational hazard (malformed chit
   *            that breaks query; respawn failed repeatedly). Sexton
   *            should surface these to the founder promptly.
   */
  severity: 'info' | 'warn' | 'error';
  /**
   * One-line summary shown in kink-list output. Full context lives
   * in the chit body (markdown). Title stays short so `cc-cli chit
   * list --type kink` output is legible at a glance.
   */
  title: string;
  /**
   * How many times this exact (source, subject) has been hit
   * while the kink has been in the active state. Starts at 1 on
   * create; dedup writer increments on each subsequent match.
   * Lets Sexton see "this is fresh" vs "this has been happening
   * for 2 hours" without grinding through chit diffs.
   *
   * Resets implicitly on close: a new kink after close starts at
   * 1 again — closed kinks are history; a recurrence is its own
   * event.
   */
  occurrenceCount: number;
  /**
   * Why the kink closed. Set on transition to `status: closed`,
   * null/absent while active. Three reasons we distinguish:
   *   auto-resolved  — a subsequent sweeper run detected the
   *                    condition is no longer present (dead slot
   *                    came back up; malformed chit was fixed).
   *   acknowledged   — Sexton or founder saw it, accepted the
   *                    state as known/tolerable ("yes this slot
   *                    is intentionally offline for the day").
   *   dismissed      — the kink was noise or a false positive;
   *                    closed without further action.
   */
  resolution?: 'auto-resolved' | 'acknowledged' | 'dismissed' | null;
}

/**
 * Fields for a `breaker-trip` chit (Project 1.11).
 *
 * Records that a slot's crash-loop breaker has tripped — silent-exit
 * sweeper saw the same slug die N consecutive times and is asking the
 * spawn surface to refuse further respawns until the founder resets.
 *
 * ### Lifecycle
 * - `active`  — trip is live; ProcessManager.spawnAgent refuses for
 *               the slug; bacteria pickFreshSlug avoids it; sweeper
 *               skips respawn.
 * - `closed`  — founder reset (or auto-cleanup on slot removal). No
 *               further blocking; a recurrence creates a fresh trip.
 *
 * ### Identity + dedup
 * Identity is `(slug)` while active. `tripBreaker` is idempotent:
 * second trip on a slug with an existing active trip BUMPS
 * `triggerCount` and appends to `recentSilentexitKinks` rather than
 * creating a duplicate. Mirrors the kink dedup contract.
 *
 * ### Persistence
 * Non-ephemeral. A trip surviving for weeks is a feature: the
 * founder needs to see the loop history. Stored at corp scope.
 */
export interface BreakerTripFields {
  /**
   * The slot's Member.id this trip is for. Combined with chit.status
   * === 'active' is the lookup key. Same value as the silentexit
   * kink's `subject` field — that's what wires detection to refusal.
   */
  slug: string;
  /**
   * ISO 8601 timestamp the trip first fired. Stays stable across
   * idempotent re-trips (which bump triggerCount + recentSilentexitKinks
   * but NOT this field). Lets audit reads see "this slot's loop
   * started at T" cleanly.
   */
  trippedAt: string;
  /**
   * Number of silent-exit signals that have triggered this trip. On
   * first creation, equals `triggerThreshold`. On re-trigger (more
   * silent-exits arrive while the trip is still active), this bumps
   * past the threshold so the founder can see severity at a glance.
   */
  triggerCount: number;
  /**
   * Window the trigger evaluated within, in milliseconds. Snapshot
   * of the role's effective `crashLoopWindowMs` at trip time, so
   * audit reads stay coherent even if the role's config changes
   * later.
   */
  triggerWindowMs: number;
  /**
   * Threshold the trigger crossed. Snapshot of the role's effective
   * `crashLoopThreshold` at trip time. Same audit-coherence motive
   * as triggerWindowMs.
   */
  triggerThreshold: number;
  /**
   * Chit ids of the silent-exit kinks that triggered this trip.
   * `cc-cli chit read <kink-id>` walks the failure history; the
   * trip is the index. On idempotent re-trigger, additional kink
   * ids append (deduped via Set semantics at the writer).
   *
   * Note: silentexit's writeOrBumpKink keeps ONE active kink per
   * slug at a time, so this array typically holds exactly one id —
   * the persistent-active kink whose occurrenceCount crossed the
   * threshold. The array shape leaves room for future detectors
   * that emit multiple kinks per trigger.
   */
  recentSilentexitKinks: string[];
  /**
   * Forensic context — when the looping started in clock time.
   * Populated from the triggering silent-exit kink's `createdAt`,
   * so it captures the first crash in the loop (not the most
   * recent). Lets the founder see "this has been looping since
   * 14:32" without walking the kink chit.
   *
   * Future enhancement: ProcessManager could track per-slug spawn
   * timestamps in a ring buffer; this field would then carry the
   * exact spawn-attempt history. v1 reads from kink createdAt.
   */
  spawnHistory: string[];
  /**
   * Free-form prose. The detector writes a default summary
   * ("crash-loop breaker tripped: N silent exits in M minutes");
   * founder reset adds context via `cc-cli breaker reset --reason`.
   */
  reason: string;
  /**
   * Set when chit.status flips to 'closed' — who closed, when, why.
   * Three close paths: founder reset (`cc-cli breaker reset`),
   * auto-cleanup on slot removal (`cc-cli fire --remove`,
   * `cc-cli bacteria evict`), and the rare manual `cc-cli chit
   * update` audit override.
   */
  clearedAt?: string;
  clearedBy?: string;
  clearReason?: string;
}

/**
 * Fields for a `clearance-submission` chit (Project 1.12).
 *
 * Records one PR's journey through the Clearinghouse phase: pushed
 * branch → queue → Pressman processing → merge or conflict-route.
 * Created by `cc-cli clear` after Editor approves (or after the
 * review-round cap forces bypass). Closed when Pressman either
 * merges cleanly or files a substantive blocker.
 *
 * ### Lifecycle
 * - chit.status `active` while `submissionStatus` is `queued`,
 *   `processing`, or `conflict`.
 * - chit.status `completed` when `submissionStatus` becomes `merged`.
 * - chit.status `failed` when `submissionStatus` becomes `failed`
 *   (mechanical exhaustion — rebase keeps breaking, tests keep
 *   failing past retry budget, branch gone from origin).
 * - chit.status `closed` when founder cancels (or upstream
 *   contract is cancelled).
 *
 * ### Per-task, not per-contract
 * One submission per task chit, typically. A 5-task contract
 * generates 5 submissions over time as tasks individually pass
 * through review and reach the Pressman lane.
 *
 * ### Counters
 * - `reviewRound` — Phase-1 review iterations (Editor sent it back
 *   N times before approving or hitting the cap). Success path —
 *   does NOT incur the priority-formula retry penalty.
 * - `retryCount` — Phase-2 mechanical retries (rebase produced
 *   nonsense, tests flaked into a re-run, transient origin push
 *   rejection). Failure path — DOES incur the retry penalty in the
 *   priority formula.
 *
 * ### Bypassed reviews
 * `reviewBypassed: true` records that this submission reached
 * Phase 2 via cap-hit rather than approval. The corp's existing
 * audit-tier-3 surface catches anything genuinely alarming; this
 * flag is for retrospective audit + CULTURE.md compounding ("we
 * keep capping out review on backend-engineer work").
 */
export interface ClearanceSubmissionFields {
  /** Git branch being submitted, as it lives on origin. */
  branch: string;
  /** Chit id of the contract this submission's task belongs to. */
  contractId: string;
  /** Chit id of the task this submission settles. One submission per task. */
  taskId: string;
  /** Member id of the agent who ran `cc-cli clear`. */
  submitter: string;
  /**
   * Snapshotted from the task's priority at submit time so a
   * priority change mid-queue doesn't reorder existing entries
   * unexpectedly. Pressman's queue ordering reads this field.
   */
  priority: 'critical' | 'high' | 'normal' | 'low';
  /** ISO timestamp the submission was created. */
  submittedAt: string;
  /**
   * The rich state machine. chit.status follows but is coarser
   * (active / completed / failed / closed). See lifecycle docstring.
   */
  submissionStatus:
    | 'queued'
    | 'processing'
    | 'merged'
    | 'conflict'
    | 'rejected'
    | 'failed'
    /**
     * Project 1.12.3 reserved value — Pressman is investigating
     * possible flakiness on this submission. No behavior change in
     * 1.12.3; reserved for when Pressman wants to mark a submission
     * as "hold for re-test" without flipping it back to queued
     * (which would let another Pressman pick it up). Future use
     * once attribution flow grows a "wait for green main" mode.
     */
    | 'flake-suspected';
  /** Phase-2 mechanical-retry counter. Penalized in priority formula. */
  retryCount: number;
  /**
   * Project 1.12.3 — forward-compat marker for parallel-lane
   * isolation. When multi-Pressman lands, scopeKeys identifies which
   * subspace of the codebase this submission touches (e.g. `["pkg:cli",
   * "pkg:shared"]`); two submissions with disjoint scopeKeys can
   * merge in parallel without conflict-risk, two with overlapping
   * keys serialize. Empty/null/absent in 1.12.3 — no consumer yet.
   * Schema is non-breaking so future scope-aware Pressmen can ship
   * without migrating existing submissions.
   */
  scopeKeys?: string[] | null;
  /** Phase-1 Editor-iteration counter. NOT penalized in priority formula. */
  reviewRound: number;
  /**
   * True if this submission reached Phase 2 via cap-hit (Editor
   * couldn't converge with author within the review-round cap) and
   * NOT via Editor approval. For audit + future CULTURE.md
   * compounding; does not change Pressman's behavior.
   */
  reviewBypassed?: boolean;
  /** ISO timestamp the Pressman claimed it. Null/absent while queued. */
  processingStartedAt?: string | null;
  /** Pressman Member.id currently processing. Null/absent while queued or after release. */
  processingBy?: string | null;
  /** ISO timestamp the merge landed. Set on `submissionStatus = 'merged'`. */
  mergedAt?: string | null;
  /** Resulting commit sha on main, for audit. Optional — some merges may not surface a sha. */
  mergeCommitSha?: string | null;
  /**
   * Free-form prose recording why the most recent attempt failed
   * (rebase classification, test failure summary, conflict summary).
   * Refreshed on each retry; the prior reason is overwritten because
   * the per-attempt history lives in step-log chits, not here.
   */
  lastFailureReason?: string | null;
}

/**
 * Fields for a `review-comment` chit (Project 1.12).
 *
 * One Editor-authored comment on a clearance-submission's diff.
 * Pedagogical Codex-shape — every comment carries the issue, the
 * *why*, and a suggested patch when one exists, so a substitute
 * agent picking up the fix cold can act on it without context.
 *
 * ### Severity is a real lever
 * Only `blocker` severity rejects the review round and bounces
 * the submission back to the author's role. `suggestion` and
 * `nit` are advisory — author MAY address them, doesn't HAVE to.
 * This prevents Editor from being so sticky that simple PRs cycle
 * forever on style preferences.
 *
 * Roughly:
 *   - `blocker` — contract-goal mismatch, missing required test,
 *     banned pattern (security hole, secret in diff), test
 *     regression, acceptance-criteria gap.
 *   - `suggestion` — naming improvement, refactor opportunity,
 *     clearer error message, alternative approach worth weighing.
 *   - `nit` — style preference, minor doc improvement, ordering.
 *
 * ### Lifecycle
 * Non-ephemeral. Comments persist for audit + CULTURE.md
 * compounding (recurring nit patterns become corp conventions over
 * time). chit.status `active` while open, `closed` when addressed
 * or made moot by re-review.
 */
export interface ReviewCommentFields {
  /**
   * Chit id of the clearance-submission this comment is on. Optional
   * because Editor's review runs BEFORE enterClearance creates the
   * submission — pre-submission comments carry null and only get a
   * submissionId backfilled if approve later writes one (currently
   * not done; taskId is the canonical link). Required-ness was
   * relaxed in Project 1.12.2 when Editor became pre-push.
   */
  submissionId?: string | null;
  /**
   * Chit id of the task this submission settles. Denormalized from
   * the submission for cheap filtering — `cc-cli chit list --type
   * review-comment --task <id>` shouldn't have to walk submissions.
   * Canonical link in the pre-submission flow (where submissionId
   * is null).
   */
  taskId: string;
  /** Member id of the Editor who wrote it. */
  reviewerSlug: string;
  /** Path within the repo. */
  filePath: string;
  /** 1-indexed line range start. */
  lineStart: number;
  /** Inclusive 1-indexed line range end. Often equals lineStart for single-line comments. Cross-field invariant: lineEnd >= lineStart. */
  lineEnd: number;
  /**
   * Severity. Only `blocker` rejects the round. See docstring.
   */
  severity: 'blocker' | 'suggestion' | 'nit';
  /**
   * Project 1.12.2 — what kind of problem this comment names.
   *
   *   - `bug`    — a Codex-style correctness / performance / security /
   *                maintainability issue in the code itself. Reading
   *                only the diff + related files surfaces these. The
   *                category Codex catches.
   *   - `drift`  — implementation diverges from what the task /
   *                contract specified. Underdevelopment (missing
   *                acceptance criteria), scope creep (touching code
   *                outside the contract goal), underplanning (literal
   *                criteria pass but spirit missed). Requires reading
   *                task.acceptanceCriteria + contract.goal alongside
   *                the diff. Where Editor beats Codex — it's why we
   *                have a per-corp Editor at all.
   *
   * Severity is orthogonal: a drift-blocker is "you missed half the
   * acceptance criteria"; a bug-nit is a typo in a comment. The
   * combination is what surfaces in Sexton's wake digest + becomes
   * CULTURE.md substrate ("this role keeps producing drift = the
   * spec process is too coarse for them").
   */
  category: 'bug' | 'drift';
  /** One-line summary of the issue. Required + non-empty. */
  issue: string;
  /** Pedagogical explanation — why this matters, what it could break, the principle behind it. The CULTURE.md substrate. */
  why: string;
  /**
   * Optional patch hint. When present, gives the substitute author
   * something concrete to start from rather than re-thinking the
   * fix cold. Accepts: a unified-diff snippet, a code block, or
   * prose like "rename `foo` to `bar` and update both call sites
   * in baz.ts."
   */
  suggestedPatch?: string | null;
  /** Which Phase-1 round this comment came from. Lets the corp track "issues we caught in round 1 vs round 2." */
  reviewRound: number;
}

/**
 * Project 1.12.3 — lane-event chit type.
 *
 * Immutable forensic record of a single state transition in the
 * Clearinghouse merge lane. Every meaningful step Pressman or Editor
 * takes — claim, rebase, test, attribute, merge, approve, reject —
 * writes one of these. The chronological stream is the corp's lane
 * diary: queryable, replayable, durable.
 *
 * Three uses:
 *   1. Forensic. `cc-cli clearinghouse show <submission>` renders
 *      the timeline. Bug reports become trivial — every transition
 *      is on disk.
 *   2. Aggregation. Sexton's wake digest pulls rolling-window stats
 *      (merges per hour, blocker count, attribution outcomes) from
 *      this stream. Notifications watcher fires DM/channel posts
 *      when terminal events land.
 *   3. Voice. The optional `narrative` field carries the agent's
 *      1-line prose ("first-try clean, no conflicts" or "the rebase
 *      from hell — 7 conflicts, 4 substantive, routed"). Accumulates
 *      into the corp's lane writing voice.
 *
 * ### Why one chit type, not two
 *
 * Pressman events and Editor events share the same submission/task
 * threading and the same renderers (timeline, log, digest). Splitting
 * into `pressman-event` + `editor-event` would fragment every reader.
 * One type with a `kind` discriminator keeps the diary unified.
 *
 * ### Lifecycle
 *
 * Non-ephemeral. The lane's history is durable corp memory — surviving
 * for years is a feature. chit.status is `active` on creation and
 * `closed` only via the shared abort-mid-write `burning` terminal.
 * Per-event chits never get re-opened — they're append-only.
 */
export interface LaneEventFields {
  /**
   * Submission this event belongs to. Canonical link for grouping
   * a PR's post-submission journey.
   *
   * Optional because Editor's pre-submission events fire before
   * the clearance-submission chit exists — `editor-claimed`,
   * `editor-rejected`, and `editor-released` always have null
   * submissionId; `editor-approved` and `editor-bypassed` populate
   * it because enterClearance creates the submission inside those
   * primitives. taskId is the always-required link.
   */
  submissionId?: string | null;
  /**
   * Task this submission settles. Denormalized from the submission for
   * cheap query-by-task — `cc-cli clearinghouse log --task <id>` shouldn't
   * have to walk submissions to filter.
   */
  taskId: string;
  /**
   * Which kind of state transition this records. The full taxonomy
   * spans 6 categories: submission lifecycle, rebase outcomes, test
   * outcomes, attribution outcomes, merge outcomes, editor terminal.
   */
  kind: LaneEventKind;
  /**
   * Member.id of the agent who emitted this event. Null when the
   * event was emitted by daemon-side machinery (resume sweeps,
   * watcher fallbacks, boot recovery) — agents don't author those.
   */
  emittedBy: string | null;
  /**
   * Optional 1-line agent prose. The "voice" of the lane. Pressman
   * writes these on judgment-laden events ("auto-resolved 3 trivial
   * conflicts on round 2"); Editor writes them on terminal events
   * ("approved round 1, no blockers"). Daemon-emitted events leave
   * this null. Renderers fall back to a kind-derived default
   * description when null.
   */
  narrative?: string | null;
  /**
   * Optional structural payload, kind-specific. Renderers and queries
   * read defensively — fields are populated only when relevant. The
   * type stays permissive (no per-kind discrimination) because the
   * combinatorial cost of a discriminated union per kind exceeds the
   * type-safety win at this scale.
   */
  payload?: LaneEventPayload | null;
}

/**
 * Project 1.12.3 — discriminator for lane-event kinds. Six categories:
 *
 *   submission lifecycle  — queued, claimed, finalized, blocked, failed
 *   worktree              — acquired
 *   rebase                — clean, auto-resolved, needs-author,
 *                           sanity-failed, fatal
 *   tests                 — passed, flake, consistent-fail, inconclusive
 *   attribution           — pr, main, mixed, inconclusive
 *   merge                 — success, race, hook-rejected, branch-deleted, fatal
 *   editor                — claimed, approved, rejected, bypassed, released
 *
 * The validator enforces this set; new kinds require schema bump.
 */
export type LaneEventKind =
  // Submission lifecycle
  | 'submission-queued'
  | 'submission-claimed'
  | 'submission-finalized'
  | 'submission-blocked'
  | 'submission-failed'
  // Worktree
  | 'worktree-acquired'
  // Rebase
  | 'rebase-clean'
  | 'rebase-auto-resolved'
  | 'rebase-needs-author'
  | 'rebase-sanity-failed'
  | 'rebase-fatal'
  // Tests
  | 'tests-passed'
  | 'tests-flake'
  | 'tests-consistent-fail'
  | 'tests-inconclusive'
  // Attribution (Project 1.12.3 attribution flow output)
  | 'tests-attributed-pr'
  | 'tests-attributed-main'
  | 'tests-attributed-mixed'
  | 'tests-attributed-inconclusive'
  // Merge
  | 'merge-success'
  | 'merge-race'
  | 'merge-hook-rejected'
  | 'merge-branch-deleted'
  | 'merge-fatal'
  // Editor
  | 'editor-claimed'
  | 'editor-approved'
  | 'editor-rejected'
  | 'editor-bypassed'
  | 'editor-released';

/**
 * Permissive payload for lane-events. All fields optional; each kind
 * populates the relevant subset. Validators check shape per field
 * when present, not which fields are present.
 */
export interface LaneEventPayload {
  /** Resulting commit sha. Populated on `merge-success`. */
  mergeCommitSha?: string;
  /** Branch name. Populated on most events that involve a branch. */
  branch?: string;
  /** Conflicted file paths. Populated on `rebase-needs-author`. */
  conflictedFiles?: string[];
  /** Files Pressman auto-resolved. Populated on `rebase-auto-resolved`. */
  autoResolvedFiles?: string[];
  /** Number of auto-resolution rounds the rebase took. */
  autoResolutionRounds?: number;
  /** Test failure names. Populated on `tests-consistent-fail` + attribution. */
  failureNames?: string[];
  /** Test run duration in milliseconds. Populated on test events. */
  testDurationMs?: number;
  /** Failure category from the PR 2 taxonomy. Populated on fatal/blocked events. */
  failureCategory?: string;
  /** Pedagogical failure summary. Populated alongside failureCategory. */
  failureSummary?: string;
  /** Editor review round (1-indexed). Populated on editor events. */
  reviewRound?: number;
  /** Cap-hit flag. Populated on `editor-rejected` when this round triggered the cap. */
  capHit?: boolean;
  /** Escalation chit id. Populated on blocker-filing events. */
  escalationId?: string;
  /** Hook output. Populated on `merge-hook-rejected`. */
  hookOutput?: string;
}

/**
 * Project 1.12.3 — pattern-observation chit type.
 *
 * The compounding-judgment substrate. At the end of a review session,
 * Editor optionally files zero-or-more of these if they noticed a
 * recurring theme. Future review sessions read relevant observations
 * (filtered by subject) as **priors** for the drift pass — the corp's
 * editor learns its own taste over time.
 *
 * Pure event-sourced: each observation is its own chit. Aggregation
 * happens at query time. No `recurrenceCount` stored; readers count
 * matching observations across the active set. New observations don't
 * mutate prior chits — the agent reads recent ones for the subject
 * and decides whether the new finding is novel.
 *
 * After 100 reviews the editor's perspective IS the corp's perspective.
 * Project 5's CULTURE.md emerges from real work via this substrate,
 * before the formal CULTURE.md primitive lands.
 *
 * ### Lifecycle
 *
 * Non-ephemeral. Observations are durable institutional memory.
 * chit.status `active` on creation; `closed` when an observation is
 * deemed stale (the pattern stopped recurring) or dismissed (false
 * positive). burning is the shared abort-mid-write terminal.
 */
export interface PatternObservationFields {
  /** Member.id of the Editor who filed it. */
  reviewerSlug: string;
  /** What the pattern is about — role-scoped, area-scoped, or corp-wide. */
  subject: PatternSubject;
  /**
   * One-paragraph finding describing the pattern. Pedagogical shape:
   * the *what* the editor saw + the *why* it matters + (when applicable)
   * the *fix* worth pushing on. Same register as a review-comment's
   * `why` field, scaled up to a multi-review trend.
   */
  finding: string;
  /**
   * Optional review-comment chit ids that informed this observation —
   * the specific instances that made the pattern visible. Lets a reader
   * walk from a pattern back to its evidence.
   */
  linkedComments?: string[] | null;
}

/**
 * Pattern subject — what dimension the observation groups by.
 *
 *   role          A specific role (e.g. backend-engineer keeps shipping
 *                 without happy-path tests).
 *   codebase-area A path prefix (e.g. packages/daemon/src/clearinghouse
 *                 keeps producing drift-blockers about side effects).
 *   corp-wide     Cross-cutting (e.g. PR titles trend toward over-broad
 *                 scope across roles).
 *
 * `role` populates `role`. `codebase-area` populates `codebaseArea`.
 * `corp-wide` populates neither. Validator enforces the consistency.
 */
export interface PatternSubject {
  kind: 'role' | 'codebase-area' | 'corp-wide';
  /** Required when kind='role'. */
  role?: string | null;
  /** Required when kind='codebase-area'. */
  codebaseArea?: string | null;
}
