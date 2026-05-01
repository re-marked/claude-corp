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
  /**
   * Latest observed input-token count for this agent's session. Populated
   * by the daemon from ClaudeCodeUsage on message_start / message_delta.
   * Used by Project 1.7's pre-compact signal fragment to decide whether
   * the context is full enough to warrant nudging the Partner to
   * crystallize memory before autocompact fires. Undefined when the
   * daemon has no usage snapshot yet (first turn of a session, or an
   * OpenClaw agent that doesn't emit usage).
   */
  sessionTokens?: number;
  /**
   * Model id for the latest observed usage snapshot. Threaded alongside
   * sessionTokens so the threshold math (which varies by model's context
   * window — 200k vs 1M) can be applied correctly.
   */
  sessionModel?: string;
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
