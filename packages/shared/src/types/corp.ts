export type DmMode = 'jack' | 'async';

/**
 * Founder-set calibration knobs captured during the founding
 * conversation (Project 1.13). The CEO writes here as it walks
 * BOOTSTRAP.md; downstream consumers read with fallback to
 * hardcoded defaults so a missing field never breaks the corp.
 *
 * Adding a field is non-breaking: existing corps that pre-date
 * the field simply use the default until their CEO is asked.
 */
export interface CorpPreferences {
  /** Founder's autonomy trust on 1-10. Higher = more autonomy. Asked directly during the founding conversation. */
  trustScore?: number;
  /** Editor reject cap before auto-bypass kicks in. Higher = more rigor, more friction. Default 3. */
  editorReviewRoundCap?: number;
  /** When the Audit Gate flags low-quality work: hard-block the commit, or warn-and-allow. Default 'block'. */
  auditGate?: 'block' | 'warn';
  /** How aggressively the Employee pool auto-scales. Default 'balanced'. */
  bacteriaScaling?: 'conservative' | 'balanced' | 'aggressive';
  /** Sexton's wake cadence when nothing's wrong. Default 'daily'. */
  sextonCadence?: 'daily' | 'twice-daily' | 'on-event-only';
  /** When a PR blocks/fails: DM immediately or batch into a daily digest. Default 'immediate'. */
  failureNotification?: 'immediate' | 'daily-digest';
  /** When agents disagree, who breaks the tie. Default 'higher-rank'. */
  disagreementTiebreak?: 'founder' | 'higher-rank' | 'coin-flip';
  /** PRs-always discipline, or direct push allowed for small changes. Default 'pr-always'. */
  branchPolicy?: 'pr-always' | 'direct-push-allowed';
  /** Granular commits preserved, or rebase to a clean story before merge. Default 'granular'. */
  commitPolicy?: 'granular' | 'rebase-clean';
}

export interface Corporation {
  name: string;
  displayName: string;
  owner: string;
  ceo: string | null;
  description: string;
  theme: string;
  /** Default DM mode: 'jack' (persistent session, recommended) or 'async' (stateless dispatch) */
  defaultDmMode?: DmMode;
  /**
   * Founder Away: auto-activate SLUMBER when founder goes idle 30+ minutes.
   * OFF by default. Requires explicit opt-in because the CEO will start
   * working autonomously without being asked. Uses Guard Duty profile.
   */
  dangerouslyEnableAutoAfk?: boolean;
  /**
   * Corp-wide default harness for agents that don't specify one. Optional;
   * falls back to 'openclaw' when missing so existing corps keep working
   * with no migration.
   */
  harness?: string;
  /**
   * Founder-set calibration block (Project 1.13). Populated by the
   * CEO as it walks BOOTSTRAP.md's calibration phase. Missing keys
   * read as defaults — adding a key is always non-breaking.
   */
  preferences?: CorpPreferences;
  createdAt: string;
}
