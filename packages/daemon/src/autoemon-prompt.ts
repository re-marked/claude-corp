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

/**
 * Build a single tick message.
 * The simplest case: just the local time wrapped in XML.
 */
export function buildTickMessage(opts: {
  /** Founder's current presence */
  presence: FounderPresence;
  /** Result from a previous backgrounded tick (if any) */
  previousResult?: string;
  /** Current local time (defaults to now) */
  time?: Date;
}): string {
  const time = opts.time ?? new Date();
  const timeStr = time.toLocaleTimeString('en-US', { hour12: false });

  const parts: string[] = [];

  // Previous backgrounded tick result (if any)
  if (opts.previousResult) {
    parts.push(`<previous-tick-result>${opts.previousResult}</previous-tick-result>`);
  }

  // The tick itself — just the time
  parts.push(`<tick>${timeStr}</tick>`);

  // Founder presence — how autonomous the agent should be
  parts.push(`<presence>${opts.presence}</presence>`);

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
  /** Time of the latest tick */
  time?: Date;
}): string {
  const time = opts.time ?? new Date();
  const timeStr = time.toLocaleTimeString('en-US', { hour12: false });

  const parts: string[] = [];

  if (opts.previousResult) {
    parts.push(`<previous-tick-result>${opts.previousResult}</previous-tick-result>`);
  }

  // Batched ticks — just show the latest with a note
  if (opts.batchCount > 1) {
    parts.push(`<tick batched="${opts.batchCount}">${timeStr}</tick>`);
  } else {
    parts.push(`<tick>${timeStr}</tick>`);
  }

  parts.push(`<presence>${opts.presence}</presence>`);

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
}): string {
  const time = new Date();
  const timeStr = time.toLocaleTimeString('en-US', { hour12: false });

  const sourceLabel = {
    slumber: 'SLUMBER mode',
    manual: 'autoemon mode (manual)',
    afk: 'AFK mode',
  }[opts.source];

  return [
    `<tick first="true">${timeStr}</tick>`,
    `<presence>${opts.presence}</presence>`,
    `<session-start>`,
    `You are entering ${sourceLabel}. You will receive periodic <tick> prompts.`,
    `On each tick, look for useful work. If nothing needs attention, SLEEP.`,
    `Read your Casket (TASKS.md, INBOX.md, WORKLOG.md) to orient.`,
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
  const timeStr = time.toLocaleTimeString('en-US', { hour12: false });

  return [
    `<tick>${timeStr}</tick>`,
    `<presence>${opts.presence}</presence>`,
    `<compaction-recovery>`,
    `Your context was compacted. You were already working autonomously — this is NOT a first wake-up.`,
    `Session stats: ${opts.tickCount} ticks fired, ${opts.productiveCount} productive.`,
    `Read your observations log and WORKLOG.md to pick up where you left off.`,
    `Continue your work. Do not greet the user or ask what to work on.`,
    `</compaction-recovery>`,
  ].join('\n');
}
