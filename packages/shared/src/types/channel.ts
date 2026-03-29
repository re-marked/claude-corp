export type ChannelKind = 'broadcast' | 'team' | 'direct' | 'system';
export type ChannelScope = 'corp' | 'project' | 'team';
/** dm = auto-dispatch to other member, mention = @mentioned only, all = every message wakes all agents */
export type ChannelMode = 'dm' | 'mention' | 'all';

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
  mode?: ChannelMode;
}
