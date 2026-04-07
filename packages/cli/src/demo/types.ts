/**
 * Demo scenario format — pre-scripted TUI sequences for video recording.
 *
 * Scenarios replay through the daemon's WebSocket event bus + JSONL writes,
 * producing realistic-looking interactions without burning model tokens.
 *
 * Each scenario is a JSON file with timed events. The player executes events
 * in order with the specified delays, optionally sped up via --speed flag.
 */

// ── Event types ────────────────────────────────────────────────────

/** User types a message (writes to channel JSONL). */
export interface UserMessageEvent {
  type: 'user-message';
  channel: string;       // channel name (e.g., 'dm-ceo-mark')
  content: string;
  /** Optional: pause N ms before writing (typing simulation) */
  typingDelayMs?: number;
}

/** Agent dispatch begins — TUI shows "thinking" indicator. */
export interface DispatchStartEvent {
  type: 'dispatch-start';
  agent: string;         // display name
  channel: string;
}

/** Stream a single character or chunk to the preview. */
export interface StreamTokenEvent {
  type: 'stream-token';
  agent: string;
  channel: string;
  /** Text to append (single char for char-by-char, or larger chunks) */
  content: string;
}

/** Streaming ends — preview clears, final message is persisted to JSONL. */
export interface StreamEndEvent {
  type: 'stream-end';
  agent: string;
  channel: string;
  /** The final message content (written to JSONL) */
  content: string;
}

/** Agent uses a tool — shows inline tool event in TUI. */
export interface ToolCallEvent {
  type: 'tool-call';
  agent: string;
  channel: string;
  tool: string;          // 'read', 'write', 'edit', 'bash', 'grep', etc.
  args?: Record<string, unknown>;
  result?: string;       // first 200 chars of result
  /** Duration of the tool call (ms) */
  durationMs?: number;
}

/** A new agent appears in the corp (added to members.json). */
export interface AgentAppearEvent {
  type: 'agent-appear';
  id: string;
  displayName: string;
  rank: 'master' | 'leader' | 'worker';
  /** Optional model override */
  model?: string;
}

/** Create a task file with frontmatter. */
export interface TaskCreateEvent {
  type: 'task-create';
  id: string;            // word-pair ID like 'cool-bay'
  title: string;
  assignedTo?: string;   // agent display name
  priority?: 'low' | 'normal' | 'high' | 'critical';
  status?: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

/** Update a task's status. */
export interface TaskUpdateEvent {
  type: 'task-update';
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed';
}

/** Activate SLUMBER mode (UI only — no real ticks). */
export interface SlumberStartEvent {
  type: 'slumber-start';
  profile?: 'night-owl' | 'school-day' | 'sprint' | 'guard-duty';
  durationMs?: number;
}

/** Fake tick event during SLUMBER timelapse. */
export interface SlumberTickEvent {
  type: 'slumber-tick';
  agent: string;
  productive: boolean;
}

/** End SLUMBER mode with a digest. */
export interface SlumberEndEvent {
  type: 'slumber-end';
  digest: string;
  totalTicks: number;
  productiveTicks: number;
}

/** System message in a channel (e.g., onboarding kickoff). */
export interface SystemMessageEvent {
  type: 'system-message';
  channel: string;
  content: string;
}

/** Wait for N milliseconds (no-op pause). */
export interface WaitEvent {
  type: 'wait';
  ms: number;
}

/** Switch the active TUI view. */
export interface ViewSwitchEvent {
  type: 'view-switch';
  view: 'corp-home' | 'chat' | 'clock' | 'task-board' | 'hierarchy';
  /** For chat view, which channel */
  channel?: string;
}

export type DemoEvent =
  | UserMessageEvent
  | DispatchStartEvent
  | StreamTokenEvent
  | StreamEndEvent
  | ToolCallEvent
  | AgentAppearEvent
  | TaskCreateEvent
  | TaskUpdateEvent
  | SlumberStartEvent
  | SlumberTickEvent
  | SlumberEndEvent
  | SystemMessageEvent
  | WaitEvent
  | ViewSwitchEvent;

/** A timed event — `at` is ms from scenario start. */
export interface TimedEvent {
  /** Milliseconds from scenario start */
  at: number;
  /** The event payload */
  event: DemoEvent;
}

// ── Scenario ────────────────────────────────────────────────────────

/** A complete demo scenario. */
export interface Scenario {
  /** Unique scenario name (used as filename) */
  name: string;
  /** Display title shown in cc-cli demo list */
  title: string;
  /** One-line description */
  description: string;
  /** Total duration in seconds (used for progress bar) */
  durationSec: number;
  /** Setup actions before playback starts */
  setup: ScenarioSetup;
  /** Timed events to execute in order */
  events: TimedEvent[];
}

/** Pre-playback corp setup. */
export interface ScenarioSetup {
  /** Demo corp name (created in ~/.claudecorp/<name>/) */
  corpName: string;
  /** Theme for the corp */
  theme?: 'corporate' | 'mafia' | 'military';
  /** Founder display name */
  founderName?: string;
  /** Pre-existing agents to seed (CEO is always created) */
  agents?: Array<{
    id: string;
    displayName: string;
    rank: 'leader' | 'worker';
  }>;
  /** Channels to pre-create beyond #general and DMs */
  channels?: string[];
}

// ── Player config ───────────────────────────────────────────────────

export interface PlayerOptions {
  /** Path to scenario file */
  scenarioPath: string;
  /** Playback speed multiplier (1.0 = normal, 2.0 = 2x faster, 0.5 = half speed) */
  speed: number;
  /** Daemon HTTP base URL (e.g., http://127.0.0.1:54425) */
  daemonUrl: string;
  /** Corp root directory */
  corpRoot: string;
  /** Pause at this offset (seconds) for screenshot */
  pauseAtSec?: number;
  /** Don't delete the demo corp on exit */
  noCleanup?: boolean;
}

/** Realistic typing speeds (ms per character) for char-by-char streaming. */
export const TYPING_SPEED = {
  fast: 15,      // fast model, confident
  normal: 30,    // typical
  slow: 50,      // thoughtful
} as const;
