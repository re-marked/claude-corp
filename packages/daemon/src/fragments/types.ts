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
  /** Structural agent kind (Project 1.1). When set, takes precedence over rank-based inferKind in the wtf prepend. */
  agentKind?: 'employee' | 'partner';
  /** Role registry id (Project 1.1). Drives CORP.md "Your Role" section when set. */
  agentRole?: string;
  agentDisplayName: string;
  channelKind: 'direct' | 'broadcast' | 'team' | 'system';
  /** Name of this agent's supervisor (CEO for workers, Founder for CEO) */
  supervisorName: string | null;
  /** Whether this agent is enrolled in autoemon (autonomous tick mode) */
  autoemonEnrolled?: boolean;
  /** Harness executing this agent — fragments can skip content that's already in the system prompt for a given harness */
  harness?: 'openclaw' | 'claude-code';
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
