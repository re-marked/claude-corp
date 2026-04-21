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
  | 'burning';

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
 * Fine-grained task workflow state. Distinct from chit.status (which is
 * the coarse universal lifecycle — draft/active/terminal). This enum
 * preserves the richer task-workflow vocabulary from the pre-chits Task
 * type so call sites that check e.g. `task.status === 'blocked'` keep
 * working. The chit-layer query surface filters on chit.status; task-
 * specific logic filters on fields.task.workflowStatus.
 */
export type TaskWorkflowStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'blocked'
  | 'completed'
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
  /** Free-form effort estimate (e.g. "~2 hours", "small"). Null means no estimate. */
  estimate?: string | null;
  /** Member id of the Partner who most recently handed this task (audit trail — who's accountable for it landing on this Casket). Null if never handed. */
  handedBy?: string | null;
  /** ISO timestamp of the most recent hand. Null if never handed. */
  handedAt?: string | null;
  /** ISO timestamp when the task should be done. Null for open-ended. */
  dueAt?: string | null;
  /** Chit id of the Loop driving this task (auto-advance tasks tied to recurring work). Null for standalone tasks. */
  loopId?: string | null;
  /** Fine-grained workflow state (pending/assigned/in_progress/blocked/completed/failed/cancelled). Coexists with chit.status; see TaskWorkflowStatus docstring. */
  workflowStatus?: TaskWorkflowStatus | null;
  /** Project.id the task belongs to. New tasks prefer `scope=project:<name>`; this field preserves the link for migrated tasks that pre-date scope-encoding. */
  projectId?: string | null;
  /** Team.id the task belongs to. Same legacy-link role as projectId. */
  teamId?: string | null;
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
