export type MemberRank = 'owner' | 'master' | 'leader' | 'worker' | 'subagent';
export type MemberStatus = 'active' | 'idle' | 'working' | 'suspended' | 'archived';
export type MemberType = 'user' | 'agent';
export type MemberScope = 'corp' | 'project' | 'team';
/** Computed work status — derived from process lifecycle + dispatch state */
export type AgentWorkStatus = 'offline' | 'starting' | 'idle' | 'busy' | 'broken';

/**
 * The structural DNA split introduced in Project 1.1. Every agent is
 * one of two kinds:
 *
 *   'partner' — persistent, named, relationship-bearing. BRAIN,
 *     observations, compaction-based long context. Founder-named
 *     (either hired direct or tamed up from an Employee slot).
 *     Partners are WITNESSED across time.
 *
 *   'employee' — ephemeral role-slot. Pool-spawned, self-named from
 *     the spirit of their role (first-dispatch naming arrives in
 *     1.9's bacteria scaling). No individual-slot soul: no BRAIN,
 *     no observations, no compaction. Per-step session cycling via
 *     the WORKLOG handoff path (1.6). Employees do WORK.
 *
 * The distinction is load-bearing for later sub-projects: 1.6 keys
 * off kind for per-step cycling (Employees only); 1.7 for
 * compaction (Partners only); 1.9 for bacteria pool scaling
 * (Employees only). Omitting this field reads as 'partner' for
 * drift-tolerance — every agent created before 1.1 is already
 * persistent-named, which is the Partner profile.
 */
export type AgentKind = 'employee' | 'partner';

export interface Member {
  id: string;
  displayName: string;
  rank: MemberRank;
  status: MemberStatus;
  type: MemberType;
  scope: MemberScope;
  scopeId: string;
  agentDir: string | null;
  port: number | null;
  spawnedBy: string | null;
  /** Explicit management relationship — who this agent reports to. Takes precedence over spawnedBy for hierarchy checks. */
  supervisorId?: string | null;
  createdAt: string;
  /**
   * Registered harness name that executes turns for this agent.
   * Optional for backwards-compat; when missing, resolution falls back
   * to the corp-level default then to 'openclaw'.
   */
  harness?: string;
  /**
   * Structural agent kind — see AgentKind docstring. Optional for
   * backwards-compat: pre-1.1 agents have no kind field; resolveKind()
   * treats that as 'partner' (every agent that predates the split is
   * already a persistent-named Partner by profile). New hires set this
   * explicitly via `cc-cli hire --kind`.
   */
  kind?: AgentKind;
  /**
   * Role slot identifier — references an entry in the role registry
   * (packages/shared/src/roles.ts). Examples: 'ceo', 'herald',
   * 'backend-engineer', 'qa-engineer'. Optional for backwards-compat;
   * pre-1.1 agents infer role from displayName lowercased when
   * needed. New hires set explicitly via `cc-cli hire --role`.
   *
   * Distinct from rank (hierarchy position) and displayName (the
   * agent's individual name). Two agents can share a role (two
   * Backend Employees named Toast and Copper, both role='backend-
   * engineer'); they always differ in id and displayName.
   */
  role?: string;
  /**
   * Bacteria lineage — id of the parent slot that this Employee
   * mitosed from (Project 1.10). Set when bacteria spawns a slot in
   * response to queue overflow on the parent; null/absent when the
   * slot was the first member of its role's pool, or when the slot
   * was hired directly via `cc-cli hire` (no genealogy edge to
   * record). Used by obituary observations + generational telemetry
   * to trace "who descended from whom" across the colony's lifetime.
   *
   * Founder-hired agents and pre-1.10 Members have no parent and
   * read as generation 0.
   */
  parentSlot?: string | null;
  /**
   * Bacteria generation depth — Project 1.10. Founder-hired Employees
   * and Partners are generation 0 (or undefined, which reads as 0).
   * Each bacteria mitosis sets the new slot's generation to
   * parent.generation + 1. A pool that has been splitting + collapsing
   * for hours accumulates higher-generation slots; gen-0 are the
   * "founders" of the colony in the literal sense.
   *
   * Cosmetic + diagnostic, not load-bearing for any bacteria decision.
   * Useful in obituaries ("backend-engineer-toast: gen 4, parent ke")
   * and for spotting cumulative-context-drift bugs ("gen 7+ slots
   * crash twice as often as gen 0-2").
   */
  generation?: number;
}
