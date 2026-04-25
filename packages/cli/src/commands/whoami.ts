/**
 * cc-cli whoami — "who am I" introspection.
 *
 * Read-only, no mutations. Resolves a member by id, reads their
 * casket if they're an agent, formats the result. Useful for fresh
 * sessions post-Dredge handoff, post-compaction recovery, post-spawn
 * bacteria slots that haven't named themselves yet, or any moment
 * when an agent's identity feels uncertain.
 *
 * Slims `cc-cli wtf`. wtf was overloaded — handoff context + recent
 * activity + what to do next + identity. Pulling identity into its
 * own command leaves wtf as "what's happening, what should I do next."
 *
 * Project 1.10.2. PR 3 will add `cc-cli whoami rename <name>` as a
 * subcommand for bacteria-spawned slots to self-name.
 */

import { parseArgs } from 'node:util';
import {
  findChitById,
  getCurrentStep,
  getRole,
  type Chit,
  type Member,
  type TaskFields,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../client.js';

export interface WhoamiOpts {
  agent?: string;
  corp?: string;
  json?: boolean;
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
  // a task chit. Errors degrade to null (corrupted casket shouldn't
  // block whoami).
  let casket: WhoamiResult['casket'] = null;
  if (isAgent) {
    const currentStep = readCurrentStepSafe(corpRoot, member.id);
    let title: string | null = null;
    if (currentStep) {
      const hit = findChitById(corpRoot, currentStep);
      if (hit && hit.chit.type === 'task') {
        title = (hit.chit.fields.task as TaskFields).title ?? null;
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
    strict: false,
  });
  return {
    agent: parsed.values.agent as string | undefined,
    corp: parsed.values.corp as string | undefined,
    json: !!parsed.values.json,
  };
}

// Re-export for tests + future PR 3 (whoami rename) to share helpers.
export type { Chit };
