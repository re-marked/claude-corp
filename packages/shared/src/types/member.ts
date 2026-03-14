export type MemberRank = 'owner' | 'master' | 'leader' | 'worker' | 'subagent';
export type MemberStatus = 'active' | 'idle' | 'working' | 'suspended' | 'archived';
export type MemberType = 'user' | 'agent';
export type MemberScope = 'corp' | 'project' | 'team';

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
