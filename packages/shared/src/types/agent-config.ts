export interface AgentConfig {
  memberId: string;
  displayName: string;
  model: string;
  provider: string;
  port: number | null;
  scope: 'corp' | 'project' | 'team';
  scopeId: string;
}
