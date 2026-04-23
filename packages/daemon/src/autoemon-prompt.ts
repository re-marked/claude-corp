/**
 * Autoemon Prompt — tick message builder.
 *
 * Builds the `<tick>` XML messages that agents receive during autonomous mode.
 * Borrowed from Claude Code's `cli/print.ts:1845` tick format and
 * `constants/prompts.ts:860-913` proactive system prompt.
 *
 * Tick format: <tick>14:30:00</tick>
 * With presence: <tick>14:30:00</tick><presence>away</presence>
 * With previous result: <previous-tick-result>...</previous-tick-result><tick>14:30:00</tick>
 *
 * The tick message is minimal by design — the agent's autoemon fragment
 * teaches it what to do. The tick just says "you're awake, what now?"
 */

// ── Founder Presence ───────────────────────────────────────────────

export type FounderPresence = 'watching' | 'idle' | 'away';

// ── Tick Message Builders ──────────────────────────────────────────

/** Brief context snapshot to enrich ticks — saves agents from re-reading files every tick. */
export interface TickContext {
  /** Number of pending tasks assigned to this agent */
  pendingTasks?: number;
  /** Number of unread inbox items */
  unreadInbox?: number;
  /** What the agent was doing last tick (for continuity) */
  lastAction?: string;
  /** Current SLUMBER goal (if any) */
  goal?: string;
  /** Active profile mood — changes how the CEO behaves */
  mood?: string;
  /** Active profile focus directive — what to prioritize */
  focus?: string;
  /** Active profile name + icon for display */
  profileLabel?: string;
}

/** Format a timestamp that includes date (for midnight-crossing sessions). */
function formatTickTime(time: Date): string {
  const date = time.toISOString().slice(0, 10); // YYYY-MM-DD
  const clock = time.toLocaleTimeString('en-US', { hour12: false });
  return `${date} ${clock}`;
}

/** Build optional context attributes for the <tick> tag. */
function buildContextAttrs(ctx?: TickContext): string {
  if (!ctx) return '';
  const attrs: string[] = [];
  if (ctx.pendingTasks !== undefined) attrs.push(`tasks="${ctx.pendingTasks}"`);
  if (ctx.unreadInbox !== undefined) attrs.push(`inbox="${ctx.unreadInbox}"`);
  return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
}

/**
 * Build a single tick message.
 * Enriched beyond Claude Code's bare `<tick>time</tick>` with optional
 * context snapshot and continuity hints.
 */
export function buildTickMessage(opts: {
  /** Founder's current presence */
  presence: FounderPresence;
  /** Result from a previous backgrounded tick (if any) */
  previousResult?: string;
  /** Brief context snapshot (saves agent from re-reading files) */
  context?: TickContext;
  /** Current local time (defaults to now) */
  time?: Date;
}): string {
  const time = opts.time ?? new Date();
  const timeStr = formatTickTime(time);

  const parts: string[] = [];

  // Previous backgrounded tick result (if any)
  if (opts.previousResult) {
    parts.push(`<previous-tick-result>${opts.previousResult}</previous-tick-result>`);
  }

  // The tick itself — time + optional context attributes
  parts.push(`<tick${buildContextAttrs(opts.context)}>${timeStr}</tick>`);

  // Founder presence — how autonomous the agent should be
  parts.push(`<presence>${opts.presence}</presence>`);

  // Last action hint for continuity (if available)
  if (opts.context?.lastAction) {
    parts.push(`<last-action>${opts.context.lastAction}</last-action>`);
  }

  // SLUMBER goal reminder (if set)
  if (opts.context?.goal) {
    parts.push(`<goal>${opts.context.goal}</goal>`);
  }

  // Profile mood — changes how the agent behaves (the soul of profiles)
  if (opts.context?.mood) {
    parts.push(`<mood>${opts.context.mood}</mood>`);
  }

  // Profile focus — what to prioritize
  if (opts.context?.focus) {
    parts.push(`<focus>${opts.context.focus}</focus>`);
  }

  return parts.join('\n');
}

/**
 * Build a batched tick message (when multiple ticks were missed because
 * the agent was slow). Claude Code: "Multiple ticks may be batched into
 * a single message. This is normal — just process the latest one."
 */
export function buildBatchedTickMessage(opts: {
  /** Number of ticks that were batched */
  batchCount: number;
  /** Founder's current presence */
  presence: FounderPresence;
  /** Previous backgrounded result */
  previousResult?: string;
  context?: TickContext;
  /** Time of the latest tick */
  time?: Date;
}): string {
  const time = opts.time ?? new Date();
  const timeStr = formatTickTime(time);

  const parts: string[] = [];

  if (opts.previousResult) {
    parts.push(`<previous-tick-result>${opts.previousResult}</previous-tick-result>`);
  }

  // Batched ticks — just show the latest with a note
  if (opts.batchCount > 1) {
    parts.push(`<tick batched="${opts.batchCount}"${buildContextAttrs(opts.context)}>${timeStr}</tick>`);
  } else {
    parts.push(`<tick${buildContextAttrs(opts.context)}>${timeStr}</tick>`);
  }

  parts.push(`<presence>${opts.presence}</presence>`);

  return parts.join('\n');
}

/**
 * Build a sleep-wake tick — agent just woke up from a SLEEP.
 * Includes how long they slept and any events that occurred while sleeping.
 */
export function buildSleepWakeTick(opts: {
  presence: FounderPresence;
  /** How long the agent slept (ms) */
  sleptForMs: number;
  /** Why the agent woke up: timer expired, user input, urgent task */
  wakeReason: 'timer' | 'user_message' | 'urgent_task' | 'manual_wake';
  /** Brief summary of what happened while sleeping (new tasks, messages) */
  whileAsleep?: string;
  context?: TickContext;
}): string {
  const time = new Date();
  const timeStr = formatTickTime(time);
  const sleptMinutes = Math.round(opts.sleptForMs / 60_000);

  const wakeReasonLabel = {
    timer: 'sleep timer expired',
    user_message: 'founder sent a message',
    urgent_task: 'urgent task assigned',
    manual_wake: 'manual /wake command',
  }[opts.wakeReason];

  const parts: string[] = [];

  parts.push(`<tick${buildContextAttrs(opts.context)}>${timeStr}</tick>`);
  parts.push(`<presence>${opts.presence}</presence>`);
  parts.push(`<wake-up slept="${sleptMinutes}m" reason="${wakeReasonLabel}">`);

  if (opts.whileAsleep) {
    parts.push(`While you slept: ${opts.whileAsleep}`);
  }

  parts.push(`</wake-up>`);

  return parts.join('\n');
}

/**
 * Build the first tick message — includes a greeting instruction.
 * From Claude Code's proactive prompt:
 * "On your very first tick in a new session, greet the user briefly
 *  and ask what they'd like to work on."
 *
 * For SLUMBER mode, we adapt: don't ask what to work on (the contract
 * is already assigned), just acknowledge the session start.
 */
export function buildFirstTickMessage(opts: {
  presence: FounderPresence;
  /** Agent display name */
  agentName: string;
  /** How autoemon was activated */
  source: 'slumber' | 'manual' | 'afk';
  /** SLUMBER goal (if any) */
  goal?: string;
  /** Number of agents conscripted alongside this one */
  enrolledCount?: number;
  context?: TickContext;
}): string {
  const time = new Date();
  const timeStr = formatTickTime(time);

  const sourceLabel = {
    slumber: 'SLUMBER mode',
    manual: 'autoemon mode (manual)',
    afk: 'AFK mode',
  }[opts.source];

  const goalLine = opts.goal ? `\nGoal: "${opts.goal}"` : '';
  const enrolledLine = opts.enrolledCount && opts.enrolledCount > 1
    ? `\n${opts.enrolledCount} agents conscripted for this session.`
    : '';

  return [
    `<tick first="true"${buildContextAttrs(opts.context)}>${timeStr}</tick>`,
    `<presence>${opts.presence}</presence>`,
    `<session-start>`,
    `You are entering ${sourceLabel}. You will receive periodic <tick> prompts.${goalLine}${enrolledLine}`,
    `On each tick, look for useful work. If nothing needs attention, SLEEP with a reason.`,
    `Read your Casket (TASKS.md, INBOX.md, WORKLOG.md) to orient.`,
    `Write observations as you work: \`cc-cli observe "..." --from <you> --category <CAT>\`.`,
    `</session-start>`,
  ].join('\n');
}

/**
 * Build the compaction recovery tick — agent's context was compacted
 * mid-autoemon session. Tell it to continue, not restart.
 *
 * Adapted from Claude Code's `services/compact/prompt.ts:362-368`:
 * "You are running in autonomous/proactive mode. This is NOT a first
 *  wake-up — you were already working autonomously before compaction."
 */
export function buildCompactionRecoveryTick(opts: {
  presence: FounderPresence;
  /** Agent display name */
  agentName: string;
  /** How many ticks have fired so far */
  tickCount: number;
  /** How many were productive */
  productiveCount: number;
}): string {
  const time = new Date();
  const timeStr = formatTickTime(time);

  return [
    `<tick>${timeStr}</tick>`,
    `<presence>${opts.presence}</presence>`,
    `<compaction-recovery>`,
    `Your context was compacted. You were already working autonomously — this is NOT a first wake-up.`,
    `Session stats: ${opts.tickCount} ticks fired, ${opts.productiveCount} productive.`,
    `Read your recent observations (\`cc-cli chit list --type observation --scope agent:<you>\`) and WORKLOG.md to pick up where you left off.`,
    `Continue your work. Do not greet the user or ask what to work on.`,
    `</compaction-recovery>`,
  ].join('\n');
}
