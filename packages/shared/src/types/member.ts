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
  createdAt: string;
}
