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
  if (f.estimate !== undefined) requireStringOrNull(f.estimate, 'task.estimate');
  if (f.handedBy !== undefined) requireStringOrNull(f.handedBy, 'task.handedBy');
  optionalIsoTimestamp(f.handedAt, 'task.handedAt');
  optionalIsoTimestamp(f.dueAt, 'task.dueAt');
  if (f.loopId !== undefined) requireStringOrNull(f.loopId, 'task.loopId');
  if (f.workflowStatus !== undefined && f.workflowStatus !== null) {
    requireEnum(f.workflowStatus, 'task.workflowStatus', [
      'pending',
      'assigned',
      'in_progress',
      'blocked',
      'completed',
      'failed',
      'cancelled',
    ] as const);
  }
  if (f.projectId !== undefined) requireStringOrNull(f.projectId, 'task.projectId');
  if (f.teamId !== undefined) requireStringOrNull(f.teamId, 'task.teamId');
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
    validate: validateTask,
  },
  {
    id: 'contract',
    idPrefix: 'c',
    defaultEphemeral: false,
    defaultTTL: null,
    defaultStatus: 'draft',
    validStatuses: ['draft', 'active', 'review', 'completed', 'rejected', 'failed', 'closed'],
    terminalStatuses: ['completed', 'rejected', 'failed', 'closed'],
    validate: validateContract,
  },
  {
    id: 'observation',
    idPrefix: 'o',
    defaultEphemeral: true,
    defaultTTL: '7d',
    defaultStatus: 'active',
    validStatuses: ['active', 'closed', 'burning'],
    terminalStatuses: ['closed', 'burning'],
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
    validate: validateStepLog,
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
