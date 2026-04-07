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
   * Demo mode: when true, the daemon runs in inert mode for video recording.
   * - No real LLM dispatches (CEO heartbeats, Herald narration, Pulse pings, recovery clocks all skipped)
   * - System agents stay listed but never dispatched to
   * - The router still watches JSONL + the WebSocket bus still broadcasts events
   * - Set this manually in corp.json: { "demo": true }
   */
  demo?: boolean;
  createdAt: string;
}
