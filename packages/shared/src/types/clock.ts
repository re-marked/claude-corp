/** Clock type — what kind of periodic operation this is. */
export type ClockType =
  | 'heartbeat'   // Agent wake cycles (Pulse, Failsafe, Tasks refresh, Inbox check)
  | 'timer'       // Recurring system timers (Git snapshots, Gateway health)
  | 'loop'        // User-created recurring commands (future: /loop)
  | 'cron'        // Scheduled jobs (future)
  | 'system';     // Internal daemon housekeeping (dedup cleanup, reconnects)

/** Clock status — current lifecycle state. */
export type ClockStatus =
  | 'running'     // Actively ticking
  | 'paused'      // Temporarily stopped, can resume
  | 'stopped'     // Permanently stopped
  | 'error';      // Last fire failed (still running, will retry)

/**
 * Clock — a unified primitive for anything that runs on a timer.
 * Every setInterval in the daemon becomes a Clock with full observability.
 */
export interface Clock {
  /** Unique identifier (e.g., 'pulse-monitor', 'git-snapshots') */
  id: string;
  /** Human-readable name (e.g., 'Pulse Monitor', 'Git Snapshots') */
  name: string;
  /** Category of clock */
  type: ClockType;
  /** Milliseconds between fires */
  intervalMs: number;
  /** What this clock targets (agent name, 'all agents', 'git repo', etc.) */
  target: string;
  /** Current lifecycle state */
  status: ClockStatus;
  /** Timestamp (ms) of last successful fire, null if never fired */
  lastFiredAt: number | null;
  /** Timestamp (ms) of next expected fire, null if paused/stopped */
  nextFireAt: number | null;
  /** Total number of successful fires since registration */
  fireCount: number;
  /** Total number of errors since registration */
  errorCount: number;
  /** Number of consecutive errors (resets on successful fire) */
  consecutiveErrors: number;
  /** Last error message, null if no errors */
  lastError: string | null;
  /** What this clock does */
  description: string;
  /** When this clock was registered (ms timestamp) */
  createdAt: number;
}
