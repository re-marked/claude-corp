/**
 * cc-cli whoami — "who am I" introspection + self-naming.
 *
 * Two modes:
 *
 *   Read (default):  `cc-cli whoami --agent <slug>`
 *     Resolves a member by id, reads their casket, formats the result.
 *     Useful for fresh sessions post-Dredge handoff, post-compaction
 *     recovery, post-spawn bacteria slots that haven't named themselves
 *     yet, or any moment when an agent's identity feels uncertain.
 *
 *   Rename:          `cc-cli whoami rename <name> --agent <slug>`
 *     One-shot self-naming for bacteria-spawned Employees. Validates
 *     the slot is bacteria-eligible (kind=employee, displayName === id),
 *     name shape, role-scoped uniqueness; writes new displayName to
 *     members.json; emits a "naming" observation chit (NOTICE category,
 *     subject=slug) that pairs with apoptosis's obituary chit at the
 *     other bracket of the slot's life.
 *
 * Slims `cc-cli wtf`. wtf was overloaded — handoff context + recent
 * activity + what to do next + identity. Pulling identity into its
 * own command leaves wtf as "what's happening, what should I do next."
 *
 * Projects 1.10.2 + 1.10.3.
 */

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import {
  createChit,
  findChitById,
  getCurrentStep,
  getRole,
  readConfig,
  writeConfig,
  MEMBERS_JSON,
  type Member,
  type TaskFields,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../client.js';

export interface WhoamiOpts {
  agent?: string;
  corp?: string;
  json?: boolean;
  /** When set, switch from read-mode to rename-mode and claim this name. */
  rename?: string;
}

export interface WhoamiResult {
  ok: true;
  slug: string;
  displayName: string;
  /** False when displayName === slug (bacteria-spawned, naming pending). */
  displayNameChosen: boolean;
  type: 'user' | 'agent';
  /** 'employee' | 'partner' for agents; null for users. */
  kind: 'employee' | 'partner' | null;
  /** Registered role id or null when missing. */
  role: string | null;
  /** Human-readable role label from the registry, or null. */
  roleDisplayName: string | null;
  /** Bacteria lineage — null for Partners + founder-hires + pre-1.10 slots. */
  generation: number | null;
  parentSlot: string | null;
  /** Current casket step. null when idle, undefined for non-agents / no casket. */
  casket: {
    currentStep: string | null;
    /** Resolved task title when currentStep references a task chit. */
    title: string | null;
  } | null;
}

export async function cmdWhoami(rawArgs: string[]): Promise<void>;
export async function cmdWhoami(opts: WhoamiOpts): Promise<void>;
export async function cmdWhoami(input: string[] | WhoamiOpts): Promise<void> {
  const opts = Array.isArray(input) ? parseOpts(input) : input;

  if (!opts.agent) {
    process.stderr.write(
      'error: --agent <slug> required\n' +
        'usage: cc-cli whoami --agent <slug> [--corp <corp>] [--json]\n',
    );
    process.exit(1);
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const members = getMembers(corpRoot);
  const member = members.find((m) => m.id === opts.agent);

  if (!member) {
    process.stderr.write(`error: member "${opts.agent}" not found in this corp\n`);
    process.exit(1);
  }

  // Branch on rename vs read. handleRename does its own validation +
  // output and never falls through to the read formatter.
  if (opts.rename !== undefined) {
    handleRename(corpRoot, member, opts.rename, !!opts.json);
    return;
  }

  const result = buildWhoamiResult(corpRoot, member);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatHuman(result));
}

// ─── Pure result builder (testable) ─────────────────────────────────

export function buildWhoamiResult(corpRoot: string, member: Member): WhoamiResult {
  const role = member.role ? getRole(member.role) : undefined;
  const isAgent = member.type === 'agent';

  // Casket lookup is agent-only. Resolve currentStep + title if it's
  // a task chit. Errors degrade to null — corrupted casket OR a
  // currentStep pointing at a malformed chit (findChitById throws
  // ChitMalformedError) shouldn't block whoami. A diagnostic command
  // failing exactly when the corp is in a corrupted state is worse
  // than null title.
  let casket: WhoamiResult['casket'] = null;
  if (isAgent) {
    const currentStep = readCurrentStepSafe(corpRoot, member.id);
    let title: string | null = null;
    if (currentStep) {
      try {
        const hit = findChitById(corpRoot, currentStep);
        if (hit && hit.chit.type === 'task') {
          title = (hit.chit.fields.task as TaskFields).title ?? null;
        }
      } catch {
        // Malformed task chit. queryChits / chit-hygiene sweeper will
        // log + surface separately; here we just degrade gracefully.
      }
    }
    casket = { currentStep: currentStep ?? null, title };
  }

  return {
    ok: true,
    slug: member.id,
    displayName: member.displayName,
    displayNameChosen: member.displayName !== member.id,
    type: member.type,
    kind: isAgent ? (member.kind ?? 'partner') : null,
    role: member.role ?? null,
    roleDisplayName: role?.displayName ?? null,
    generation: member.generation ?? null,
    parentSlot: member.parentSlot ?? null,
    casket,
  };
}

// ─── Pure formatter (testable) ──────────────────────────────────────

export function formatHuman(r: WhoamiResult): string {
  const lines: string[] = [];

  lines.push(`slug:        ${r.slug}`);
  lines.push(
    `displayName: ${r.displayNameChosen ? r.displayName : '<not yet chosen — pending self-naming>'}`,
  );

  if (r.type === 'user') {
    lines.push('type:        user');
    return lines.join('\n');
  }

  // Agent shape.
  lines.push(`type:        agent`);
  if (r.kind) {
    lines.push(`kind:        ${r.kind === 'partner' ? 'Partner' : 'Employee'}`);
  }
  if (r.role) {
    const roleLabel = r.roleDisplayName
      ? `${r.roleDisplayName} (${r.role})`
      : r.role;
    lines.push(`role:        ${roleLabel}`);
  }
  if (r.generation !== null) {
    lines.push(`generation:  ${r.generation}`);
  }
  if (r.parentSlot) {
    lines.push(`parent:      ${r.parentSlot}`);
  }

  if (r.casket) {
    if (r.casket.currentStep && r.casket.title) {
      lines.push(`casket:      ${r.casket.currentStep} — "${r.casket.title}"`);
    } else if (r.casket.currentStep) {
      lines.push(`casket:      ${r.casket.currentStep}`);
    } else {
      lines.push(`casket:      idle`);
    }
  }

  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────

function readCurrentStepSafe(corpRoot: string, slug: string): string | null {
  try {
    const cs = getCurrentStep(corpRoot, slug);
    return cs ?? null;
  } catch {
    return null;
  }
}

function parseOpts(rawArgs: string[]): WhoamiOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      agent: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  // Subcommand detection: `cc-cli whoami rename <name>` →
  // positionals = ['rename', '<name>']. When the user runs
  // `cc-cli whoami rename --agent <slug>` (no <name>), positionals[1]
  // is undefined; coerce to empty string so cmdWhoami enters the
  // rename branch and validateRenameName rejects with "name is
  // required" — surfacing the missing argument as a hard error
  // instead of silently falling through to read-mode (Codex P2).
  let rename: string | undefined;
  if (parsed.positionals[0] === 'rename') {
    rename = parsed.positionals[1] ?? '';
  }
  return {
    agent: parsed.values.agent as string | undefined,
    corp: parsed.values.corp as string | undefined,
    json: !!parsed.values.json,
    ...(rename !== undefined ? { rename } : {}),
  };
}

// ─── Rename mechanics (Project 1.10.3) ──────────────────────────────

/** One-word, 2–30 chars, starts with a letter, alphanumerics + hyphen / underscore. */
const RENAME_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,29}$/;

export function validateRenameName(name: string): string | null {
  if (!name) return 'name is required (e.g. `cc-cli whoami rename Toast --agent backend-engineer-ab`)';
  if (!RENAME_NAME_PATTERN.test(name)) {
    return `"${name}" doesn't match the name shape — one word, 2–30 chars, starts with a letter, alphanumerics + hyphen/underscore`;
  }
  return null;
}

export interface RenameNamingBodyInput {
  slug: string;
  chosenName: string;
  role: string;
  parentSlot: string | null;
  generation: number;
  bornAt: string;
}

/**
 * Render the prose body that lands in both the naming observation
 * chit AND the CLI output on successful rename. Single source of
 * formatting so the agent sees exactly what gets archived.
 */
export function renderNamingBody(input: RenameNamingBodyInput): string {
  const parentLine = input.parentSlot
    ? `parent:      ${input.parentSlot}`
    : 'parent:      none (first of lineage)';
  return [
    `[${input.slug}] is now ${input.chosenName}.`,
    '',
    `- born:        ${input.bornAt} (mitose, queue overflow)`,
    `- ${parentLine}`,
    `- generation:  ${input.generation}`,
    `- role:        ${input.role}`,
    `- chose name on first dispatch.`,
    '',
    `Welcome, ${input.chosenName}.`,
  ].join('\n');
}

/**
 * Pure eligibility + uniqueness check for a rename request. Split out
 * of handleRename so unit tests can hit every rejection path without
 * mocking process.exit. Returns a discriminated result; callers run
 * `fail()` on `!ok` and proceed otherwise.
 */
export type RenameEligibilityResult =
  | { ok: true }
  | { ok: false; error: string };

export function checkRenameEligibility(
  member: Member,
  newName: string,
  allMembers: readonly Member[],
): RenameEligibilityResult {
  if (member.type !== 'agent') {
    return {
      ok: false,
      error: `only agents can rename — "${member.id}" is type=${member.type}`,
    };
  }
  const kind = member.kind ?? 'partner';
  if (kind !== 'employee') {
    return {
      ok: false,
      error:
        `only Employees can self-name — "${member.id}" is kind=partner. ` +
        `Partners are founder-named; renaming an established Partner is out of scope here.`,
    };
  }
  if (member.status !== 'active') {
    return {
      ok: false,
      error: `member "${member.id}" is status=${member.status}, not active`,
    };
  }
  if (member.displayName !== member.id) {
    return {
      ok: false,
      error:
        `"${member.id}" already has displayName "${member.displayName}". ` +
        `Self-naming is one-shot — only bacteria-spawned slots with displayName === id qualify.`,
    };
  }
  const shapeErr = validateRenameName(newName);
  if (shapeErr) {
    return { ok: false, error: shapeErr };
  }
  // Codex P2: renaming to the slug itself passes shape (the slug is
  // a valid name shape) and uniqueness (no other slot holds it), but
  // displayName stays equal to id, so the self-naming fragment never
  // self-cancels and "one-shot naming" silently breaks. Reject.
  if (newName === member.id) {
    return {
      ok: false,
      error: `"${newName}" is your slug — pick a different name. Renaming to the slug leaves displayName === id, which keeps the self-naming preamble firing on every dispatch.`,
    };
  }
  if (!member.role) {
    return {
      ok: false,
      error:
        `"${member.id}" has no role registered — uniqueness check can't run. ` +
        `This is unexpected for a bacteria-spawned slot; check the Member record.`,
    };
  }
  const conflict = allMembers.find(
    (m) =>
      m.id !== member.id &&
      m.type === 'agent' &&
      m.status === 'active' &&
      m.role === member.role &&
      m.displayName === newName,
  );
  if (conflict) {
    return {
      ok: false,
      error:
        `another active ${member.role} already holds displayName "${newName}" ` +
        `(slot ${conflict.id}). Pick something else — names within a role are unique.`,
    };
  }
  return { ok: true };
}

function handleRename(
  corpRoot: string,
  member: Member,
  newName: string,
  asJson: boolean,
): void {
  const allMembers = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  const eligibility = checkRenameEligibility(member, newName, allMembers);
  if (!eligibility.ok) {
    fail(`whoami rename: ${eligibility.error}`);
  }

  // Write the new displayName.
  const updated = allMembers.map((m) =>
    m.id === member.id ? { ...m, displayName: newName } : m,
  );
  writeConfig(join(corpRoot, MEMBERS_JSON), updated);

  // Naming observation chit — birth bracket of the slot's lifetime.
  // Pairs with apoptosis's obituary observation (also subject=slug,
  // category=NOTICE) so dreams (Project 4) can compound the pair.
  // Best-effort: a chit-write failure doesn't roll back the rename
  // (the displayName is already committed); we surface the failure
  // on stderr.
  const body = renderNamingBody({
    slug: member.id,
    chosenName: newName,
    role: member.role!,
    parentSlot: member.parentSlot ?? null,
    generation: member.generation ?? 0,
    bornAt: member.createdAt,
  });
  try {
    createChit(corpRoot, {
      type: 'observation',
      scope: 'corp',
      createdBy: member.id,
      fields: {
        observation: {
          category: 'NOTICE',
          subject: member.id,
          importance: 1,
          title: `${member.id} chose name: ${newName}`,
        },
      },
      body,
    });
  } catch (err) {
    process.stderr.write(
      `[whoami rename] naming observation write failed (rename committed): ${(err as Error).message}\n`,
    );
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          slug: member.id,
          previousDisplayName: member.id,
          displayName: newName,
          role: member.role,
          parentSlot: member.parentSlot ?? null,
          generation: member.generation ?? 0,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(body);
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

