/**
 * chits.ts — CRUD operations over the chit substrate.
 *
 * Every chit write goes through atomicWriteSync so the file is never
 * observed in a partial state. Every write bumps updatedAt. Updates
 * check that the on-disk updatedAt matches what the caller read, so
 * concurrent writers don't silently clobber each other (optimistic
 * concurrency — REFACTOR.md Shape of a Chit section).
 *
 * Type safety: functions are generic over ChitTypeId so callers that
 * know the type at compile time get narrow fields. Callers that don't
 * (readChit without narrowing) get Chit<ChitTypeId>, the discriminated
 * union over all registered types.
 *
 * Scope: not stored in frontmatter. Passed to every function as an
 * explicit parameter; the path builder translates scope to file path
 * (corp / agent:<slug> / project:<name> / team:<project>/<team>).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Chit,
  ChitScope,
  ChitStatus,
  ChitTypeId,
  FieldsForType,
} from './types/chit.js';
import { ChitValidationError, getChitType } from './chit-types.js';
import { atomicWriteSync } from './atomic-write.js';
import { parse as parseFrontmatter, stringify as stringifyFrontmatter } from './parsers/frontmatter.js';

// ─── Errors ─────────────────────────────────────────────────────────

/**
 * Thrown when an update's expected updatedAt doesn't match the on-disk
 * value — another writer landed a change in between this caller's read
 * and this caller's write attempt. The caller should re-read and retry.
 */
export class ChitConcurrentModificationError extends Error {
  constructor(
    public readonly path: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`concurrent modification on ${path}: expected updatedAt=${expected}, found=${actual}`);
    this.name = 'ChitConcurrentModificationError';
  }
}

// ─── ID generation ──────────────────────────────────────────────────

/**
 * Generate a chit id of the form `chit-<type-prefix>-<8-hex>`. The
 * prefix is eyeballable so log lines and cross-references self-identify
 * their type (`chit-t-a1b2c3d4` is obviously a task).
 */
export function chitId(type: ChitTypeId): string {
  const entry = getChitType(type);
  if (!entry) throw new ChitValidationError(`unknown chit type: ${type}`, 'type');
  const hex = randomUUID().replace(/-/g, '').slice(0, 8);
  return `chit-${entry.idPrefix}-${hex}`;
}

/**
 * Casket chits have deterministic ids of the form `casket-<agent-slug>`
 * — one per agent, reachable without a query. Agent slugs must be
 * kebab-case to keep filesystem paths clean on Windows (no colons,
 * no spaces, case-insensitive safe).
 */
export function casketChitId(agentSlug: string): string {
  if (!agentSlug || !/^[a-z0-9-]+$/.test(agentSlug)) {
    throw new ChitValidationError(
      `casket id requires a kebab-case agent slug: got ${JSON.stringify(agentSlug)}`,
      'agentSlug',
    );
  }
  return `casket-${agentSlug}`;
}

// ─── Path building ──────────────────────────────────────────────────

function scopeToPath(scope: ChitScope): string {
  if (scope === 'corp') return '';
  if (scope.startsWith('agent:')) {
    const slug = scope.slice('agent:'.length);
    if (!slug) throw new ChitValidationError(`agent scope requires a slug: ${scope}`, 'scope');
    return join('agents', slug);
  }
  if (scope.startsWith('project:')) {
    const name = scope.slice('project:'.length);
    if (!name) throw new ChitValidationError(`project scope requires a name: ${scope}`, 'scope');
    return join('projects', name);
  }
  if (scope.startsWith('team:')) {
    const rest = scope.slice('team:'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) {
      throw new ChitValidationError(
        `team scope must be 'team:<project>/<team>': got ${scope}`,
        'scope',
      );
    }
    return join('projects', rest.slice(0, slash), 'teams', rest.slice(slash + 1));
  }
  throw new ChitValidationError(`unknown scope: ${scope}`, 'scope');
}

/**
 * Build the absolute filesystem path for a chit. The path is
 * `<corpRoot>/<scope-path>/chits/<type>/<id>.md`. scope-path is
 * empty for corp, `agents/<slug>` for agent, `projects/<name>` for
 * project, `projects/<project>/teams/<team>` for team.
 */
export function chitPath(
  corpRoot: string,
  scope: ChitScope,
  type: ChitTypeId,
  id: string,
): string {
  return join(corpRoot, scopeToPath(scope), 'chits', type, `${id}.md`);
}

// ─── TTL computation ────────────────────────────────────────────────

const TTL_PATTERN = /^(\d+)([dhm])$/;

function computeTTL(duration: string | null): string | undefined {
  if (!duration) return undefined;
  const match = TTL_PATTERN.exec(duration);
  if (!match) throw new ChitValidationError(`invalid TTL duration: ${duration}`, 'ttl');
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const ms = amount * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000);
  return new Date(Date.now() + ms).toISOString();
}

// ─── Create ─────────────────────────────────────────────────────────

export interface CreateChitOpts<T extends ChitTypeId> {
  /** Chit type discriminant; determines fields shape and lifecycle. */
  type: T;
  /** Scope determines where the chit lives on disk. */
  scope: ChitScope;
  /** Type-specific payload, validated against chit-types.ts registry. */
  fields: { [K in T]: FieldsForType[K] };
  /** Member id of the creator. Founder implied if caller doesn't pass --from. */
  createdBy: string;
  /** Override auto-generated id. Required for type='casket' (use casketChitId). */
  id?: string;
  /** Override default status. Must be in the type's validStatuses. */
  status?: ChitStatus;
  /** Override registry defaultEphemeral. */
  ephemeral?: boolean;
  /** Override registry defaultTTL. ISO timestamp directly, not a duration string. */
  ttl?: string;
  references?: string[];
  dependsOn?: string[];
  tags?: string[];
  /** Markdown body content. Defaults to empty string. */
  body?: string;
}

/**
 * Create a new chit. Validates the fields payload against the registry's
 * type-specific validator, applies registry defaults for status/
 * ephemeral/ttl, writes atomically to `<scope>/chits/<type>/<id>.md`.
 * Throws ChitValidationError on bad input.
 */
export function createChit<T extends ChitTypeId>(
  corpRoot: string,
  opts: CreateChitOpts<T>,
): Chit<T> {
  const entry = getChitType(opts.type);
  if (!entry) throw new ChitValidationError(`unknown chit type: ${opts.type}`, 'type');

  const fieldsForType = (opts.fields as Record<string, unknown>)[opts.type as string];
  entry.validate(fieldsForType);

  const id = opts.id ?? chitId(opts.type);
  const status = opts.status ?? entry.defaultStatus;
  if (!entry.validStatuses.includes(status)) {
    throw new ChitValidationError(
      `status '${status}' not valid for type '${opts.type}' (valid: ${entry.validStatuses.join(', ')})`,
      'status',
    );
  }

  const ephemeral = opts.ephemeral ?? entry.defaultEphemeral;
  const ttl = opts.ttl ?? (ephemeral ? computeTTL(entry.defaultTTL) : undefined);

  const now = new Date().toISOString();

  const chit = {
    id,
    type: opts.type,
    status,
    ephemeral,
    ttl,
    createdBy: opts.createdBy,
    createdAt: now,
    updatedAt: now,
    references: opts.references ?? [],
    dependsOn: opts.dependsOn ?? [],
    tags: opts.tags ?? [],
    fields: opts.fields,
  } as Chit<T>;

  const path = chitPath(corpRoot, opts.scope, opts.type, id);
  const body = opts.body ?? '';
  const content = stringifyFrontmatter(chit as unknown as Record<string, unknown>, body);
  atomicWriteSync(path, content);

  return chit;
}

// ─── Read ───────────────────────────────────────────────────────────

export interface ChitWithBody<T extends ChitTypeId = ChitTypeId> {
  chit: Chit<T>;
  body: string;
  path: string;
}

/**
 * Read a chit by scope+type+id. Returns frontmatter + body + resolved
 * path so callers can pass `path` back to update functions without
 * re-computing. Throws if the chit doesn't exist.
 */
export function readChit<T extends ChitTypeId = ChitTypeId>(
  corpRoot: string,
  scope: ChitScope,
  type: T,
  id: string,
): ChitWithBody<T> {
  const path = chitPath(corpRoot, scope, type, id);
  if (!existsSync(path)) {
    throw new Error(`chit not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const { meta, body } = parseFrontmatter<Chit<T>>(raw);
  return { chit: meta, body, path };
}

// ─── Update ─────────────────────────────────────────────────────────

export interface UpdateChitOpts<T extends ChitTypeId> {
  /** Transition to a new status. Must be in the type's validStatuses. */
  status?: ChitStatus;
  /** Partial fields merge. Merged result is re-validated against the type's validator. */
  fields?: Partial<{ [K in T]: FieldsForType[K] }>;
  references?: string[];
  dependsOn?: string[];
  tags?: string[];
  /** Member id of the writer; populated into the chit's updatedBy audit field. */
  updatedBy: string;
  /** Replace the markdown body. Undefined preserves the existing body. */
  body?: string;
  /** Optimistic concurrency: expected updatedAt. If provided and on-disk value differs, throws ChitConcurrentModificationError. */
  expectedUpdatedAt?: string;
}

/**
 * Update a chit. Applies the merge, re-validates if fields changed,
 * bumps updatedAt, sets updatedBy, writes atomically. Optimistic
 * concurrency: pass `expectedUpdatedAt` from the chit you read earlier;
 * mismatch throws ChitConcurrentModificationError and caller should
 * re-read + retry.
 */
export function updateChit<T extends ChitTypeId>(
  corpRoot: string,
  scope: ChitScope,
  type: T,
  id: string,
  updates: UpdateChitOpts<T>,
): Chit<T> {
  const entry = getChitType(type);
  if (!entry) throw new ChitValidationError(`unknown chit type: ${type}`, 'type');

  const { chit: current, body: currentBody, path } = readChit(corpRoot, scope, type, id);

  if (updates.expectedUpdatedAt !== undefined && current.updatedAt !== updates.expectedUpdatedAt) {
    throw new ChitConcurrentModificationError(path, updates.expectedUpdatedAt, current.updatedAt);
  }

  if (updates.status !== undefined && !entry.validStatuses.includes(updates.status)) {
    throw new ChitValidationError(
      `status '${updates.status}' not valid for type '${type}' (valid: ${entry.validStatuses.join(', ')})`,
      'status',
    );
  }

  let newFields = current.fields;
  if (updates.fields) {
    newFields = { ...current.fields, ...updates.fields } as typeof current.fields;
    const fieldsForType = (newFields as Record<string, unknown>)[type as string];
    entry.validate(fieldsForType);
  }

  const updated = {
    ...current,
    status: updates.status ?? current.status,
    fields: newFields,
    references: updates.references ?? current.references,
    dependsOn: updates.dependsOn ?? current.dependsOn,
    tags: updates.tags ?? current.tags,
    updatedBy: updates.updatedBy,
    updatedAt: new Date().toISOString(),
  } as Chit<T>;

  const body = updates.body ?? currentBody;
  const content = stringifyFrontmatter(updated as unknown as Record<string, unknown>, body);
  atomicWriteSync(path, content);

  return updated;
}

// ─── Close ──────────────────────────────────────────────────────────

/**
 * Transition a chit to a terminal status. Thin wrapper over updateChit
 * that enforces status ∈ terminalStatuses. Non-ephemeral chits stay on
 * disk after closing (git history + future pattern detection). Ephemeral
 * chits in closed/burning states get cleaned up by the lifecycle
 * scanner (Project 0.6).
 */
export function closeChit<T extends ChitTypeId>(
  corpRoot: string,
  scope: ChitScope,
  type: T,
  id: string,
  status: ChitStatus,
  updatedBy: string,
): Chit<T> {
  const entry = getChitType(type);
  if (!entry) throw new ChitValidationError(`unknown chit type: ${type}`, 'type');

  if (!entry.terminalStatuses.includes(status)) {
    const terminalList = entry.terminalStatuses.length > 0 ? entry.terminalStatuses.join(', ') : 'none';
    throw new ChitValidationError(
      `status '${status}' is not terminal for type '${type}' (terminal: ${terminalList})`,
      'status',
    );
  }

  return updateChit(corpRoot, scope, type, id, { status, updatedBy });
}
