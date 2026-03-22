export interface FragmentContext {
  agentDir: string;
  corpRoot: string;
  channelName: string;
  channelMembers: string[];
  corpMembers: { name: string; rank: string; type: string; status: string }[];
  recentHistory: string[];
  daemonPort?: number;
  agentMemberId?: string;
  agentRank?: string;
  agentDisplayName: string;
  channelKind: 'direct' | 'broadcast' | 'team' | 'system';
  /** Name of this agent's supervisor (CEO for workers, Founder for CEO) */
  supervisorName: string | null;
}

export type FragmentFn = (ctx: FragmentContext) => string;

export interface Fragment {
  id: string;
  /** Selection predicate — return true if this fragment applies */
  applies: (ctx: FragmentContext) => boolean;
  /** Priority for ordering: lower = earlier in the system message */
  order: number;
  /** The fragment content generator */
  render: FragmentFn;
}
