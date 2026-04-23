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
}
