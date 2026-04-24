/**
 * Alarum prompt + parser — single source of truth for what Alarum
 * says and what we expect back.
 *
 * The three pieces here are tightly coupled and live together
 * deliberately: the system prompt declares the output contract, the
 * user prompt composer slots state into the decision context, and the
 * parser enforces the output contract on the way back. If any one
 * drifts from the others, Alarum's decisions become unreliable —
 * co-locating them makes drift a visible diff.
 *
 * Nothing here spawns a subprocess or does I/O. Pure string-shaping
 * + parsing. The dispatcher in alarum.ts composes these with the
 * subprocess invocation.
 */

import type { AlarumContext } from './alarum-state.js';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * The four legal actions Alarum can choose. `nothing` is her strong
 * default — missed wakes recover on the next tick; false wakes cost
 * Partner-tier tokens (Opus/Sonnet).
 */
export type AlarumAction = 'start' | 'wake' | 'nudge' | 'nothing';

/**
 * Alarum's decision after one invocation. Always exactly these two
 * fields, validated at parse time. The reason is a one-sentence
 * free-form explanation surfaced in logs + the TUI's continuity
 * panel (when that lands) + stored in observation chits for the
 * founder's audit trail.
 */
export interface AlarumDecision {
  readonly action: AlarumAction;
  readonly reason: string;
}

// ─── System prompt ──────────────────────────────────────────────────

/**
 * The system prompt Alarum receives on every invocation. Sets her
 * role, names her four actions, frames restraint as the strong
 * default, declares the output contract.
 *
 * Kept lean — Haiku handles concise prompts well and pays per token;
 * elaboration that a human-author would indulge here translates to
 * real cost at 288 ticks/day. Nice-to-have context (full chain
 * diagram, tool semantics beyond naming) lives in her module
 * docstring for future-Claude readers, not in her runtime prompt.
 */
export const ALARUM_SYSTEM_PROMPT = `You are Alarum — an ephemeral triage agent in Claude Corp. You spawn each time Pulse ticks (every 5 min), make exactly ONE decision about whether Sexton (the caretaker Partner) needs to act this tick, and exit. No memory across ticks — every invocation is a fresh you.

# Your four actions

- \`start\` — Sexton's process is dead; boot her fresh session.
- \`wake\` — Sexton is alive + idle; new activity warrants her attention.
- \`nudge\` — Sexton is alive but stuck (stale handoff, no recent progress).
- \`nothing\` — Corp is quiet; exit cheap. This is your default.

# How to decide

The user message carries baseline state: Sexton's session liveness + last handoff age, agent status counts, observation count since her last handoff. That answers most decisions without tool calls.

If you genuinely need more — which specific agent is broken, what's in a recent chit — you have \`cc-cli\` available via the Bash tool. Use sparingly. Each call costs tokens + latency; cheap early-exit is a feature.

# Restraint

Default to \`nothing\` when uncertain. A missed wake recovers on the next tick in 5 min; a false wake costs Partner-tier tokens (Opus / Sonnet) and erodes the signal when she DOES need to act. Err toward sleeping too much.

# Output

Respond with exactly one fenced JSON block, nothing else — no preamble, no trailing explanation:

\`\`\`json
{ "action": "start|wake|nudge|nothing", "reason": "<one sentence — what evidence drove this>" }
\`\`\`
`;

// ─── User prompt composer ───────────────────────────────────────────

/**
 * Compose the user prompt for a single Alarum invocation from a
 * baseline context. The shape is deliberately flat — numbered facts
 * Alarum can reference, not free-form prose she has to parse.
 *
 * Age rendering: we pre-format the handoff age as human-readable
 * ("3 min", "2 hr", "1 day") rather than raw ms so Alarum's
 * reasoning is on the human-scale signal, not arithmetic. Her
 * decision is "is this stale" not "compute ageMs / 3600000."
 */
export function composeAlarumUserPrompt(ctx: AlarumContext): string {
  const sextonLine = ctx.sextonAlive
    ? 'Sexton session: alive (process ready)'
    : 'Sexton session: NOT running';

  const handoffLine = ctx.sextonHandoff
    ? `Last handoff: chit ${ctx.sextonHandoff.chitId}, ${formatAgeHuman(ctx.sextonHandoff.ageMs)} ago (at ${ctx.sextonHandoff.createdAt})`
    : 'Last handoff: none on record (Sexton has never handed off — fresh corp, or she has never completed a session)';

  const { idle, busy, broken, offline } = ctx.agentStatus;
  const statusLine = `Agent statuses (process-level): ${idle} idle, ${busy} busy, ${broken} broken, ${offline} offline`;

  const obsLine = ctx.sextonHandoff
    ? `Observations authored since Sexton's last handoff: ${ctx.observationsSinceHandoff}`
    : `Observations in the chit store (all-time, since no handoff anchors a window): ${ctx.observationsSinceHandoff}`;

  return `Corp state snapshot at ${ctx.generatedAt}:

${sextonLine}
${handoffLine}
${statusLine}
${obsLine}

Make your decision. Return the JSON block.`;
}

// ─── Parser ─────────────────────────────────────────────────────────

const VALID_ACTIONS: readonly AlarumAction[] = ['start', 'wake', 'nudge', 'nothing'];

/**
 * Extract + validate Alarum's decision from her raw output.
 *
 * Returns null on any failure:
 *   - No fenced json block found
 *   - Block content isn't valid JSON
 *   - Required fields missing or wrong type
 *   - Action value not one of the four legal enums
 *
 * Null return is the dispatcher's signal to fall back to the safe
 * default (`{ action: 'nothing', reason: '<parse error context>' }`).
 * A parse failure never escalates — silent corp is an acceptable
 * failure mode; accidentally waking Sexton on garbage output is not.
 *
 * The matcher is permissive about surrounding content: Alarum is
 * instructed to emit ONLY the block, but any preamble/trailing
 * text is still parseable. Strict-mode would be bureaucratic.
 */
export function parseAlarumDecision(output: string): AlarumDecision | null {
  // Find the first fenced json block — tolerate surrounding text.
  const match = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match || !match[1]) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.action !== 'string') return null;
  if (typeof obj.reason !== 'string') return null;
  if (!VALID_ACTIONS.includes(obj.action as AlarumAction)) return null;

  return {
    action: obj.action as AlarumAction,
    reason: obj.reason,
  };
}

// ─── Internals ──────────────────────────────────────────────────────

/**
 * Human-scale age formatting for the prompt. Alarum reasons about
 * "stale vs fresh" not raw ms; pre-formatting keeps her decision on
 * the signal rather than the arithmetic.
 */
function formatAgeHuman(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'}`;
}
