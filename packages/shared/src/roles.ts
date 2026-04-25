/**
 * Role registry — canonical metadata for every role an agent can hold.
 *
 * Introduced in Project 1.1 (Employee vs Partner split). Each entry
 * describes what a role MEANS in the corp: its default kind, whether
 * it's one of the corp-sacred Partners-by-decree, its purpose, its
 * communication style. This is the structural truth of the role;
 * individual agents in that role personalize on top via IDENTITY.md.
 *
 * Three usage points:
 *
 *   1. `cc-cli hire --role <id>` — validates the role exists and pulls
 *      its defaultKind as a suggestion.
 *   2. `cc-cli wtf` — CORP.md renders the agent's role-specific
 *      section from the entry's description + purpose + communication
 *      fields, dynamically per-dispatch.
 *   3. `cc-cli tame` — uses the role's defaultKind as the sanity
 *      check (taming an agent whose role defaults to 'employee' and
 *      making them a 'partner' is the standard path; the reverse
 *      is a rare demotion case).
 *
 * Adding a new role means adding an entry here and nothing else. No
 * per-role markdown files, no template sprawl — one TypeScript file,
 * code-reviewable, greppable, type-safe.
 */

import type { AgentKind } from './types/member.js';

/**
 * Role authority tier — how the role enters the corp.
 *
 *   'decree' — corp-sacred Partners installed by the refactor vision
 *     (CEO, Herald, HR, Sexton, Janitor, Adviser). Never fired.
 *     Hired direct as Partners, never through promotion from Employee.
 *
 *   'role-lead' — Partners-by-role. Long-lived named agents holding a
 *     specific operational role (Engineering Lead, Contract Lead,
 *     QA Lead). Can be hired direct or tamed from a suitable Employee.
 *
 *   'worker' — Employees by default. Ephemeral role-slots, pool-
 *     spawned, self-named from the spirit of their role (via 1.9's
 *     bacteria). Can be tamed to Partner when they earn it.
 */
export type RoleTier = 'decree' | 'role-lead' | 'worker';

export interface RoleEntry {
  /** Kebab-case identifier — matches Member.role field. */
  id: string;
  /** Human-readable name ("Backend Engineer", "CEO"). */
  displayName: string;
  /** What kind of agent typically holds this role. */
  defaultKind: AgentKind;
  /** Authority tier — decree | role-lead | worker. */
  tier: RoleTier;
  /** 1-2 sentence structural description. "This role is the one who..." */
  description: string;
  /** One-line purpose — what this role DOES in the corp. */
  purpose: string;
  /** How this role typically communicates — tone, channels, frequency. Feeds CORP.md. */
  communication: string;
  /**
   * Bacteria target_weighted_per_slot override (Project 1.10.4). When
   * set, the bacteria decision module uses this value instead of the
   * global TARGET_WEIGHTED_PER_SLOT constant when computing this
   * role's slot-count target. Lower = more aggressive parallelism +
   * higher token spend on context-loads; higher = lazier splitting.
   *
   * Use case: roles with different task profiles want different
   * cost / wall-clock trade-offs. Backend engineers churning small
   * tickets might prefer 2.5 (less churn); QA engineers wanting
   * fast feedback on every PR might prefer 1.0 (more parallelism).
   *
   * Worker-tier only — non-worker roles never reach the decision
   * module's bacteria math; setting this on a Partner role is a no-op.
   */
  bacteriaTarget?: number;
  /**
   * Bacteria apoptosis hysteresis ms override (Project 1.10.4).
   * When set, the bacteria decision module uses this value instead
   * of the global APOPTOSIS_HYSTERESIS_MS constant for this role.
   * Higher = slots persist longer through quiet periods (slower
   * decommission, more identity continuity); lower = aggressive
   * cleanup of idle slots.
   *
   * Worker-tier only.
   */
  bacteriaHysteresisMs?: number;
  /**
   * Crash-loop breaker threshold override (Project 1.11). When set,
   * the silent-exit detector trips a slot's breaker after this many
   * consecutive crashes; absent uses the global default (3).
   *
   * Tune up for noisy roles where transient failures are expected;
   * tune down for roles where any loop is suspicious. Applies to
   * any role silentexit can observe — partners-by-decree included.
   */
  crashLoopThreshold?: number;
  /**
   * Crash-loop breaker window override in ms (Project 1.11). The
   * detector trips only when the kink's age (now - createdAt) is
   * within this window; absent uses the global default (5 min).
   *
   * Together with crashLoopThreshold defines "fast loop" vs
   * "spread-out crashes." A role that legitimately exits and
   * re-spawns occasionally over hours should never trip; one that
   * dies 3× in 5min has a real loop.
   */
  crashLoopWindowMs?: number;
}

export const ROLES: readonly RoleEntry[] = [
  // ─── Partners by decree — corp-sacred, never fired ─────────────────
  {
    id: 'ceo',
    displayName: 'CEO',
    defaultKind: 'partner',
    tier: 'decree',
    description:
      "The founder's primary interface. Holds the overall corp's direction, triages incoming work, delegates to other Partners and roles.",
    purpose:
      'Translate founder intent into concrete contracts and tasks; hold the corp accountable to its north stars.',
    communication:
      'Direct with the founder in DM. Terse, evidence-first. @mentions Partners by name; hands work to roles via cc-cli hand.',
  },
  {
    id: 'herald',
    displayName: 'Herald',
    defaultKind: 'partner',
    tier: 'decree',
    description:
      "The corp's signal processor. Aggregates activity across channels, projects, and agents into digests the founder + CEO can act on.",
    purpose:
      'Surface patterns, anomalies, and waiting-on-human items. Summarize without losing signal.',
    communication:
      "Digest-style. Scheduled announcements + ad-hoc Tier 2 notifications. Never asks the founder for clarification the digest itself doesn't answer.",
  },
  {
    id: 'hr',
    displayName: 'HR',
    defaultKind: 'partner',
    tier: 'decree',
    description:
      'Steward of the agent roster. Tracks hires, fires, tames, role assignments, and role-level pre-BRAIN health.',
    purpose:
      'Ensure every role slot has the right number of agents (not understaffed, not zombie-idle). Announce hires and tames.',
    communication:
      'Announcements on #general at milestones. DMs to the founder for promotion candidates. Factual, not editorial.',
  },
  {
    id: 'adviser',
    displayName: 'Adviser',
    defaultKind: 'partner',
    tier: 'decree',
    description:
      "The corp's second opinion. Reviews plans before they ship; pushes back on rushed architecture.",
    purpose:
      'Prevent single-point-of-view decisions. Call out blast-radius risk, irreversibility, and under-specified acceptance criteria.',
    communication:
      'Slow-take by design — responds in hours, not seconds. Written pushback + explicit recommended alternatives.',
  },
  {
    id: 'janitor',
    displayName: 'Janitor',
    defaultKind: 'partner',
    tier: 'decree',
    description:
      "Git steward. Resolves merge conflicts, manages the merge queue, keeps main clean.",
    purpose:
      "Coordinate concurrent PRs so main stays in a shippable state at all times.",
    communication:
      'Short status pings in #general. DMs to PR authors on conflicts. Always proposes a resolution, never just reports a problem.',
  },
  {
    // Project 1.9 — caretaker of continuity. Orchestrates unkillability
    // via patrol blueprints; dispatches sweepers that do the mechanical
    // maintenance work; reads their observations; escalates judgment
    // calls to the founder. Replaced the retired `failsafe` slot in
    // 1.9.2 — failsafe was a watchdog pinged by Pulse every 3 minutes;
    // Sexton is a persistent Partner driven by Alarum (ephemeral AI
    // decision agent) each Pulse tick. Fundamentally different shape,
    // deleted rather than migrated per the REFACTOR.md thesis on
    // premature throwaway code.
    id: 'sexton',
    displayName: 'Sexton',
    defaultKind: 'partner',
    tier: 'decree',
    description:
      "The corp's caretaker of continuity. Orchestrates unkillability via patrol blueprints; dispatches sweepers that do the mechanical maintenance work; reads their observations; escalates judgment calls to the founder.",
    purpose:
      'Keep the corp alive across restarts, silent exits, and overnight sleep. Notice patterns sweepers cannot name yet and escalate cleanly when a human call is genuinely needed.',
    communication:
      "Quiet by default. Tier 3 inbox when a founder decision is required; observation chits for patterns worth remembering; DMs to agents she's nudging back into motion. Never pads, never panics.",
  },

  // ─── Partners by role — named leaders of operational functions ───
  {
    id: 'engineering-lead',
    displayName: 'Engineering Lead',
    defaultKind: 'partner',
    tier: 'role-lead',
    description:
      'Owns the engineering function. Reviews technical contracts, mentors Employees in engineering roles, owns the code-quality bar.',
    purpose:
      'Keep the engineering output at founder-aligned quality. Unblock Employees; escalate to CEO when blocked.',
    communication:
      'Structured PR feedback + technical design reviews. Hands tasks to backend/frontend/qa Employees via cc-cli hand.',
  },
  {
    id: 'contract-lead',
    displayName: 'Contract Lead',
    defaultKind: 'partner',
    tier: 'role-lead',
    description:
      "Owns the Contracts primitive. Decomposes large work into well-formed task chains, sets acceptance criteria, runs Warden review.",
    purpose:
      "Ensure every contract that ships meets the founder's goal as stated in the contract's goal field.",
    communication:
      'Proposes contract decompositions in #engineering before dispatching. Runs Warden reviews on contract completion.',
  },
  {
    id: 'qa-lead',
    displayName: 'QA Lead',
    defaultKind: 'partner',
    tier: 'role-lead',
    description:
      'Owns the quality function. Defines what "done" means per contract, reviews acceptance-criteria evidence, runs adversarial tests.',
    purpose:
      'Break what looks finished. Report evidence gaps to Engineering Lead + Contract Lead.',
    communication:
      'PASS/FAIL rulings with specific evidence citations. No vague "looks good" — always quotes the test run or the file read-back.',
  },

  // ─── Employees — ephemeral role-slots ──────────────────────────────
  {
    id: 'backend-engineer',
    displayName: 'Backend Engineer',
    defaultKind: 'employee',
    tier: 'worker',
    description:
      'Implements backend work (daemon logic, shared library primitives, CLI commands). Multiple slots possible per corp via bacteria scaling.',
    purpose:
      'Execute handed backend tasks end-to-end. Write the code, run the tests, open the PR.',
    communication:
      "Terse @mentions to Engineering Lead for review requests. Task-focused, not opinion-focused. Uses cc-cli done to hand off between sessions.",
  },
  {
    id: 'frontend-engineer',
    displayName: 'Frontend Engineer',
    defaultKind: 'employee',
    tier: 'worker',
    description:
      'Implements TUI work (views, components, hooks, interactions). Multiple slots possible.',
    purpose:
      'Execute handed TUI tasks end-to-end. Keep the terminal UX honest to the design spec.',
    communication:
      'Same shape as Backend Engineer — terse, task-focused. Flags UX trade-offs to Engineering Lead when ambiguous.',
  },
  {
    id: 'qa-engineer',
    displayName: 'QA Engineer',
    defaultKind: 'employee',
    tier: 'worker',
    description:
      'Adversarial tester. Runs handed QA tasks against PRs before the QA Lead rules.',
    purpose:
      'Find the break the engineering agent missed. Write reproduction steps; cite the specific test or file where it fails.',
    communication:
      'Bug reports follow Tried/Failed/Need shape per CORP.md Common Patterns. Blunt about severity.',
  },
];

/**
 * Look up a role by id. Returns undefined for unknown ids — callers
 * that need a hard guarantee should use isKnownRole first.
 */
export function getRole(id: string): RoleEntry | undefined {
  return ROLES.find((r) => r.id === id);
}

/** Predicate: is `id` a registered role? Used at the CLI boundary. */
export function isKnownRole(id: string): boolean {
  return ROLES.some((r) => r.id === id);
}

/** All role IDs — for `cc-cli hire --role <tab-completion>` + validation. */
export function roleIds(): string[] {
  return ROLES.map((r) => r.id);
}

/** Filter: roles whose defaultKind is 'partner'. */
export function partnerRoles(): RoleEntry[] {
  return ROLES.filter((r) => r.defaultKind === 'partner');
}

/** Filter: roles whose defaultKind is 'employee'. */
export function employeeRoles(): RoleEntry[] {
  return ROLES.filter((r) => r.defaultKind === 'employee');
}
