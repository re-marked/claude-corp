/**
 * Chit type registry — per-type configuration and validators.
 *
 * Each chit type registers here with its lifecycle config (ephemeral
 * default, TTL, valid statuses, terminal statuses) and a validator that
 * checks the fields.<type> payload at write time. The registry is the
 * single source of truth for "what kinds of chits exist and how they
 * behave."
 *
 * Adding a new chit type requires:
 *   1. Add a FieldsXxx interface in types/chit.ts
 *   2. Add an entry in FieldsForType (types/chit.ts)
 *   3. Write a validator function in this file
 *   4. Add an entry to CHIT_TYPES below
 *   5. Add the type id (with a 1-2 line "why this exists" comment) to
 *      `expectedTypeIds` in `tests/chit-types.test.ts` — the invariant
 *      test compares the hand-list against CHIT_TYPES so the "why"
 *      gets a documentation gate.
 * The registry invariant tests catch drift between FieldsForType and
 * CHIT_TYPES so missed steps fail the build.
 */

import type {
  ChitTypeId,
  ChitStatus,
  TaskFields,
  ContractFields,
  ObservationFields,
  CasketFields,
  HandoffFields,
  DispatchContextFields,
  PreBrainEntryFields,
  StepLogFields,
  InboxItemFields,
  EscalationFields,
  BlueprintFields,
  BlueprintStep,
  BlueprintVar,
  SweeperRunFields,
  KinkFields,
  BreakerTripFields,
  ClearanceSubmissionFields,
  ReviewCommentFields,
} from './types/chit.js';

// ─── Error class ────────────────────────────────────────────────────

/**
 * Thrown by chit validators when a fields payload is structurally invalid.
 * Carries the field path so callers can surface the failure precisely.
 */
export class ChitValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = 'ChitValidationError';
  }
}

// ─── Registry entry shape ───────────────────────────────────────────

/**
 * Destruction policy for ephemeral chits that age past their TTL without
 * receiving a promotion signal. Read by the chit-lifecycle scanner (0.6).
 *
 * - `'destroy-if-not-promoted'` — the classic ephemeral-record lifecycle.
 *   Used for chits whose content is semantically transient (handoffs
 *   consumed by successor, dispatch-contexts superseded by git history,
 *   role-level pre-brain-entries that lost the promotion race). Scanner
 *   removes the file, writes a one-line destruction log entry.
 *
 * - `'keep-forever'` — never destroy. Used for chits whose content is
 *   soul material the corp should not discard (observations). Scanner
 *   flips `status: 'cold'` + `ephemeral: false` instead; file stays on
 *   disk, still queryable (explicit `includeCold: true` opt-in),
 *   demoted out of scanner tracking so per-tick work stays bounded.
 *
 * Non-ephemeral types (task, contract, casket, step-log) carry
 * `'keep-forever'` as a sensible no-op — scanner only visits
 * `ephemeral: true` chits regardless of this field.
 */
export type DestructionPolicy = 'destroy-if-not-promoted' | 'keep-forever';

export interface ChitTypeEntry {
  /** Type id, matches a member of ChitTypeId. */
  id: ChitTypeId;
  /** Short eyeballable prefix for `chit-<prefix>-<hex>` id generation. */
  idPrefix: string;
  /** True when this type defaults to ephemeral on creation. Callers can override, but the default exists so most creators don't think about it. */
  defaultEphemeral: boolean;
  /** Duration string for auto-TTL when ephemeral=true (e.g. "7d", "24h", "1h"). Null when non-ephemeral or no default. */
  defaultTTL: string | null;
  /** Status a newly-created chit of this type gets when the caller doesn't specify one. Must be in validStatuses — invariant test enforces. */
  defaultStatus: ChitStatus;
  /** Statuses that represent terminal (closed/done) states for this type. Entering one disables further updates except re-opening via explicit override. */
  terminalStatuses: readonly ChitStatus[];
  /** All statuses valid for this type. status transitions outside this set are rejected at the cc-cli boundary. */
  validStatuses: readonly ChitStatus[];
  /** Policy for TTL-aged ephemeral chits without promotion signal. See DestructionPolicy docstring. Non-ephemeral types carry `'keep-forever'` as a no-op. */
  destructionPolicy: DestructionPolicy;
  /** Pure validator for the `fields.<type>` payload. Throws ChitValidationError on invalid input. Returning void on success. */
  validate: (fields: unknown) => void;
}

// ─── Validator helpers ──────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireObject(v: unknown, field: string): Record<string, unknown> {
  if (!isObject(v)) {
    throw new ChitValidationError(`${field} must be an object`, field);
  }
  return v;
}

function requireNonEmptyString(v: unknown, field: string): void {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ChitValidationError(`${field} must be a non-empty string`, field);
  }
}

function optionalString(v: unknown, field: string): void {
  if (v === undefined || v === null) return;
  if (typeof v !== 'string') {
    throw new ChitValidationError(`${field} must be a string or null`, field);
  }
}

function requireEnum<T extends string>(v: unknown, field: string, valid: readonly T[]): void {
  if (typeof v !== 'string' || !(valid as readonly string[]).includes(v)) {
    throw new ChitValidationError(`${field} must be one of: ${valid.join(', ')}`, field);
  }
}

function requireInteger(v: unknown, field: string, min: number, max: number): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ChitValidationError(`${field} must be an integer in [${min}, ${max}]`, field);
  }
}

function requireStringArray(v: unknown, field: string): void {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new ChitValidationError(`${field} must be an array of strings`, field);
  }
}

function optionalStringArray(v: unknown, field: string): void {
  if (v === undefined || v === null) return;
  requireStringArray(v, field);
}

function requireStringOrNull(v: unknown, field: string): void {
  if (v === null) return;
  if (typeof v !== 'string') {
    throw new ChitValidationError(`${field} must be a string or null`, field);
  }
}

/**
 * Strict ISO 8601 timestamp check — YYYY-MM-DDTHH:MM:SS with optional
 * fractional seconds and a Z or ±HH:MM offset. Rejects half-valid
 * strings (missing time, wrong separators, etc.) that would parse
 * loosely with Date.parse.
 */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function optionalIsoTimestamp(v: unknown, field: string): void {
  if (v === undefined || v === null) return;
  if (typeof v !== 'string' || !ISO_TIMESTAMP_PATTERN.test(v)) {
    throw new ChitValidationError(
      `${field} must be an ISO 8601 timestamp (e.g. 2026-04-21T15:30:00Z) or null`,
      field,
    );
  }
}

function optionalNonNegativeInteger(v: unknown, field: string): void {
  if (v === undefined || v === null) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new ChitValidationError(`${field} must be a non-negative integer`, field);
  }
}

// ─── Per-type validators ────────────────────────────────────────────

function validateTask(fields: unknown): void {
  const f = requireObject(fields, 'task') as Partial<TaskFields>;
  requireNonEmptyString(f.title, 'task.title');
  requireEnum(f.priority, 'task.priority', ['critical', 'high', 'normal', 'low'] as const);
  if (f.assignee !== undefined) requireStringOrNull(f.assignee, 'task.assignee');
  if (f.acceptanceCriteria !== undefined && f.acceptanceCriteria !== null) {
    requireStringArray(f.acceptanceCriteria, 'task.acceptanceCriteria');
  }
  if (f.complexity !== undefined && f.complexity !== null) {
    requireEnum(f.complexity, 'task.complexity', ['trivial', 'small', 'medium', 'large'] as const);
  }
  if (f.handedBy !== undefined) requireStringOrNull(f.handedBy, 'task.handedBy');
  optionalIsoTimestamp(f.handedAt, 'task.handedAt');
  optionalIsoTimestamp(f.dueAt, 'task.dueAt');
  if (f.loopId !== undefined) requireStringOrNull(f.loopId, 'task.loopId');
  if (f.workflowStatus !== undefined && f.workflowStatus !== null) {
    // Ten-state machine from REFACTOR.md 1.3. See TaskWorkflowStatus
    // docstring in types/chit.ts for the lifecycle diagram. Legacy
    // names 'pending' and 'assigned' are NOT accepted here; pre-1.3
    // chits carrying those names get remapped to 'draft' / 'queued'
    // via the tasks.ts read-wrapper (deriveTaskStatus) before hitting
    // this validator on any write path.
    requireEnum(f.workflowStatus, 'task.workflowStatus', [
      'draft',
      'queued',
      'dispatched',
      'in_progress',
      'blocked',
      'under_review',
      // Project 1.12: passed audit + Editor review (or cap-bypassed)
      // and the clearance-submission is queued/processing in the
      // Pressman lane.
      'clearance',
      'completed',
      'rejected',
      'failed',
      'cancelled',
    ] as const);
  }
  if (f.projectId !== undefined) requireStringOrNull(f.projectId, 'task.projectId');
  if (f.teamId !== undefined) requireStringOrNull(f.teamId, 'task.teamId');
  // Project 1.3 structured step I/O. Null signals "no output captured"
  // explicitly (distinct from undefined which means "field not present"
  // on pre-1.3 chits); both are legal.
  if (f.output !== undefined) requireStringOrNull(f.output, 'task.output');
}

function validateContract(fields: unknown): void {
  const f = requireObject(fields, 'contract') as Partial<ContractFields>;
  requireNonEmptyString(f.title, 'contract.title');
  requireNonEmptyString(f.goal, 'contract.goal');
  requireStringArray(f.taskIds, 'contract.taskIds');
  if (f.priority !== undefined) {
    requireEnum(f.priority, 'contract.priority', ['critical', 'high', 'normal', 'low'] as const);
  }
  if (f.leadId !== undefined) requireStringOrNull(f.leadId, 'contract.leadId');
  if (f.blueprintId !== undefined) requireStringOrNull(f.blueprintId, 'contract.blueprintId');
  optionalIsoTimestamp(f.deadline, 'contract.deadline');
  optionalIsoTimestamp(f.completedAt, 'contract.completedAt');
  if (f.reviewedBy !== undefined) requireStringOrNull(f.reviewedBy, 'contract.reviewedBy');
  if (f.reviewNotes !== undefined) requireStringOrNull(f.reviewNotes, 'contract.reviewNotes');
  optionalNonNegativeInteger(f.rejectionCount, 'contract.rejectionCount');
  if (f.projectId !== undefined) requireStringOrNull(f.projectId, 'contract.projectId');
}

function validateObservation(fields: unknown): void {
  const f = requireObject(fields, 'observation') as Partial<ObservationFields>;
  requireEnum(f.category, 'observation.category', [
    'FEEDBACK',
    'DECISION',
    'DISCOVERY',
    'PREFERENCE',
    'NOTICE',
    'CORRECTION',
  ] as const);
  requireNonEmptyString(f.subject, 'observation.subject');
  requireInteger(f.importance, 'observation.importance', 1, 5);
  if (f.object !== undefined) requireStringOrNull(f.object, 'observation.object');
  if (f.title !== undefined) requireStringOrNull(f.title, 'observation.title');
  if (f.context !== undefined) requireStringOrNull(f.context, 'observation.context');
}

function validateCasket(fields: unknown): void {
  const f = requireObject(fields, 'casket') as Partial<CasketFields>;
  // currentStep is the only required functional field; may be null (idle)
  if (f.currentStep === undefined) {
    throw new ChitValidationError('casket.currentStep must be defined (string or null)', 'casket.currentStep');
  }
  requireStringOrNull(f.currentStep, 'casket.currentStep');
  optionalIsoTimestamp(f.lastAdvanced, 'casket.lastAdvanced');
  optionalNonNegativeInteger(f.sessionCount, 'casket.sessionCount');
}

function validateHandoff(fields: unknown): void {
  const f = requireObject(fields, 'handoff') as Partial<HandoffFields>;
  requireNonEmptyString(f.predecessorSession, 'handoff.predecessorSession');
  requireNonEmptyString(f.currentStep, 'handoff.currentStep');
  requireStringArray(f.completed, 'handoff.completed');
  requireNonEmptyString(f.nextAction, 'handoff.nextAction');
  if (f.openQuestion !== undefined) requireStringOrNull(f.openQuestion, 'handoff.openQuestion');
  if (f.sandboxState !== undefined) requireStringOrNull(f.sandboxState, 'handoff.sandboxState');
  if (f.notes !== undefined) requireStringOrNull(f.notes, 'handoff.notes');
}

function validateDispatchContext(fields: unknown): void {
  const f = requireObject(fields, 'dispatch-context') as Partial<DispatchContextFields>;
  requireNonEmptyString(f.sourceAgent, 'dispatch-context.sourceAgent');
  requireNonEmptyString(f.targetAgent, 'dispatch-context.targetAgent');
  requireNonEmptyString(f.workChitId, 'dispatch-context.workChitId');
  if (f.contractId !== undefined) requireStringOrNull(f.contractId, 'dispatch-context.contractId');
  if (f.reason !== undefined) requireStringOrNull(f.reason, 'dispatch-context.reason');
}

function validatePreBrainEntry(fields: unknown): void {
  const f = requireObject(fields, 'pre-brain-entry') as Partial<PreBrainEntryFields>;
  requireNonEmptyString(f.role, 'pre-brain-entry.role');
  requireEnum(f.memoryType, 'pre-brain-entry.memoryType', ['rule', 'fact', 'preference', 'insight'] as const);
  requireEnum(f.confidence, 'pre-brain-entry.confidence', ['low', 'medium', 'high'] as const);
  if (f.provenance !== undefined && f.provenance !== null) {
    requireStringArray(f.provenance, 'pre-brain-entry.provenance');
  }
}

function validateStepLog(fields: unknown): void {
  const f = requireObject(fields, 'step-log') as Partial<StepLogFields>;
  requireNonEmptyString(f.taskChitId, 'step-log.taskChitId');
  requireNonEmptyString(f.phase, 'step-log.phase');
  requireEnum(f.outcome, 'step-log.outcome', ['started', 'in-progress', 'completed', 'failed'] as const);
  if (f.details !== undefined) requireStringOrNull(f.details, 'step-log.details');
}

function validateEscalation(fields: unknown): void {
  const f = requireObject(fields, 'escalation') as Partial<EscalationFields>;
  requireNonEmptyString(f.originatingChit, 'escalation.originatingChit');
  requireNonEmptyString(f.reason, 'escalation.reason');
  requireNonEmptyString(f.from, 'escalation.from');
  requireNonEmptyString(f.to, 'escalation.to');
  requireEnum(f.severity, 'escalation.severity', ['blocker', 'question', 'review'] as const);
  if (f.resolution !== undefined && f.resolution !== null) {
    requireEnum(f.resolution, 'escalation.resolution', ['resolved', 'dismissed', 'converted-to-task'] as const);
  }
  if (f.resolutionNotes !== undefined) requireStringOrNull(f.resolutionNotes, 'escalation.resolutionNotes');
  if (f.convertedTaskId !== undefined) requireStringOrNull(f.convertedTaskId, 'escalation.convertedTaskId');
  // Coherence: convertedTaskId only meaningful when resolution === 'converted-to-task'.
  // We don't strictly reject `convertedTaskId` on other resolutions (caller might
  // annotate a rejected escalation with a later-created replacement task id for
  // audit), but we DO require the pairing in one direction: if resolution is
  // 'converted-to-task' and convertedTaskId is null/empty, the decision record
  // is incomplete — reject at write time so the audit trail stays honest.
  if (f.resolution === 'converted-to-task' && (f.convertedTaskId === null || f.convertedTaskId === undefined || f.convertedTaskId === '')) {
    throw new ChitValidationError(
      'escalation.convertedTaskId is required when resolution is "converted-to-task"',
      'escalation.convertedTaskId',
    );
  }
}

/**
 * Blueprint validator — checks the full Blueprint shape the Project 1.8
 * cast primitive depends on. This runs at chit WRITE time, so every
 * invariant cast later relies on (unique step ids, valid DAG, referenced
 * roles, var coverage) must be guaranteed here.
 *
 * Heavier than other validators on purpose: a malformed blueprint
 * discovered at cast-time is a silent corp bug; one rejected at write-
 * time is loud and fixable.
 */
function validateBlueprint(fields: unknown): void {
  const f = requireObject(fields, 'blueprint') as Partial<BlueprintFields>;

  // name is load-bearing — this is what `cc-cli blueprint cast <name>`
  // resolves against. Required, kebab-case-ish, allows `/` so category
  // prefixes (`patrol/health-check`, `patrol/corp-health`) compose
  // cleanly. Start + end alphanumeric lowercase so `foo-` and `/foo`
  // and trailing-slash paths are rejected. Uniqueness-per-scope is
  // enforced at the CLI boundary (validator has no scope access).
  requireNonEmptyString(f.name, 'blueprint.name');
  if (!/^[a-z0-9](?:[a-z0-9_/-]*[a-z0-9])?$/.test(f.name!)) {
    throw new ChitValidationError(
      `blueprint.name must be kebab-case-ish: lowercase alphanumeric, body may contain - _ / (got ${JSON.stringify(f.name)})`,
      'blueprint.name',
    );
  }

  // origin is load-bearing — drives `cc-cli update --blueprints`
  // reseed behavior and the list-view badge. Always required.
  requireEnum(f.origin, 'blueprint.origin', ['authored', 'builtin'] as const);

  // kind discriminates cast-path. Optional for backwards compat —
  // 1.8-era blueprints (pre-1.9) have no `kind` field and default to
  // 'contract' at cast time. New 1.9+ sweeper blueprints set
  // `kind: 'sweeper'` explicitly. The cast primitives enforce that
  // each kind routes to its own cast path; this validator only
  // enforces the value is one of the two legal shapes when present.
  if (f.kind !== undefined) {
    requireEnum(f.kind, 'blueprint.kind', ['contract', 'sweeper'] as const);
  }

  // steps must exist and be non-empty. A zero-step blueprint is nonsense
  // at cast — it would produce a Contract with no Tasks.
  if (!Array.isArray(f.steps) || f.steps.length === 0) {
    throw new ChitValidationError(
      'blueprint.steps must be a non-empty array',
      'blueprint.steps',
    );
  }

  // Validate each step's structural fields + accumulate the id set for
  // duplicate detection and the subsequent DAG check.
  const stepIds = new Set<string>();
  f.steps.forEach((raw, i) => {
    const stepPath = `blueprint.steps[${i}]`;
    const step = requireObject(raw, stepPath) as Partial<BlueprintStep>;
    requireNonEmptyString(step.id, `${stepPath}.id`);
    // Kebab-case constraint: ids live in file paths + depends_on
    // references + CLI arg contexts + chit tags (`blueprint-step:<id>`).
    // Lowercase-only keeps authored ids uniform with role ids + chit
    // tag conventions across the corp. Uppercase was silently accepted
    // in the initial implementation — reviewer catch (PR #171 P2).
    if (!/^[a-z0-9_-]+$/.test(step.id!)) {
      throw new ChitValidationError(
        `${stepPath}.id must be lowercase alphanumeric + underscore/hyphen only (got ${JSON.stringify(step.id)})`,
        `${stepPath}.id`,
      );
    }
    if (stepIds.has(step.id!)) {
      throw new ChitValidationError(
        `${stepPath}.id "${step.id}" duplicates an earlier step id — step ids must be unique within a blueprint`,
        `${stepPath}.id`,
      );
    }
    stepIds.add(step.id!);

    requireNonEmptyString(step.title, `${stepPath}.title`);
    if (step.description !== undefined) optionalString(step.description, `${stepPath}.description`);

    if (step.dependsOn !== undefined && step.dependsOn !== null) {
      requireStringArray(step.dependsOn, `${stepPath}.dependsOn`);
    }

    if (step.acceptanceCriteria !== undefined && step.acceptanceCriteria !== null) {
      requireStringArray(step.acceptanceCriteria, `${stepPath}.acceptanceCriteria`);
    }

    // assigneeRole can be null (cast-time resolution) or a role-registry
    // id. Role existence is NOT cross-checked here — the registry lives
    // in a downstream module and a blueprint might reference a role
    // added later; cast validates against the live registry when it
    // matters. What WE enforce is the format invariant: role ids are
    // kebab-case alphanumeric ('backend-engineer', 'ceo', 'sexton').
    // Scope-qualified slugs ('agent:toast', 'project:fire/...') are
    // SLOT references, not role references — accepting them would
    // over-couple a blueprint to a specific Employee and defeat the
    // role-abstraction the design depends on. Reject with a message
    // that teaches the role-vs-slot distinction.
    if (step.assigneeRole !== undefined) {
      requireStringOrNull(step.assigneeRole, `${stepPath}.assigneeRole`);
      if (typeof step.assigneeRole === 'string') {
        if (!/^[a-z][a-z0-9-]*$/.test(step.assigneeRole)) {
          const hint = step.assigneeRole.includes(':')
            ? ' (looks like a scope-qualified slug — blueprints assign to ROLES, not specific slots; use e.g. "backend-engineer" instead of "agent:toast")'
            : ' (lowercase alphanumeric + hyphens only)';
          throw new ChitValidationError(
            `${stepPath}.assigneeRole must be a role id${hint} — got ${JSON.stringify(step.assigneeRole)}`,
            `${stepPath}.assigneeRole`,
          );
        }
      }
    }

    // moduleRef targets a code sweeper module for kind=sweeper
    // blueprints (Project 1.9). Format is kebab-case (`session-gc`,
    // `phantom-cleanup`). Module existence is NOT cross-checked here —
    // the sweepers registry lives in a downstream package and is
    // resolved at dispatch time, where a missing module fails loudly.
    //
    // Cross-field check: a non-null moduleRef is only meaningful on
    // kind=sweeper blueprints. Setting it on a contract-kind blueprint
    // (or leaving kind absent — which defaults to contract) is almost
    // certainly an authoring mistake — the author wrote a sweeper-
    // shaped step but forgot to tag the blueprint as kind=sweeper, so
    // castFromBlueprint would cast it as Task chits that silently
    // ignore moduleRef. Rejecting at write time surfaces the mistake
    // loudly, right where the author can fix it — instead of leaving
    // them wondering weeks later why their sweeper never fires.
    if (step.moduleRef !== undefined) {
      requireStringOrNull(step.moduleRef, `${stepPath}.moduleRef`);
      if (typeof step.moduleRef === 'string') {
        if (!/^[a-z][a-z0-9-]*$/.test(step.moduleRef)) {
          throw new ChitValidationError(
            `${stepPath}.moduleRef must be kebab-case lowercase alphanumeric + hyphens (got ${JSON.stringify(step.moduleRef)})`,
            `${stepPath}.moduleRef`,
          );
        }
        // Non-null moduleRef requires kind=sweeper. Absent kind or
        // 'contract' both mean "not a sweeper" per the BlueprintFields.kind
        // semantics documented on the type.
        if (f.kind !== 'sweeper') {
          throw new ChitValidationError(
            `${stepPath}.moduleRef is set (${JSON.stringify(step.moduleRef)}) but blueprint.kind is '${f.kind ?? 'contract (default)'}' — moduleRef is only meaningful on kind=sweeper blueprints. ` +
              `Either set blueprint.kind: 'sweeper' (if this is a sweeper), or remove moduleRef from the step (if this is a contract blueprint).`,
            `${stepPath}.moduleRef`,
          );
        }
      }
    }
  });

  // DAG check pass 2: every dependsOn reference must point at a real
  // step id within this blueprint, and there must be no cycles. Done
  // AFTER all step ids are collected so order-of-appearance doesn't
  // matter (a step can depend on one declared later).
  const graph = new Map<string, readonly string[]>();
  f.steps.forEach((raw, i) => {
    const step = raw as BlueprintStep;
    const deps = step.dependsOn ?? [];
    for (const d of deps) {
      if (!stepIds.has(d)) {
        throw new ChitValidationError(
          `blueprint.steps[${i}].dependsOn references unknown step id "${d}" — must match another step's id in this blueprint`,
          `blueprint.steps[${i}].dependsOn`,
        );
      }
    }
    graph.set(step.id, deps);
  });

  // Cycle detection via DFS with coloring: white (unvisited), gray
  // (on current path), black (fully explored). A gray→gray edge = cycle.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of stepIds) color.set(id, WHITE);

  function visit(id: string, path: string[]): void {
    if (color.get(id) === BLACK) return;
    if (color.get(id) === GRAY) {
      const cycleStart = path.indexOf(id);
      const cycle = path.slice(cycleStart).concat(id).join(' → ');
      throw new ChitValidationError(
        `blueprint.steps contains a dependency cycle: ${cycle}`,
        'blueprint.steps',
      );
    }
    color.set(id, GRAY);
    for (const d of graph.get(id) ?? []) visit(d, [...path, id]);
    color.set(id, BLACK);
  }
  for (const id of stepIds) visit(id, []);

  // Vars validation — optional, but if present every entry must be
  // well-formed. The var-coverage check (every {{name}} reference in
  // step strings resolves from this list) lives in the parser layer
  // (next PR), not here — templated strings are allowed through the
  // chit-type validator so cast-time binding has something to work with.
  if (f.vars !== undefined && f.vars !== null) {
    if (!Array.isArray(f.vars)) {
      throw new ChitValidationError('blueprint.vars must be an array when present', 'blueprint.vars');
    }
    const varNames = new Set<string>();
    f.vars.forEach((raw, i) => {
      const path = `blueprint.vars[${i}]`;
      const v = requireObject(raw, path) as Partial<BlueprintVar>;
      requireNonEmptyString(v.name, `${path}.name`);
      if (varNames.has(v.name!)) {
        throw new ChitValidationError(
          `${path}.name "${v.name}" duplicates an earlier var name — var names must be unique within a blueprint`,
          `${path}.name`,
        );
      }
      varNames.add(v.name!);
      requireEnum(v.type, `${path}.type`, ['string', 'int', 'bool'] as const);
      // Default type must match declared var type. Null is always allowed
      // (author signaling "optional with no default — caller must pass").
      // Catching mismatch at write time is the whole point: a `type: 'int'`
      // var with `default: "5"` is author error, and cast-time coercion
      // would silently "fix" it while hiding the bug. Fail loudly here.
      // `requireEnum` above guarantees v.type is one of the three values
      // by the time we get here.
      if (v.default !== undefined && v.default !== null) {
        const actual = typeof v.default;
        let ok = false;
        switch (v.type) {
          case 'string':
            ok = actual === 'string';
            break;
          case 'int':
            ok = actual === 'number' && Number.isInteger(v.default);
            break;
          case 'bool':
            ok = actual === 'boolean';
            break;
        }
        if (!ok) {
          const got = actual === 'number' && !Number.isInteger(v.default) ? 'non-integer number' : actual;
          throw new ChitValidationError(
            `${path}.default must match type='${v.type}' or be null (got ${got}: ${JSON.stringify(v.default)})`,
            `${path}.default`,
          );
        }
      }
      if (v.description !== undefined) optionalString(v.description, `${path}.description`);
    });
  }

  // Title + summary are metadata for list views — optional everywhere.
  if (f.title !== undefined) requireStringOrNull(f.title, 'blueprint.title');
  if (f.summary !== undefined) requireStringOrNull(f.summary, 'blueprint.summary');
}

function validateInboxItem(fields: unknown): void {
  const f = requireObject(fields, 'inbox-item') as Partial<InboxItemFields>;
  // Tier is the load-bearing discriminant — if it's wrong the whole
  // lifecycle treats the chit incorrectly, so validate strictly.
  if (f.tier !== 1 && f.tier !== 2 && f.tier !== 3) {
    throw new ChitValidationError(
      `inbox-item.tier must be 1, 2, or 3 (got ${JSON.stringify(f.tier)})`,
      'inbox-item.tier',
    );
  }
  requireNonEmptyString(f.from, 'inbox-item.from');
  requireNonEmptyString(f.subject, 'inbox-item.subject');
  requireEnum(f.source, 'inbox-item.source', ['channel', 'dm', 'hand', 'escalation', 'system'] as const);
  if (f.sourceRef !== undefined) requireStringOrNull(f.sourceRef, 'inbox-item.sourceRef');
  if (f.resolution !== undefined && f.resolution !== null) {
    requireEnum(f.resolution, 'inbox-item.resolution', ['responded', 'dismissed'] as const);
  }
  if (f.dismissalReason !== undefined) requireStringOrNull(f.dismissalReason, 'inbox-item.dismissalReason');
  if (f.carriedForward !== undefined && f.carriedForward !== null && typeof f.carriedForward !== 'boolean') {
    throw new ChitValidationError('inbox-item.carriedForward must be a boolean or null', 'inbox-item.carriedForward');
  }
  if (f.carryReason !== undefined) requireStringOrNull(f.carryReason, 'inbox-item.carryReason');
  if (f.carriedForward === true && (f.carryReason === null || f.carryReason === undefined || f.carryReason === '')) {
    // carriedForward without a reason defeats the whole point — the audit
    // gate can't evaluate "is this a legitimate punt" without text.
    throw new ChitValidationError(
      'inbox-item.carryReason is required when carriedForward is true',
      'inbox-item.carryReason',
    );
  }
}

/**
 * Sweeper-run validator (Project 1.9). A sweeper-run records one
 * dispatch of a sweeper blueprint. Validator enforces the shape
 * castSweeperFromBlueprint writes, so any manual creation / update
 * of sweeper-run chits (via `cc-cli chit` tools) stays consistent.
 *
 * Chit-id references aren't walked here — the validator is pure on
 * field shape. The lifecycle scanner + Sexton's patrol reader handle
 * the "does this id resolve?" question when they're actually using
 * the reference.
 */
function validateSweeperRun(fields: unknown): void {
  const f = requireObject(fields, 'sweeper-run') as Partial<SweeperRunFields>;

  // blueprintId is load-bearing — every sweeper-run traces to its
  // source blueprint. Must be a chit id. Format check is loose (we
  // accept any non-empty string) because chit id format is owned by
  // chits.ts; stricter validation would duplicate that responsibility.
  requireNonEmptyString(f.blueprintId, 'sweeper-run.blueprintId');

  // triggeredBy is the member id of the initiator. Sexton on her
  // patrol cycle; founder when `cc-cli sweeper new` triggers a first-
  // run dispatch. Non-empty ensures audit trail isn't blank.
  requireNonEmptyString(f.triggeredBy, 'sweeper-run.triggeredBy');

  // Optional context string — free form.
  if (f.triggerContext !== undefined) {
    optionalString(f.triggerContext, 'sweeper-run.triggerContext');
  }

  // moduleRef: string (code sweeper) | null (AI sweeper) | absent.
  // Absent and null both mean "no code module" in practice; we accept
  // either so writers don't have to choose which absent-shape to use.
  if (f.moduleRef !== undefined) {
    requireStringOrNull(f.moduleRef, 'sweeper-run.moduleRef');
  }

  // outcome is the load-bearing state discriminant. Running is the
  // create-time default; dispatch completion flips to one of the
  // three terminal values.
  requireEnum(
    f.outcome,
    'sweeper-run.outcome',
    ['running', 'success', 'failure', 'cancelled'] as const,
  );

  // observationsProduced is an array of chit ids — same loose
  // validation as blueprintId (non-empty strings; format owned by
  // chits.ts). Empty array is legal: "sweeper ran, found nothing
  // noteworthy."
  if (f.observationsProduced !== undefined && f.observationsProduced !== null) {
    requireStringArray(f.observationsProduced, 'sweeper-run.observationsProduced');
  }

  // decision is free-form text — a sentence or two about what the
  // sweeper concluded. Optional because some sweeper-runs end in
  // no-op silence and forcing text would invent words.
  if (f.decision !== undefined) {
    optionalString(f.decision, 'sweeper-run.decision');
  }
}

function validateClearanceSubmission(fields: unknown): void {
  const f = requireObject(fields, 'clearance-submission') as Partial<ClearanceSubmissionFields>;

  // Identity / linkage — all required + non-empty.
  requireNonEmptyString(f.branch, 'clearance-submission.branch');
  requireNonEmptyString(f.contractId, 'clearance-submission.contractId');
  requireNonEmptyString(f.taskId, 'clearance-submission.taskId');
  requireNonEmptyString(f.submitter, 'clearance-submission.submitter');

  // Priority is snapshotted from the task at submit time so the
  // queue order is stable. Strict enum.
  requireEnum(f.priority, 'clearance-submission.priority', [
    'critical',
    'high',
    'normal',
    'low',
  ] as const);

  // Submitted timestamp is mandatory — anchor for queue-age scoring.
  if (f.submittedAt === undefined || f.submittedAt === null) {
    throw new ChitValidationError(
      'clearance-submission.submittedAt is required (ISO 8601 timestamp)',
      'clearance-submission.submittedAt',
    );
  }
  optionalIsoTimestamp(f.submittedAt, 'clearance-submission.submittedAt');

  // The rich state machine. chit.status is coarser; this is the
  // source of truth for "where is this submission in the lane."
  requireEnum(f.submissionStatus, 'clearance-submission.submissionStatus', [
    'queued',
    'processing',
    'merged',
    'conflict',
    'rejected',
    'failed',
  ] as const);

  // Counters — integers, generous ceiling. retryCount and
  // reviewRound are tracked separately because they're penalized
  // differently in the priority formula (retry penalized, review
  // not).
  requireInteger(f.retryCount, 'clearance-submission.retryCount', 0, 1_000_000);
  requireInteger(f.reviewRound, 'clearance-submission.reviewRound', 0, 1_000_000);

  // reviewBypassed is optional. When present, MUST be boolean.
  if (f.reviewBypassed !== undefined && f.reviewBypassed !== null && typeof f.reviewBypassed !== 'boolean') {
    throw new ChitValidationError(
      'clearance-submission.reviewBypassed must be a boolean or null/absent',
      'clearance-submission.reviewBypassed',
    );
  }

  // Processing-state fields. Optional — present when claimed by a
  // Pressman, absent or null while queued.
  optionalIsoTimestamp(f.processingStartedAt, 'clearance-submission.processingStartedAt');
  if (f.processingBy !== undefined) requireStringOrNull(f.processingBy, 'clearance-submission.processingBy');

  // Merged-state fields. Optional; populated on `submissionStatus = 'merged'`.
  optionalIsoTimestamp(f.mergedAt, 'clearance-submission.mergedAt');
  if (f.mergeCommitSha !== undefined) requireStringOrNull(f.mergeCommitSha, 'clearance-submission.mergeCommitSha');

  // Latest-failure prose. Free form. Refreshed per attempt; per-attempt
  // detail lives in step-log chits, not here.
  if (f.lastFailureReason !== undefined) requireStringOrNull(f.lastFailureReason, 'clearance-submission.lastFailureReason');
}

function validateReviewComment(fields: unknown): void {
  const f = requireObject(fields, 'review-comment') as Partial<ReviewCommentFields>;

  // Linkage — submissionId + taskId both required so queries can
  // filter either way without walking the chain.
  requireNonEmptyString(f.submissionId, 'review-comment.submissionId');
  requireNonEmptyString(f.taskId, 'review-comment.taskId');
  requireNonEmptyString(f.reviewerSlug, 'review-comment.reviewerSlug');

  // Location.
  requireNonEmptyString(f.filePath, 'review-comment.filePath');
  requireInteger(f.lineStart, 'review-comment.lineStart', 1, 10_000_000);
  requireInteger(f.lineEnd, 'review-comment.lineEnd', 1, 10_000_000);
  // Cross-field invariant: lineEnd >= lineStart. A reversed range
  // is almost certainly an authoring mistake; reject loudly so the
  // Editor's writer surfaces it instead of producing an unrenderable
  // comment.
  if (typeof f.lineStart === 'number' && typeof f.lineEnd === 'number' && f.lineEnd < f.lineStart) {
    throw new ChitValidationError(
      `review-comment.lineEnd (${f.lineEnd}) must be >= lineStart (${f.lineStart})`,
      'review-comment.lineEnd',
    );
  }

  // Severity — only blocker rejects the round; others advisory.
  requireEnum(f.severity, 'review-comment.severity', ['blocker', 'suggestion', 'nit'] as const);

  // Comment content. issue + why both required + non-empty —
  // Editor must articulate both for the comment to compound into
  // CULTURE.md substrate later.
  requireNonEmptyString(f.issue, 'review-comment.issue');
  requireNonEmptyString(f.why, 'review-comment.why');

  // Suggested patch is optional but recommended. String or null;
  // empty string would imply "patch field exists but is blank,"
  // which is meaningless — reject by treating empty differently
  // from absent. Use requireStringOrNull's existing semantics
  // (string or null only); absent is also fine.
  if (f.suggestedPatch !== undefined) requireStringOrNull(f.suggestedPatch, 'review-comment.suggestedPatch');

  // Round counter — integer >= 1 (round 1 is the first review pass).
  requireInteger(f.reviewRound, 'review-comment.reviewRound', 1, 1_000_000);
}

function validateBreakerTrip(fields: unknown): void {
  const f = requireObject(fields, 'breaker-trip') as Partial<BreakerTripFields>;

  // slug is the dedup key (combined with status='active'). Required +
  // non-empty so findActiveBreaker can never collide on "" or be
  // ambiguous. Member ids ARE the slug here — same string the
  // silent-exit kink's `subject` carries.
  requireNonEmptyString(f.slug, 'breaker-trip.slug');

  // trippedAt is the audit anchor. Required ISO timestamp so the
  // founder always knows when the loop started. Strict format —
  // optionalIsoTimestamp accepts undefined; we want it always set.
  if (f.trippedAt === undefined || f.trippedAt === null) {
    throw new ChitValidationError(
      'breaker-trip.trippedAt is required (ISO 8601 timestamp)',
      'breaker-trip.trippedAt',
    );
  }
  optionalIsoTimestamp(f.trippedAt, 'breaker-trip.trippedAt');

  // triggerCount must be ≥1 (the trip itself counts as occurrence 1)
  // and within a sane ceiling. A loop with thousands of crashes
  // means something pathological and we want loud audit, not a
  // validator overflow.
  requireInteger(f.triggerCount, 'breaker-trip.triggerCount', 1, 1_000_000);

  // triggerWindowMs + triggerThreshold are config snapshots — must
  // be present and positive. Zero or negative would mean a trip
  // fired with nonsensical config; reject loudly.
  requireInteger(f.triggerWindowMs, 'breaker-trip.triggerWindowMs', 1, Number.MAX_SAFE_INTEGER);
  requireInteger(f.triggerThreshold, 'breaker-trip.triggerThreshold', 1, 1_000_000);

  // recentSilentexitKinks + spawnHistory are arrays of chit ids /
  // ISO timestamps respectively. Format check is loose (string
  // arrays); semantic correctness is the writer's responsibility.
  requireStringArray(f.recentSilentexitKinks, 'breaker-trip.recentSilentexitKinks');
  requireStringArray(f.spawnHistory, 'breaker-trip.spawnHistory');

  // reason is the prose summary. Required + non-empty so audit
  // reads always have something — even the auto-detector writes
  // a default sentence, so empty here means a writer skipped it.
  requireNonEmptyString(f.reason, 'breaker-trip.reason');

  // Close-path fields are optional while active, populated on
  // close. Format-only validation here; the cross-field "if
  // status=closed then clearedAt+clearedBy must be set" rule
  // belongs to the close-helper, not the chit validator.
  optionalIsoTimestamp(f.clearedAt, 'breaker-trip.clearedAt');
  if (f.clearedBy !== undefined) requireStringOrNull(f.clearedBy, 'breaker-trip.clearedBy');
  if (f.clearReason !== undefined) requireStringOrNull(f.clearReason, 'breaker-trip.clearReason');
}

function validateKink(fields: unknown): void {
  const f = requireObject(fields, 'kink') as Partial<KinkFields>;

  // Dedup key is (source, subject) — both required and non-empty
  // so that key can never collide with "" or be ambiguous. source
  // follows the `<subsystem>:<detector>` convention (enforced by
  // convention, not by regex — new subsystems shouldn't need
  // validator edits).
  requireNonEmptyString(f.source, 'kink.source');
  requireNonEmptyString(f.subject, 'kink.subject');

  // Severity drives how loudly Sexton surfaces the kink. Enum
  // rather than free-form so filters like "show me open errors"
  // stay reliable.
  requireEnum(f.severity, 'kink.severity', ['info', 'warn', 'error'] as const);

  // Title is the one-line summary for list views. Required + non-
  // empty so `cc-cli chit list --type kink` never renders blank
  // rows; detailed context goes in the chit body.
  requireNonEmptyString(f.title, 'kink.title');

  // occurrenceCount tracks dedup bumps while active. Always at
  // least 1 (the initial create is occurrence #1). Integer-min-1
  // with a generous ceiling — a kink hitting thousands of
  // occurrences means something's very wrong with the underlying
  // condition, not with this field.
  requireInteger(f.occurrenceCount, 'kink.occurrenceCount', 1, 1_000_000);

  // resolution is set on transition to closed; null/absent while
  // active. Enum values match the three documented close-reasons.
  if (f.resolution !== undefined && f.resolution !== null) {
    requireEnum(f.resolution, 'kink.resolution', [
      'auto-resolved',
      'acknowledged',
      'dismissed',
    ] as const);
  }
}

// ─── Registry ────────────────────────────────────────────────────────

/**
 * The full registry. Every chit type in FieldsForType MUST have exactly
 * one entry here, and every idPrefix must be unique — invariant tests
 * enforce both.
 */
export const CHIT_TYPES: readonly ChitTypeEntry[] = [
  {
    id: 'task',
    idPrefix: 't',
    defaultEphemeral: false,
    defaultTTL: null,
    defaultStatus: 'draft',
    validStatuses: ['draft', 'active', 'completed', 'rejected', 'failed', 'closed'],
    terminalStatuses: ['completed', 'rejected', 'failed', 'closed'],
    destructionPolicy: 'keep-forever', // non-ephemeral — scanner never visits, field is a no-op
    validate: validateTask,
  },
  {
    id: 'contract',
    idPrefix: 'c',
    defaultEphemeral: false,
    defaultTTL: null,
    defaultStatus: 'draft',
    // Project 1.12: 'clearance' added — contract sits here while
    // its tasks' clearance-submissions are queued/processing in the
    // Pressman lane, transitions to 'completed' when all merge.
    validStatuses: ['draft', 'active', 'review', 'clearance', 'completed', 'rejected', 'failed', 'closed'],
    terminalStatuses: ['completed', 'rejected', 'failed', 'closed'],
    destructionPolicy: 'keep-forever', // non-ephemeral — scanner never visits, field is a no-op
    validate: validateContract,
  },
  {
    id: 'observation',
    idPrefix: 'o',
    defaultEphemeral: true,
    defaultTTL: '7d',
    defaultStatus: 'active',
    // `cold` reachable only via the 0.6 scanner's TTL-aged + keep-forever path;
    // manual re-warm via `cc-cli chit update --status active` moves it back to active.
    validStatuses: ['active', 'closed', 'burning', 'cold'],
    terminalStatuses: ['closed', 'burning'], // cold is NOT terminal — it's re-warmable
    destructionPolicy: 'keep-forever', // soul material; flip to cold instead of destroying
    validate: validateObservation,
  },
  {
    id: 'casket',
    idPrefix: 'cask',
    defaultEphemeral: false,
    defaultTTL: null,
    defaultStatus: 'active',
    validStatuses: ['active'],
    terminalStatuses: [],
    destructionPolicy: 'keep-forever', // non-ephemeral — scanner never visits, field is a no-op
    validate: validateCasket,
  },
  {
    id: 'handoff',
    idPrefix: 'h',
    defaultEphemeral: true,
    defaultTTL: '24h',
    defaultStatus: 'active',
    validStatuses: ['active', 'closed', 'burning'],
    terminalStatuses: ['closed', 'burning'],
    destructionPolicy: 'destroy-if-not-promoted', // consumed by successor; accumulating = noise
    validate: validateHandoff,
  },
  {
    id: 'dispatch-context',
    idPrefix: 'dc',
    defaultEphemeral: true,
    defaultTTL: '1h',
    defaultStatus: 'active',
    validStatuses: ['active', 'closed', 'burning'],
    terminalStatuses: ['closed', 'burning'],
    destructionPolicy: 'destroy-if-not-promoted', // superseded by git history on work completion
    validate: validateDispatchContext,
  },
  {
    id: 'pre-brain-entry',
    idPrefix: 'pbe',
    defaultEphemeral: true,
    defaultTTL: '7d',
    defaultStatus: 'active',
    validStatuses: ['active', 'closed', 'burning'],
    terminalStatuses: ['closed', 'burning'],
    destructionPolicy: 'destroy-if-not-promoted', // unpromoted candidates are noise by definition
    validate: validatePreBrainEntry,
  },
  {
    id: 'step-log',
    idPrefix: 'sl',
    defaultEphemeral: false,
    defaultTTL: null,
    defaultStatus: 'active',
    validStatuses: ['active', 'completed', 'failed', 'closed'],
    terminalStatuses: ['completed', 'failed', 'closed'],
    destructionPolicy: 'keep-forever', // non-ephemeral — scanner never visits, field is a no-op
    validate: validateStepLog,
  },
  {
    id: 'inbox-item',
    idPrefix: 'i',
    defaultEphemeral: true,
    // Registry default TTL is 7d (Tier 2 — the "direct" case). Tier 1
    // creators override to '24h' via createChit opts; Tier 3 creators
    // override to '30d'. Per-instance destructionPolicy override (from
    // 0.6 extension) drives tier-varying destroy-vs-cool behavior.
    defaultTTL: '7d',
    defaultStatus: 'active',
    validStatuses: ['active', 'completed', 'rejected', 'closed', 'cold'],
    terminalStatuses: ['completed', 'rejected', 'closed'],
    // Registry default matches Tier 2/3 (the dominant case — founder DMs,
    // @mentions, task handoffs all preserve for audit). Tier 1 ambient
    // creators MUST override to 'destroy-if-not-promoted' via per-instance
    // frontmatter. Validation of that override contract is part of 0.7.4.
    destructionPolicy: 'keep-forever',
    validate: validateInboxItem,
  },
  {
    id: 'blueprint',
    idPrefix: 'b',
    // Non-ephemeral. Blueprints are templates the corp ACCUMULATES over
    // time — the whole point of pattern-capture is that repeating work
    // becomes a durable blueprint. The lifecycle scanner never visits
    // them; destructionPolicy is a no-op.
    defaultEphemeral: false,
    defaultTTL: null,
    // New blueprints land in `draft` so the agent who scaffolded has a
    // chance to fill in steps before cast tries to use them. Promotion
    // to `active` happens via `cc-cli blueprint validate <id>` (next
    // PR) — validate runs the parser, and on success flips the status.
    defaultStatus: 'draft',
    validStatuses: ['draft', 'active', 'closed'],
    // closed = retired / superseded. Not `completed` because a blueprint
    // doesn't complete — it stops being the canonical pattern for
    // something, which is an archival state.
    terminalStatuses: ['closed'],
    destructionPolicy: 'keep-forever', // non-ephemeral — scanner never visits, field is a no-op
    validate: validateBlueprint,
  },
  {
    id: 'escalation',
    idPrefix: 'e',
    // Ephemeral: escalations are in-flight signals, not soul material.
    // Once resolved, the outcome either becomes a new task (follow-up
    // work) or is recorded in the originating chit's audit trail. The
    // escalation chit itself has no long-term value — destroy on TTL
    // age when it never reached terminal status (Partner never saw it
    // / Employee never unblocked). See EscalationFields docstring.
    defaultEphemeral: true,
    // 7d TTL matches Tier 2 inbox — "important but not chain-stalling."
    // Blocker-severity escalations get a Tier 3 inbox companion fire for
    // founder visibility (done at the CLI boundary in cmdEscalate), not
    // here — the chit lifecycle is independent of the notification tier.
    defaultTTL: '7d',
    defaultStatus: 'active',
    validStatuses: ['active', 'completed', 'rejected', 'closed'],
    terminalStatuses: ['completed', 'rejected', 'closed'],
    // Genuine ephemeral: destroy if never promoted. Unlike observations
    // (keep-forever / cool-on-age), an abandoned escalation has no audit
    // value — either the Employee unblocked themselves (closed via
    // chain walker) or the system failed to deliver (which we want to
    // log via the destruction entry, then move on).
    destructionPolicy: 'destroy-if-not-promoted',
    validate: validateEscalation,
  },
  {
    id: 'sweeper-run',
    idPrefix: 'sr',
    // Ephemeral: a sweeper-run records one dispatch of a sweeper, which
    // is a transient event, not soul material. The sweeper itself (the
    // blueprint) is durable; the individual runs are not. Runs that
    // produced a referenced observation (Sexton noticed a pattern,
    // wrote it up, the observation cites the sweeper-run) survive via
    // the 4-signal promotion path; unreferenced runs die at TTL.
    defaultEphemeral: true,
    defaultTTL: '7d',
    defaultStatus: 'active',
    validStatuses: ['active', 'closed', 'burning'],
    // closed = normal completion (sweeper ran, recorded its outcome).
    // burning = aborted (sweeper killed mid-run, daemon shutdown mid-
    // dispatch, etc). Both are terminal — no legal transitions out.
    terminalStatuses: ['closed', 'burning'],
    // Destroy-if-not-promoted: a sweeper-run with no referencing
    // observation after TTL is noise by definition — the sweeper
    // looked at the corp and found nothing worth remembering. Runs
    // that DID produce observations persist because the observation
    // references them, triggering the 4-signal promotion.
    destructionPolicy: 'destroy-if-not-promoted',
    validate: validateSweeperRun,
  },
  {
    id: 'kink',
    idPrefix: 'k',
    // Ephemeral: a kink is operational state ("something is wrong
    // right now") not soul material. Most kinks get fixed, closed,
    // and are irrelevant afterward. Keeping them forever would
    // clog kink queries with history nobody reads.
    defaultEphemeral: true,
    // 7d TTL — aligns with step-log. If a kink was neither closed
    // nor cited by something else in a week, it's forgotten state
    // (either auto-resolved silently, or nobody cared enough to
    // acknowledge it). The scanner burns it.
    defaultTTL: '7d',
    defaultStatus: 'active',
    // Two-state lifecycle: active (open problem) / closed
    // (resolved | acknowledged | dismissed; fields.kink.resolution
    // carries the "why"). burning is the shared terminal for all
    // ephemeral chits abort-killed mid-write, included per
    // convention.
    validStatuses: ['active', 'closed', 'burning'],
    terminalStatuses: ['closed', 'burning'],
    // Destroy-if-not-promoted: unreferenced stale kinks are noise.
    // A kink that was worth remembering will have something (a
    // postmortem observation, Sexton's BRAIN entry about a
    // recurring pattern) referencing it, triggering 4-signal
    // promotion. Absent that, it burns clean.
    destructionPolicy: 'destroy-if-not-promoted',
    validate: validateKink,
  },
  {
    id: 'clearance-submission',
    idPrefix: 'cs',
    // Non-ephemeral. The merge audit trail is durable corp history
    // — every PR's journey through Clearinghouse stays on disk for
    // retrospectives + future CULTURE.md compounding.
    defaultEphemeral: false,
    defaultTTL: null,
    // chit.status is coarser than submissionStatus. Mapping:
    //   queued / processing / conflict → active
    //   merged                          → completed
    //   rejected                        → rejected (founder cancellation)
    //   failed                          → failed (mechanical exhaustion)
    //   (founder-cancel cascade)        → closed
    // The submissionStatus field carries the rich state; chit.status
    // exists for the generic terminal-vs-active gate.
    defaultStatus: 'active',
    validStatuses: ['active', 'completed', 'rejected', 'failed', 'closed', 'burning'],
    terminalStatuses: ['completed', 'rejected', 'failed', 'closed', 'burning'],
    destructionPolicy: 'keep-forever', // non-ephemeral — scanner never visits, field is a no-op
    validate: validateClearanceSubmission,
  },
  {
    id: 'review-comment',
    idPrefix: 'rc',
    // Non-ephemeral. Review feedback compounds into CULTURE.md
    // material over time; "we keep getting flagged for X" is a
    // pattern only durable comments can surface.
    defaultEphemeral: false,
    defaultTTL: null,
    defaultStatus: 'active',
    // active = open comment, closed = addressed or made moot by
    // re-review. burning is the shared abort-mid-write terminal.
    validStatuses: ['active', 'closed', 'burning'],
    terminalStatuses: ['closed', 'burning'],
    destructionPolicy: 'keep-forever',
    validate: validateReviewComment,
  },
  {
    id: 'breaker-trip',
    idPrefix: 'bt',
    // Non-ephemeral. A trip is durable forensic state — surviving
    // for weeks is a feature, not noise. The founder needs to see
    // the loop history; the lifecycle scanner never visits these.
    defaultEphemeral: false,
    defaultTTL: null,
    // Two-state lifecycle: active (refusing spawns for the slug) /
    // closed (founder reset, or auto-cleanup on slot removal).
    // burning is the shared abort-mid-write terminal that all
    // chit types tolerate by convention.
    defaultStatus: 'active',
    validStatuses: ['active', 'closed', 'burning'],
    terminalStatuses: ['closed', 'burning'],
    destructionPolicy: 'keep-forever', // non-ephemeral — scanner never visits, field is a no-op
    validate: validateBreakerTrip,
  },
];

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Look up a registry entry by type id. Returns undefined for unknown ids —
 * callers that need a hard guarantee should use isKnownChitType first.
 */
export function getChitType(id: string): ChitTypeEntry | undefined {
  return CHIT_TYPES.find((t) => t.id === id);
}

/**
 * Type predicate: is `id` a registered chit type? Used at the cc-cli
 * boundary to reject typos before they land in file paths or frontmatter.
 */
export function isKnownChitType(id: string): id is ChitTypeId {
  return CHIT_TYPES.some((t) => t.id === id);
}
