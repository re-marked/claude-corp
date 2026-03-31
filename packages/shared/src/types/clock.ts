/** Clock type — what kind of periodic operation this is. */
export type ClockType =
  | 'heartbeat'   // Agent wake cycles (Pulse, Failsafe, Tasks refresh, Inbox check)
  | 'timer'       // Recurring system timers (Git snapshots, Gateway health)
  | 'loop'        // User-created recurring commands (@every 5m)
  | 'cron'        // Scheduled jobs (0 9 * * 1, @daily, @weekly)
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

/**
 * ScheduledClock — a user-created loop or cron with persistence.
 * Extends Clock with scheduling metadata, execution target, and output tracking.
 * Stored in clocks.json at corp root. Rehydrated on daemon restart.
 */
/** Lifecycle state for user-created loops and crons. */
export type ScheduledClockStatus =
  | 'running'     // Actively firing
  | 'paused'      // Temporarily paused, can resume
  | 'completed'   // Finished its job — history preserved (e.g., maxRuns reached, user marked done)
  | 'dismissed'   // No longer needed — hidden from /clock but kept in clocks.json
  | 'deleted';    // Marked for removal — cleaned up on next persist

/** Template for tasks spawned by a cron on each fire. */
export interface CronTaskTemplate {
  /** Title pattern — {date} replaced with fire date (e.g., "Bug audit — {date}") */
  title: string;
  /** Agent slug to assign each spawned task to */
  assignTo: string | null;
  /** Task priority */
  priority: 'critical' | 'high' | 'normal' | 'low';
  /** Optional description for each spawned task */
  description: string | null;
}

export interface ScheduledClock extends Clock {
  /** Original schedule expression: "@every 5m", "0 9 * * 1", "@daily" */
  expression: string;
  /** Human-readable schedule label: "Every 5 minutes", "At 9:00 AM, only on Monday" */
  humanSchedule: string;
  /** Shell command to run, OR prompt text to send to agent */
  command: string;
  /** If set, dispatch to this agent via say() instead of running as shell command */
  targetAgent: string | null;
  /** Auto-stop after this many fires (null = unlimited) */
  maxRuns: number | null;
  /** Whether this clock should be rehydrated on daemon restart */
  enabled: boolean;
  /** How long the last callback execution took (ms) */
  lastDurationMs: number | null;
  /** Last callback output, truncated to 500 chars */
  lastOutput: string | null;
  /** Channel where this loop/cron was created — output goes here */
  channelId: string | null;
  /** Lifecycle status for user-facing state management */
  scheduledStatus: ScheduledClockStatus;
  /** When this loop/cron was completed or dismissed */
  endedAt: number | null;
  /** For loops: the task this loop drives. Loop complete → task complete. */
  taskId: string | null;
  /** For crons: if set, each fire spawns a fresh task from this template. */
  spawnTaskTemplate: CronTaskTemplate | null;
}
