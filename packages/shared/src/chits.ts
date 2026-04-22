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

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Chit,
  ChitScope,
  ChitStatus,
  ChitTypeId,
  FieldsForType,
} from './types/chit.js';
import { CHIT_TYPES, ChitValidationError, getChitType } from './chit-types.js';
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

/**
 * Thrown when a chit file exists but cannot be parsed as a valid chit
 * — bad YAML frontmatter, missing required fields, or corrupted
 * content. Distinct from "not found" so callers can distinguish
 * absence from corruption. readChit and findChitById throw this;
 * queryChits collects malformed files into its result without throwing.
 */
export class ChitMalformedError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause: string,
  ) {
    super(`malformed chit at ${path}: ${cause}`);
    this.name = 'ChitMalformedError';
  }
}

/** A single malformed-chit observation returned alongside queryChits results. */
export interface MalformedChit {
  path: string;
  error: string;
  timestamp: string;
}

/**
 * Append a malformed-chit entry to the corp's audit log. Best-effort —
 * log write failures don't propagate, because the malformed detection
 * itself is already surfaced via the return value of the calling function.
 * The log gives persistence across sessions for diagnostic queries.
 */
function logMalformed(corpRoot: string, entry: MalformedChit): void {
  const logPath = join(corpRoot, 'chits', '_log', 'malformed.jsonl');
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // best-effort; the primary surfacing path is the return value
  }
}

function parseChitFile(path: string): { chit: Chit; body: string } {
  const raw = readFileSync(path, 'utf-8');
  try {
    const parsed = parseFrontmatter<Chit>(raw);
    // Minimal validity check — a parseable-but-empty frontmatter would
    // leave meta as an empty object and silently pass later filters.
    if (!parsed.meta || typeof parsed.meta !== 'object' || !parsed.meta.id || !parsed.meta.type) {
      throw new Error('missing required chit frontmatter (id, type)');
    }
    return { chit: parsed.meta, body: parsed.body };
  } catch (err) {
    throw new ChitMalformedError(path, (err as Error).message);
  }
}

// ─── ID generation + validation ─────────────────────────────────────

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

// Reserved prefixes (chit-, casket-) can't also match the word-pair alt —
// the negative lookahead keeps those namespaces clean so `chit-x` and
// `casket-y` don't sneak through as "legacy word-pair ids" when they're
// actually malformed modern ids.
const CHIT_ID_PATTERN = /^(chit-[a-z-]+-[0-9a-f]+|casket-[a-z0-9-]+|(?!chit-|casket-)[a-z]+-[a-z]+)$/;

/**
 * Returns true for any string matching a recognized chit id format:
 * - `chit-<prefix>-<hex>` — modern chit-native id shape
 * - `casket-<slug>` — deterministic per-agent casket ids
 * - `<word>-<word>` — legacy word-pair format used by pre-chits
 *   taskId()/contractId() generators. Preserved so 0.3 task migration
 *   can land without rewriting every task reference across the corp;
 *   contracts still reference task ids like "brave-panther" until
 *   they migrate in 0.4.
 *
 * Used to validate references and dependsOn at the CRUD boundary so
 * typo'd ids (uppercase, single word, underscores) fail fast instead
 * of becoming orphaned dangling pointers.
 */
export function isChitIdFormat(id: string): boolean {
  return typeof id === 'string' && CHIT_ID_PATTERN.test(id);
}

function validateChitLinks(field: 'references' | 'dependsOn', ids: readonly string[] | undefined): void {
  if (!ids) return;
  for (const id of ids) {
    if (!isChitIdFormat(id)) {
      throw new ChitValidationError(
        `${field} contains invalid chit id: ${JSON.stringify(id)}`,
        field,
      );
    }
  }
}

/**
 * Verify the chit at `path` still has the expected updatedAt — if it
 * advanced, a concurrent writer has landed and the caller must abort
 * and retry. Extracted as an exported helper so multi-step operations
 * (e.g., cc-cli pipelines reading many chits, computing updates, then
 * writing a batch) can re-verify each target before their writes. Also
 * what updateChit uses for its pre-rename safety net.
 *
 * Throws ChitConcurrentModificationError on mismatch; silent on match.
 */
export function checkConcurrentModification(path: string, expectedUpdatedAt: string): void {
  const raw = readFileSync(path, 'utf-8');
  const { meta } = parseFrontmatter<Chit>(raw);
  if (meta.updatedAt !== expectedUpdatedAt) {
    throw new ChitConcurrentModificationError(path, expectedUpdatedAt, meta.updatedAt);
  }
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

/**
 * Inverse of chitPath: given a chit's absolute filesystem path and the
 * corpRoot it lives under, derive the ChitScope value. Useful for any
 * code that gets a path from findChitById or queryChits and needs to
 * call back into CRUD functions that take scope explicitly (update,
 * close, promote, archive).
 *
 * Handles cross-platform path separators (Windows `\`, Unix `/`).
 * Throws if the path doesn't match the expected chit layout.
 */
export function chitScopeFromPath(corpRoot: string, path: string): ChitScope {
  // Normalize separators so the parsing is platform-neutral.
  const normalize = (p: string): string => p.replace(/\\/g, '/');
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(corpRoot);

  if (!normalizedPath.startsWith(normalizedRoot)) {
    throw new Error(`path is not under corpRoot: ${path}`);
  }
  let rel = normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, '');

  // Strip the trailing `chits/<type>/<id>.md` — we only care about the
  // scope-path prefix before that.
  const chitsIdx = rel.indexOf('/chits/');
  if (chitsIdx === -1) {
    // Might be corp-scope (chits/ is the first segment)
    if (rel.startsWith('chits/')) return 'corp';
    throw new Error(`no chits/ segment found in path: ${path}`);
  }
  const scopePath = rel.slice(0, chitsIdx);

  if (!scopePath) return 'corp';

  // agents/<slug>
  if (scopePath.startsWith('agents/')) {
    const slug = scopePath.slice('agents/'.length);
    if (!slug || slug.includes('/')) throw new Error(`malformed agent scope: ${scopePath}`);
    return `agent:${slug}`;
  }

  // projects/<name>/teams/<team>
  const teamsMatch = /^projects\/([^/]+)\/teams\/([^/]+)$/.exec(scopePath);
  if (teamsMatch) return `team:${teamsMatch[1]}/${teamsMatch[2]}`;

  // projects/<name>
  if (scopePath.startsWith('projects/')) {
    const name = scopePath.slice('projects/'.length);
    if (!name || name.includes('/')) throw new Error(`malformed project scope: ${scopePath}`);
    return `project:${name}`;
  }

  throw new Error(`cannot derive scope from path: ${path}`);
}

// ─── TTL computation ────────────────────────────────────────────────

const TTL_PATTERN = /^(\d+)([dhm])$/;

export function computeTTL(duration: string | null): string | undefined {
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
  /**
   * Per-instance override of the type's registry destructionPolicy.
   * Load-bearing for inbox-item chits (Tier 1 sets
   * 'destroy-if-not-promoted'; Tier 2/3 inherit the registry default).
   * Undefined = inherit registry default — the common case.
   */
  destructionPolicy?: 'destroy-if-not-promoted' | 'keep-forever';
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

  validateChitLinks('references', opts.references);
  validateChitLinks('dependsOn', opts.dependsOn);

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
    // Only emit destructionPolicy when the caller explicitly set an
    // override — inheriting the registry default is expressed by
    // ABSENCE of the field, not presence of a redundant value. Keeps
    // the frontmatter noise-free for the vast majority of chits
    // (tasks, contracts, caskets) whose policy is a no-op anyway.
    ...(opts.destructionPolicy ? { destructionPolicy: opts.destructionPolicy } : {}),
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
 * re-computing. Throws Error if not found, ChitMalformedError if the
 * file exists but can't be parsed as a chit (logs the malformed event
 * to the audit trail).
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
  try {
    const { chit, body } = parseChitFile(path);
    return { chit: chit as Chit<T>, body, path };
  } catch (err) {
    if (err instanceof ChitMalformedError) {
      logMalformed(corpRoot, {
        path: err.path,
        error: err.cause,
        timestamp: new Date().toISOString(),
      });
    }
    throw err;
  }
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

  // Optimistic concurrency — caller-supplied expected version
  if (updates.expectedUpdatedAt !== undefined && current.updatedAt !== updates.expectedUpdatedAt) {
    throw new ChitConcurrentModificationError(path, updates.expectedUpdatedAt, current.updatedAt);
  }

  // Status validity: must be in the type's validStatuses set
  if (updates.status !== undefined && !entry.validStatuses.includes(updates.status)) {
    throw new ChitValidationError(
      `status '${updates.status}' not valid for type '${type}' (valid: ${entry.validStatuses.join(', ')})`,
      'status',
    );
  }

  // Terminal lock: once a chit is in a terminal status, status can't change.
  // The legitimate path to terminal is closeChit. Re-opening from terminal
  // requires an explicit future mechanism (not v1).
  if (
    updates.status !== undefined &&
    updates.status !== current.status &&
    entry.terminalStatuses.includes(current.status)
  ) {
    throw new ChitValidationError(
      `chit is in terminal status '${current.status}' and cannot transition to '${updates.status}' (re-opening requires explicit mechanism)`,
      'status',
    );
  }

  let newFields = current.fields;
  if (updates.fields) {
    // Deep merge at the fields.<type> level so updating one sub-field
    // (e.g. fields.task.priority) doesn't wipe the other sub-fields
    // (title, assignee). Shallow spread at the top level would replace
    // fields.task wholesale, which surprises every caller that expects
    // partial-at-value semantics from the word "update."
    const typeKey = type as string;
    const currentTypeFields =
      ((current.fields as Record<string, unknown>)[typeKey] as Record<string, unknown>) ?? {};
    const updateTypeFields =
      ((updates.fields as Record<string, unknown>)[typeKey] as Record<string, unknown>) ?? {};
    newFields = {
      ...current.fields,
      [typeKey]: { ...currentTypeFields, ...updateTypeFields },
    } as typeof current.fields;
    const fieldsForType = (newFields as Record<string, unknown>)[type as string];
    entry.validate(fieldsForType);
  }

  validateChitLinks('references', updates.references);
  validateChitLinks('dependsOn', updates.dependsOn);

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

  // Pre-rename recheck: between our initial read and this point, another
  // writer could have landed. If the on-disk updatedAt advanced past what
  // we started with, abort. Narrows the concurrency race window to the
  // few milliseconds between this check and the rename — a true race-free
  // guarantee would need OS-level file locking, out of scope for v1 and
  // cross-platform complex. This is REFACTOR.md Shape-of-a-Chit step 5.
  checkConcurrentModification(path, current.updatedAt);

  const body = updates.body ?? currentBody;
  const content = stringifyFrontmatter(updated as unknown as Record<string, unknown>, body);
  atomicWriteSync(path, content);

  return updated;
}

// ─── Close ──────────────────────────────────────────────────────────

/**
 * Promote an ephemeral chit to permanent. Flips ephemeral=true → false,
 * clears ttl, bumps updatedAt, adds a provenance marker to tags
 * (`promoted:<reason-slug>` so the promotion reason is queryable).
 *
 * Only valid on ephemeral chits — promoting a permanent chit is a
 * caller error (nothing to promote) and throws ChitValidationError.
 *
 * This is the manual promotion path (founder or agent calling via
 * cc-cli). The 4-signal automatic promotion (Project 0.6 lifecycle
 * scanner) also uses this function when a signal fires.
 */
export function promoteChit<T extends ChitTypeId>(
  corpRoot: string,
  scope: ChitScope,
  type: T,
  id: string,
  opts: { reason: string; updatedBy: string },
): Chit<T> {
  const { chit: current, path } = readChit(corpRoot, scope, type, id);

  if (!current.ephemeral) {
    throw new ChitValidationError(
      `chit ${id} is already permanent — nothing to promote`,
      'ephemeral',
    );
  }

  // Provenance: add `promoted:<reason-slug>` tag so the promotion is queryable.
  const reasonSlug = opts.reason
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const promotionTag = `promoted:${reasonSlug || 'no-reason'}`;
  const newTags = current.tags.includes(promotionTag)
    ? current.tags
    : [...current.tags, promotionTag];

  // Manual flip bypasses the type validator (we're modifying common fields
  // only, not fields.<type>), but we write through atomic + pre-rename check.
  checkConcurrentModification(path, current.updatedAt);

  const updated = {
    ...current,
    ephemeral: false,
    ttl: undefined,
    tags: newTags,
    updatedBy: opts.updatedBy,
    updatedAt: new Date().toISOString(),
  } as Chit<T>;

  const { body: currentBody } = readChit(corpRoot, scope, type, id);
  const content = stringifyFrontmatter(updated as unknown as Record<string, unknown>, currentBody);
  atomicWriteSync(path, content);

  return updated;
}

/**
 * Move a closed/terminal chit to `<scope>/chits/_archive/<type>/<id>.md`.
 * Archiving keeps the corp's working-set queries fast by removing
 * rarely-read history from the default scan, while preserving the
 * record for audit (queries with includeArchive=true still find it).
 *
 * Archive validates the chit is in a terminal status — archiving
 * active work would obscure real in-progress records. Callers should
 * closeChit first, then archiveChit.
 *
 * The move is two-step: read current content, atomicWriteSync at the
 * archive path, rmSync the source. Not transactional across the two
 * writes, but the archive path is always the canonical record after
 * the call succeeds (original is removed last).
 */
export function archiveChit<T extends ChitTypeId>(
  corpRoot: string,
  scope: ChitScope,
  type: T,
  id: string,
): { sourcePath: string; archivePath: string } {
  const entry = getChitType(type);
  if (!entry) throw new ChitValidationError(`unknown chit type: ${type}`, 'type');

  const sourcePath = chitPath(corpRoot, scope, type, id);
  if (!existsSync(sourcePath)) {
    throw new Error(`chit not found: ${sourcePath}`);
  }

  const { chit: current } = readChit(corpRoot, scope, type, id);
  if (!entry.terminalStatuses.includes(current.status)) {
    throw new ChitValidationError(
      `chit ${id} is in non-terminal status '${current.status}' — call closeChit first`,
      'status',
    );
  }

  // Archive path mirrors the source path with _archive inserted as a
  // sibling of the type directory (<scope>/chits/_archive/<type>/<id>.md).
  const archivePath = join(
    corpRoot,
    scopeToPath(scope),
    'chits',
    '_archive',
    type,
    `${id}.md`,
  );

  // Read the source once, write to archive location atomically, then
  // remove the source. Order matters: if the archive-write fails, the
  // source is untouched; if the source-remove fails, the archive copy
  // is already the canonical record.
  const raw = readFileSync(sourcePath, 'utf-8');
  atomicWriteSync(archivePath, raw);
  rmSync(sourcePath);

  return { sourcePath, archivePath };
}

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

// ─── Query ──────────────────────────────────────────────────────────

export interface QueryChitsOpts {
  /** Match ANY of these types. Omit to accept all types. */
  types?: readonly ChitTypeId[];
  /** Match ANY of these statuses. Omit to accept all statuses. */
  statuses?: readonly ChitStatus[];
  /** Match ANY of these tags. Omit to not filter on tags. */
  tags?: readonly string[];
  /** Match ANY of these scopes. Omit to walk every discoverable scope. */
  scopes?: readonly ChitScope[];
  /** Match chits whose createdBy equals this. */
  createdBy?: string;
  /** Chits with updatedAt >= this ISO timestamp. */
  updatedSince?: string;
  /** Chits with updatedAt <= this ISO timestamp. */
  updatedUntil?: string;
  /** Match chits that reference ANY of these ids. */
  references?: readonly string[];
  /** Match chits that depend_on ANY of these ids. */
  dependsOn?: readonly string[];
  /** true = only ephemeral; false = only non-ephemeral; undefined = both. */
  ephemeral?: boolean;
  /**
   * Include chits with `status: 'cold'` in the results. Default false:
   * cold chits are filtered out of the standard query surface so active-
   * work views (`cc-cli chit list`, dashboard panels, agent task queues)
   * aren't flooded with historical observations that aged out.
   *
   * Pass `true` for archival/audit queries (founder asking "what did the
   * CEO notice last month?"), and for the dream distillation pass which
   * intentionally reads cold observations so compression still works on
   * historical soul material.
   *
   * Listing `'cold'` explicitly in `statuses` also opts the caller in,
   * regardless of this flag — explicit intent beats the default.
   */
  includeCold?: boolean;
  /** Include <scope>/chits/_archive/<type>/ subtrees. Default false. */
  includeArchive?: boolean;
  /** Sort field. Default 'updatedAt'. */
  sortBy?: 'updatedAt' | 'createdAt' | 'id';
  /** Sort direction. Default 'desc'. */
  sortOrder?: 'asc' | 'desc';
  /** Max results. Default 50; pass 0 for unlimited. */
  limit?: number;
  /** Pagination offset into the sorted result set. Default 0. */
  offset?: number;
}

interface ScopeBase {
  scope: ChitScope;
  basePath: string;
}

/**
 * Discover scopes to visit for a query. When scopeFilter is provided,
 * translate each scope value to its filesystem path. When absent,
 * enumerate the corp's scope tree by walking agents/, projects/, and
 * projects/<p>/teams/ subtrees.
 */
function resolveScopesToVisit(
  corpRoot: string,
  scopeFilter: readonly ChitScope[] | undefined,
): ScopeBase[] {
  if (scopeFilter && scopeFilter.length > 0) {
    return scopeFilter.map((scope) => ({
      scope,
      basePath: join(corpRoot, scopeToPath(scope)),
    }));
  }

  const all: ScopeBase[] = [{ scope: 'corp', basePath: corpRoot }];

  const agentsDir = join(corpRoot, 'agents');
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        all.push({
          scope: `agent:${entry.name}`,
          basePath: join(agentsDir, entry.name),
        });
      }
    }
  }

  const projectsDir = join(corpRoot, 'projects');
  if (existsSync(projectsDir)) {
    for (const pEntry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!pEntry.isDirectory()) continue;
      const projectName = pEntry.name;
      const projectBase = join(projectsDir, projectName);
      all.push({
        scope: `project:${projectName}`,
        basePath: projectBase,
      });
      const teamsDir = join(projectBase, 'teams');
      if (existsSync(teamsDir)) {
        for (const tEntry of readdirSync(teamsDir, { withFileTypes: true })) {
          if (tEntry.isDirectory()) {
            all.push({
              scope: `team:${projectName}/${tEntry.name}`,
              basePath: join(teamsDir, tEntry.name),
            });
          }
        }
      }
    }
  }

  return all;
}

/**
 * Collect candidate chit file paths for the given scopes and type filter.
 * Archive subtrees are skipped unless includeArchive is true.
 */
function findChitFiles(
  scopesToVisit: ScopeBase[],
  typeFilter: readonly ChitTypeId[] | undefined,
  includeArchive: boolean,
): string[] {
  const paths: string[] = [];

  for (const { basePath } of scopesToVisit) {
    const chitsRoot = join(basePath, 'chits');
    if (!existsSync(chitsRoot)) continue;

    const typeSubdirs = typeFilter
      ? (typeFilter as readonly string[])
      : readdirSync(chitsRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== '_archive' && e.name !== '_log')
          .map((e) => e.name);

    for (const typeName of typeSubdirs) {
      const typeDir = join(chitsRoot, typeName);
      if (existsSync(typeDir)) {
        for (const file of readdirSync(typeDir)) {
          if (file.endsWith('.md')) paths.push(join(typeDir, file));
        }
      }

      if (includeArchive) {
        const archiveDir = join(chitsRoot, '_archive', typeName);
        if (existsSync(archiveDir)) {
          for (const file of readdirSync(archiveDir)) {
            if (file.endsWith('.md')) paths.push(join(archiveDir, file));
          }
        }
      }
    }
  }

  return paths;
}

/**
 * Apply non-type filters to a chit. Type filtering happens at the
 * directory walk to avoid reading files we won't keep.
 */
function matchesFilter(chit: Chit, opts: QueryChitsOpts): boolean {
  if (opts.statuses && opts.statuses.length > 0 && !opts.statuses.includes(chit.status)) {
    return false;
  }
  // Cold default-filter: exclude chits with status:'cold' unless the caller
  // either passed includeCold:true OR explicitly named 'cold' in statuses.
  // Keeps active-work queries clean without destroying historical material.
  if (
    chit.status === 'cold' &&
    opts.includeCold !== true &&
    !(opts.statuses && opts.statuses.includes('cold'))
  ) {
    return false;
  }
  if (opts.tags && opts.tags.length > 0 && !opts.tags.some((t) => chit.tags.includes(t))) {
    return false;
  }
  if (opts.createdBy !== undefined && chit.createdBy !== opts.createdBy) {
    return false;
  }
  if (opts.updatedSince !== undefined && chit.updatedAt < opts.updatedSince) {
    return false;
  }
  if (opts.updatedUntil !== undefined && chit.updatedAt > opts.updatedUntil) {
    return false;
  }
  if (
    opts.references &&
    opts.references.length > 0 &&
    !opts.references.some((r) => chit.references.includes(r))
  ) {
    return false;
  }
  if (
    opts.dependsOn &&
    opts.dependsOn.length > 0 &&
    !opts.dependsOn.some((d) => chit.dependsOn.includes(d))
  ) {
    return false;
  }
  if (opts.ephemeral !== undefined && chit.ephemeral !== opts.ephemeral) {
    return false;
  }
  return true;
}

/** Result of a queryChits call — matches plus any malformed files encountered during the walk. */
export interface QueryChitsResult {
  chits: ChitWithBody[];
  malformed: MalformedChit[];
}

/**
 * Query chits across scopes with filter composition.
 *
 * Multi-value filters (types, statuses, tags, scopes, references,
 * dependsOn) are OR within the filter and AND across different filters.
 * Example: `{ types: ['task'], statuses: ['active', 'draft'] }` means
 * "task AND (active OR draft)".
 *
 * Sort defaults to updatedAt desc; limit defaults to 50 (0 = unlimited).
 *
 * Malformed chit files (bad YAML, missing required frontmatter, corrupted
 * content) are NOT silently skipped — they're collected into the result's
 * `malformed` field and appended to the corp's audit log at
 * `<corpRoot>/chits/_log/malformed.jsonl`. Callers that don't care about
 * malformed can ignore `result.malformed`; callers that do (TUI health
 * views, daemon monitors, admin commands) surface them directly.
 */
export function queryChits(corpRoot: string, opts: QueryChitsOpts = {}): QueryChitsResult {
  const scopesToVisit = resolveScopesToVisit(corpRoot, opts.scopes);
  const paths = findChitFiles(scopesToVisit, opts.types, opts.includeArchive ?? false);

  const matches: ChitWithBody[] = [];
  const malformed: MalformedChit[] = [];

  for (const path of paths) {
    let chit: Chit;
    let body: string;
    try {
      const parsed = parseChitFile(path);
      chit = parsed.chit;
      body = parsed.body;
    } catch (err) {
      const entry: MalformedChit = {
        path,
        error: (err as Error).message,
        timestamp: new Date().toISOString(),
      };
      malformed.push(entry);
      logMalformed(corpRoot, entry);
      continue;
    }

    if (!matchesFilter(chit, opts)) continue;
    matches.push({ chit, body, path });
  }

  // Sort
  const sortBy = opts.sortBy ?? 'updatedAt';
  const sortOrder = opts.sortOrder ?? 'desc';
  matches.sort((a, b) => {
    const av = (a.chit as unknown as Record<string, string>)[sortBy] ?? '';
    const bv = (b.chit as unknown as Record<string, string>)[sortBy] ?? '';
    if (av < bv) return sortOrder === 'asc' ? -1 : 1;
    if (av > bv) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  // Paginate
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 50;
  const paginated = limit === 0 ? matches.slice(offset) : matches.slice(offset, offset + limit);

  return { chits: paginated, malformed };
}

// ─── Lookup by id ───────────────────────────────────────────────────

/**
 * Parse the chit type from an id's prefix. Chit ids follow the
 * `chit-<prefix>-<hex>` pattern; caskets follow `casket-<slug>`.
 * Returns null for unrecognizable ids.
 */
function parseChitIdType(id: string): ChitTypeId | null {
  if (id.startsWith('casket-')) return 'casket';
  const match = /^chit-([a-z-]+)-[0-9a-f]+$/.exec(id);
  if (!match) return null;
  const prefix = match[1];
  const entry = CHIT_TYPES.find((t) => t.idPrefix === prefix);
  return entry?.id ?? null;
}

/**
 * Find a chit by id without caller-supplied scope.
 *
 * Fast path: when the id encodes its type (chit-<prefix>-<hex>,
 * casket-<slug>), parse the prefix and check the predicted path
 * <scope>/chits/<type>/<id>.md across every scope — O(scopes) lookups,
 * no directory enumeration of type contents.
 *
 * Fallback: when the id is a legacy word-pair shape or otherwise
 * doesn't encode its type in the prefix, scan every registered type
 * subdir per scope — O(scopes × types) lookups. Necessary while
 * pre-chits-format ids (taskId/contractId word-pairs) still circulate
 * in the corp during the 0.3/0.4 migration window.
 *
 * Returns null when the id doesn't match any file. Throws
 * ChitMalformedError (and logs to the audit trail) when a file is
 * found but can't be parsed — distinct outcome from not-found.
 */
export function findChitById(corpRoot: string, id: string): ChitWithBody | null {
  const typeFromId = parseChitIdType(id);
  const scopesToVisit = resolveScopesToVisit(corpRoot, undefined);

  // Fast path — id encodes type
  if (typeFromId) {
    for (const { basePath } of scopesToVisit) {
      const path = join(basePath, 'chits', typeFromId, `${id}.md`);
      if (existsSync(path)) return readOrThrowMalformed(corpRoot, path);
    }
    return null;
  }

  // Fallback — scan all registered type subdirs per scope
  for (const { basePath } of scopesToVisit) {
    for (const typeEntry of CHIT_TYPES) {
      const path = join(basePath, 'chits', typeEntry.id, `${id}.md`);
      if (existsSync(path)) return readOrThrowMalformed(corpRoot, path);
    }
  }
  return null;
}

function readOrThrowMalformed(corpRoot: string, path: string): ChitWithBody {
  try {
    const { chit, body } = parseChitFile(path);
    return { chit, body, path };
  } catch (err) {
    if (err instanceof ChitMalformedError) {
      logMalformed(corpRoot, {
        path: err.path,
        error: err.cause,
        timestamp: new Date().toISOString(),
      });
    }
    throw err;
  }
}
