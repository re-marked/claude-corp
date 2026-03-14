export type ChannelKind = 'broadcast' | 'team' | 'direct' | 'system';
export type ChannelScope = 'corp' | 'project' | 'team';

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  scope: ChannelScope;
  scopeId: string;
  teamId: string | null;
  memberIds: string[];
  createdBy: string;
  path: string;
  createdAt: string;
}
