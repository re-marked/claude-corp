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
  escalation: EscalationFields;
  blueprint: BlueprintFields;
  'sweeper-run': SweeperRunFields;
  kink: KinkFields;
  'breaker-trip': BreakerTripFields;
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
