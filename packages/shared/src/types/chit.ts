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
