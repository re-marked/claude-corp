/**
 * Role resolver — "which Employee slot should pick up work for role X?"
 *
 * The missing middle of `cc-cli hand --to <role>`: given a role id,
 * return the Employee slot that should get the Casket update. Pure
 * filesystem reads (members.json + each candidate's Casket chit);
 * no mutation, no dispatch. Callers (cmdHand, cmdBlock, chain-walker
 * delta application) take the resolved target and do the
 * state-machine transitions themselves.
 *
 * ### Three outcomes
 *
 *   1. `resolved`           — pool-eligible role with at least one
 *                             Employee agent; picker chose a target.
 *                             Target slug is usable for Casket update.
 *   2. `role-is-partner-only` — role exists but its tier is not `worker`
 *                             (decree / role-lead). Partners are slot
 *                             targets — caller must name one. Result
 *                             carries the list of current Partners in
 *                             that role so the error message is
 *                             actionable ("candidates: alice, bob").
 *   3. `no-candidates`      — role is pool-eligible but no Employees
 *                             of that role exist yet. Bacteria (1.9)
 *                             will eventually intercept here and
 *                             spawn; until then, the caller surfaces
 *                             an error telling the founder to hire.
 *
 * ### Picker algorithm
 *
 * Three-phase:
 *
 *   Phase 1 (idle-first): if any candidate's Casket has
 *     `currentStep === null`, pick lexically-first among them.
 *     Deterministic → reproducible picks in tests and replays.
 *
 *   Phase 2 (least-priority current): all candidates busy. Pick the
 *     one whose current task has the LOWEST priority (we displace
 *     low-value work first, leaving critical-priority chains on
 *     their existing owners). Priority weight: critical=4, high=3,
 *     normal=2, low=1. Ties broken lexically.
 *
 *   Phase 3 (data-gap fallback): no task data readable. Pick
 *     lexically-first candidate. Fail-open rather than errors —
 *     mis-targeting is worse than "couldn't read your current step."
 *
 * The picker is pure over the input state: for a given members.json +
 * Casket snapshot, the same role id always resolves to the same slug.
 * Tests fix this. The bacteria split decision (1.9) reads the same
 * signals but drives a different outcome (spawn another Employee when
 * queue depth weighted-over-idle crosses threshold); shipping both
 * off the same resolver surface keeps the policies aligned.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Member } from './types/member.js';
import type { TaskFields } from './types/chit.js';
import { MEMBERS_JSON } from './constants.js';
import { getRole } from './roles.js';
import { getCurrentStep } from './casket.js';
import { findChitById } from './chits.js';

// ─── Result shape ───────────────────────────────────────────────────

export type RoleResolveResult =
  | RoleResolvedResult
  | RolePartnerOnlyResult
  | RoleNoCandidatesResult
  | RoleUnknownResult;

export interface RoleResolvedResult {
  readonly kind: 'resolved';
  /** Selected Employee slug — caller writes Casket.currentStep on this member. */
  readonly slug: string;
  /** Their current Casket currentStep (null = idle). Lets caller decide whether to announce / preempt. */
  readonly currentStep: string | null;
  /** Which phase of the picker chose them — observability, tests can assert. */
  readonly pickPhase: 'idle-first' | 'least-priority' | 'data-gap-fallback';
  /** All candidates considered (including the chosen one). Useful for logging + bacteria-queue-depth signals. */
  readonly candidates: readonly string[];
}

export interface RolePartnerOnlyResult {
  readonly kind: 'role-is-partner-only';
  /** Current Partners in that role — caller renders "candidates: alice, bob" in the error. */
  readonly partnerCandidates: readonly { slug: string; displayName: string }[];
  readonly role: string;
}

export interface RoleNoCandidatesResult {
  readonly kind: 'no-candidates';
  readonly role: string;
  /** True when the role registry entry exists + is pool-eligible but no members hold it. The 1.9 bacteria intercept point. */
  readonly poolEligible: true;
}

export interface RoleUnknownResult {
  readonly kind: 'unknown-role';
  readonly role: string;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Resolve a role id to a dispatch target. Pure: reads members.json +
 * each candidate's Casket chit, returns a structured decision. Callers
 * apply the decision (write Casket, announce, error on non-resolved).
 *
 * ### Not-for-slot-target
 * If the caller already has a specific slug (not a role), they don't
 * call this — they just use the slug directly. This resolver exists
 * specifically for the role-mode hand / block / escalate paths.
 */
export function resolveRoleToEmployee(
  corpRoot: string,
  roleId: string,
): RoleResolveResult {
  const role = getRole(roleId);
  if (!role) return { kind: 'unknown-role', role: roleId };

  // Partner-by-decree or Partner-by-role (role-lead tier): role-resolver
  // refuses to pool-dispatch. Partners are slot targets — the caller
  // must name one. We return the current Partners in the role so the
  // error message is actionable.
  if (role.tier !== 'worker') {
    const partners = loadMembers(corpRoot)
      .filter(isActiveAgent)
      .filter((m) => m.role === roleId && (m.kind ?? 'partner') === 'partner')
      .map((m) => ({ slug: m.id, displayName: m.displayName }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      kind: 'role-is-partner-only',
      partnerCandidates: partners,
      role: roleId,
    };
  }

  // Worker tier: pool-resolve. Find all Employees of this role.
  const candidates = loadMembers(corpRoot)
    .filter(isActiveAgent)
    .filter((m) => m.role === roleId && (m.kind ?? 'partner') === 'employee')
    .map((m) => m.id)
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) {
    return { kind: 'no-candidates', role: roleId, poolEligible: true };
  }

  // Read each candidate's Casket currentStep. getCurrentStep returns
  // three-way: string (busy), null (explicit idle), undefined (no
  // Casket chit yet — treat as idle for picker purposes, since no
  // work is in progress).
  type Snapshot = {
    slug: string;
    currentStep: string | null | undefined;
    priorityWeight: number | null;
  };
  const snapshots: Snapshot[] = candidates.map((slug) => {
    let currentStep: string | null | undefined;
    try {
      currentStep = getCurrentStep(corpRoot, slug);
    } catch {
      currentStep = undefined;
    }
    const priorityWeight = currentStep ? loadPriorityWeight(corpRoot, currentStep) : null;
    return { slug, currentStep, priorityWeight };
  });

  // Phase 1 — idle-first. Employees with currentStep null OR undefined.
  const idle = snapshots.filter((s) => s.currentStep === null || s.currentStep === undefined);
  if (idle.length > 0) {
    const picked = idle[0]!; // candidates are sorted lexically above
    return {
      kind: 'resolved',
      slug: picked.slug,
      currentStep: picked.currentStep ?? null,
      pickPhase: 'idle-first',
      candidates,
    };
  }

  // Phase 2 — all busy. Pick least-priority current task (displace
  // low-value work first). If every snapshot has priorityWeight=null
  // (no current task data readable), fall through to phase 3.
  const withWeights = snapshots.filter((s): s is Snapshot & { priorityWeight: number } => s.priorityWeight !== null);
  if (withWeights.length > 0) {
    withWeights.sort((a, b) => {
      if (a.priorityWeight !== b.priorityWeight) return a.priorityWeight - b.priorityWeight;
      return a.slug.localeCompare(b.slug);
    });
    const picked = withWeights[0]!;
    return {
      kind: 'resolved',
      slug: picked.slug,
      currentStep: picked.currentStep ?? null,
      pickPhase: 'least-priority',
      candidates,
    };
  }

  // Phase 3 — data-gap fallback. All busy, no readable priorities.
  // Pick lexically-first; log-worthy condition but not an error
  // (mis-targeting is worse than picking a valid-if-loaded employee).
  const picked = snapshots[0]!;
  return {
    kind: 'resolved',
    slug: picked.slug,
    currentStep: picked.currentStep ?? null,
    pickPhase: 'data-gap-fallback',
    candidates,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function loadMembers(corpRoot: string): Member[] {
  const path = join(corpRoot, MEMBERS_JSON);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as Member[];
  } catch {
    return [];
  }
}

function isActiveAgent(m: Member): boolean {
  return m.type === 'agent' && m.status === 'active';
}

/**
 * Read the priority weight of the task chit a Casket points at.
 * Returns null when the chit doesn't resolve or isn't a task.
 * Weights: critical=4, high=3, normal=2, low=1. Higher = more
 * important; picker wants to displace LOW first so it picks the
 * lowest-weighted candidate.
 */
function loadPriorityWeight(corpRoot: string, chitId: string): number | null {
  const hit = findChitById(corpRoot, chitId);
  if (!hit) return null;
  if (hit.chit.type !== 'task') return null;
  const priority = (hit.chit.fields.task as TaskFields).priority;
  switch (priority) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'normal': return 2;
    case 'low': return 1;
    default: return null;
  }
}
