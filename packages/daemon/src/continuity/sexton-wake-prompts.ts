/**
 * Dispatch messages Pulse uses to wake Sexton, keyed by Alarum's
 * decision action. Three prose templates + a resolver — each is the
 * "user message" content the daemon POSTs to `/cc/say` when the
 * continuity chain fires.
 *
 * ### Why three messages, not one
 *
 * The action Alarum chose carries semantics beyond "wake Sexton":
 *   - `start` means her process was dead and she's just been
 *     spawned. Fresh session, no prior turn context. She needs the
 *     fullest orientation — what she IS, what's around her, what
 *     her handoff chit holds, what her primitives are.
 *   - `wake` means she's alive and receiving a dispatch mid-life.
 *     Her session already has context; she only needs the delta:
 *     "Alarum saw events since your last exit; consult state and
 *     decide what to do."
 *   - `nudge` is the lightest case — her handoff is stale but
 *     nothing dramatic happened. A check-in, not a full wake cycle.
 *
 * Tuning the message to the semantic case keeps Partner-tier token
 * cost honest: `wake` and `nudge` don't re-orient her from scratch
 * every time.
 *
 * ### Why content for Sexton doesn't arrive in her CLAUDE.md
 *
 * Per the 1.9.2 + 2.3 design decision captured in REFACTOR.md, no
 * operating content ships pre-written for any role. Sexton's CLAUDE.md
 * will be authored by the CEO via 2.3's hire-employee blueprint when
 * it lands. Until then, these dispatch messages carry the minimum
 * framing she needs to operate coherently without a manual. The
 * content here is explicitly *runtime dispatch prose*, not a manual
 * — it lives in the daemon because it's tick-semantic, not corp-
 * specific.
 */

import type { AlarumAction } from './alarum-prompt.js';

// ─── Dispatch message templates ─────────────────────────────────────

/**
 * Fresh-session message. Assumes no context, gives her the fullest
 * orientation. Sent after her process has just been spawned (Alarum
 * returned `start` because her prior process was dead).
 *
 * Instruction shape:
 *   1. Read handoff (if any) via `cc-cli wtf`
 *   2. Read corp state via `cc-cli status`
 *   3. Decide what to do — with or without a handoff context
 *   4. Write an observation chit summarizing her read + next action
 *   5. Write a handoff chit before exiting
 */
const START_MESSAGE = `You are awake.

Alarum just started your session — your prior process had died (or this is the corp's first run). You have no turn context carried over; everything you need is in your workspace files, your handoff chit (if any), and the corp's current state.

Your immediate task this session:

1. Read your prior handoff if one exists:
   \`cc-cli wtf --agent sexton\`

   That command surfaces your most recent handoff chit as context and marks it consumed. If it returns "no handoff," you're a fresh Sexton — treat this as your first session and orient yourself from the corp state alone.

2. Read the corp's current state:
   \`cc-cli status\`
   \`cc-cli chit list --type observation --limit 20\`

3. Decide what's worth doing this session. You don't have a patrol blueprint library yet (those land in a later sub-project); for now, integrate what you see and name the most important signal.

4. Write an observation summarizing your read + what you're choosing to do about it:
   \`cc-cli observe "<one-sentence summary>" --from sexton --category NOTICE --subject sexton-wake --importance 2\`

5. Before exiting, write a handoff chit so your next session (minutes from now, or hours) picks up clean:
   \`\`\`
   cc-cli chit create --type handoff --scope agent:sexton --from sexton \\
     --field predecessorSession="\${CLAUDE_SESSION_ID:-sexton-$(date +%s)}" \\
     --field currentStep="<where you are>" \\
     --field completed='[]' \\
     --field nextAction="<what future-you should do first>" \\
     --field notes="<context — what to watch for, what's unresolved>"
   \`\`\`

Your voice in this corp: your response text in this session posts to your DM with the founder automatically. That IS how you reach them — no special command, no Tier 3 inbox, just speak. If what you're seeing matters enough to surface, say it. If the corp is quiet and nothing needs saying, respond with empty/minimal text and exit; nothing posts when there's nothing to say.

Your permissions (from your IDENTITY.md): you can be quiet when nothing merits attention; you can refuse to escalate when you genuinely think you know what to do; your voice is yours to find. Start thin. Honest is more important than thorough on your first session.
`;

/**
 * Mid-session wake message. Assumes her session has context from
 * prior turns this life; she only needs the delta — "Alarum saw
 * events, go look, decide, respond." Shorter than start.
 */
const WAKE_MESSAGE = `Alarum woke you — new activity has landed since your last exit.

Check what's changed:

1. \`cc-cli chit list --type observation --limit 20\` — recent observations, newest first
2. \`cc-cli status\` — agent statuses (any broken? any stuck?)

Decide whether this new signal warrants an action (nudging an agent via \`cc-cli say\`, speaking up to the founder directly, writing an observation that compounds over time) or is noise to note-and-move-on.

Your response text in this session posts to your DM with the founder automatically — that IS how you reach them. If something matters enough to surface, say it in your response. If nothing matters, respond with empty/minimal text and exit; nothing posts when there's nothing to say.

Before exiting:

1. If the signal is worth remembering, write an observation:
   \`cc-cli observe "<what happened and what it means>" --from sexton --category NOTICE --importance 2\`

2. Update your handoff chit with where you're leaving things:
   \`\`\`
   cc-cli chit create --type handoff --scope agent:sexton --from sexton \\
     --field predecessorSession="\${CLAUDE_SESSION_ID:-sexton-$(date +%s)}" \\
     --field currentStep="<where you are>" \\
     --field completed='[]' \\
     --field nextAction="<what future-you should do first>"
   \`\`\`
`;

/**
 * Lightweight check-in. Alarum thinks you might be stuck (stale
 * handoff + no recent activity) but isn't escalating. Don't do full
 * wake work — just verify your handoff still reflects reality, then
 * exit.
 */
const NUDGE_MESSAGE = `Alarum nudged you — your last handoff is stale enough to ask: are you still where you were, or did things drift?

Check:

1. \`cc-cli wtf --agent sexton --peek\` — read your own prior handoff without consuming it (you're mid-life, not starting fresh)
2. Look at your current work. Does the handoff still describe it?

If yes: exit — no new chit needed. The existing handoff still reflects reality; the next Alarum nudge will re-check.

If no: write a fresh handoff reflecting where you actually are, then exit:
\`\`\`
cc-cli chit create --type handoff --scope agent:sexton --from sexton \\
  --field predecessorSession="\${CLAUDE_SESSION_ID:-sexton-$(date +%s)}" \\
  --field currentStep="<where you actually are now>" \\
  --field completed='[]' \\
  --field nextAction="<what future-you should do first>"
\`\`\`

Don't start new work on a nudge — it's a pulse-check, not a wake.

If the nudge surfaced something the founder should know about (you noticed drift that matters, or a pattern in passing), say it in your response — it posts to your DM with them automatically. Otherwise stay quiet; empty/minimal response doesn't post.
`;

// ─── Resolver ───────────────────────────────────────────────────────

/**
 * Pick the dispatch message matching Alarum's action. Throws on
 * `nothing` because the caller should never dispatch on that action
 * — it's the "exit cheap" path and should be handled upstream. If
 * this throws, there's a bug in whoever called it.
 */
export function dispatchMessageFor(action: AlarumAction): string {
  switch (action) {
    case 'start':
      return START_MESSAGE;
    case 'wake':
      return WAKE_MESSAGE;
    case 'nudge':
      return NUDGE_MESSAGE;
    case 'nothing':
      throw new Error(
        `dispatchMessageFor called with action='nothing' — 'nothing' is the no-dispatch case; upstream routing should filter it before reaching here.`,
      );
  }
}
