export type DmMode = 'jack' | 'async';

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
  createdAt: string;
}
