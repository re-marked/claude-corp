export type MemberRank = 'owner' | 'master' | 'leader' | 'worker' | 'subagent';
export type MemberStatus = 'active' | 'idle' | 'working' | 'suspended' | 'archived';
export type MemberType = 'user' | 'agent';
export type MemberScope = 'corp' | 'project' | 'team';
/** Computed work status — derived from process lifecycle + dispatch state */
export type AgentWorkStatus = 'offline' | 'starting' | 'idle' | 'busy' | 'broken';

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
}
