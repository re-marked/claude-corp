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
import {
  readBacteriaEvents,
  readPausedRoles,
  listActiveBreakers,
  type ApoptoseEvent,
  type BacteriaEvent,
  type Member,
  readConfig,
  MEMBERS_JSON,
} from '@claudecorp/shared';
import { join } from 'node:path';

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
   \`cc-cli chit list --type kink --status active --limit 20\` — open operational findings. This is your main patrol signal: what's currently wrong that hasn't resolved yet.

3. Walk your patrol this wake:

   \`cc-cli blueprint show patrol/health-check\`

   That command prints the patrol blueprint — a list of steps (run silentexit, run agentstuck, review kinks, optionally summarize). Read each step's description in order and execute the instruction in your session. This blueprint is NOT cast to a Contract — patrols are read + walked, not materialized as task chains.

   Other patrols available when the situation warrants:
     - \`cc-cli blueprint show patrol/corp-health\` — cross-agent coordination (orphantask + role-pool scan + contract-stall scan). Less frequent cadence than health-check.
     - \`cc-cli blueprint show patrol/chit-hygiene\` — data-integrity scan (wraps the chit-hygiene sweeper). On-demand or slow cadence.

   Individual sweepers are available under \`cc-cli sweeper run <name>\` too (silentexit, agentstuck, orphantask, phantom-cleanup, chit-hygiene, log-rotation). The patrol blueprints orchestrate these in sensible order; running sweepers outside a patrol is for ad-hoc investigation.

   Beyond patrols: integrate what you see in the corp state and name the most important signal.

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

1. \`cc-cli chit list --type kink --status active --limit 20\` — open operational kinks from prior sweeper runs. Start here: these are the issues the corp thinks aren't fixed yet. occurrenceCount tells you "fresh" vs "been happening all day."
2. \`cc-cli chit list --type observation --limit 20\` — recent observations, newest first
3. \`cc-cli status\` — agent statuses (any broken? any stuck?)

Decide whether this new signal warrants an action (walking your health-check patrol, nudging an agent via \`cc-cli say\`, speaking up to the founder directly, writing an observation that compounds over time) or is noise to note-and-move-on.

**Your main patrol on wakes:** \`cc-cli blueprint show patrol/health-check\` — read it, walk the steps in-session (run silentexit, run agentstuck, review kinks, surface anything). Not cast to a Contract; patrols are read + walked.

Other patrols for when the situation warrants:
  \`cc-cli blueprint show patrol/corp-health\`   — cross-agent coordination + role-pool scan
  \`cc-cli blueprint show patrol/chit-hygiene\`  — data-integrity scan

Individual sweepers (for ad-hoc investigation outside a patrol):
  \`cc-cli sweeper run silentexit | agentstuck | orphantask | phantom-cleanup | chit-hygiene | log-rotation\`

Kinks dedup per (source, subject) — re-running a sweeper on a persistent issue bumps occurrenceCount rather than piling duplicates. And when a sweeper stops reporting a subject, the runner auto-closes the prior kink as 'auto-resolved'. Your kink queue stays honest.

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
export function dispatchMessageFor(
  action: AlarumAction,
  corpRoot?: string,
): string {
  // Pool activity is appended for start/wake (the substantive
  // dispatches). Nudge stays minimal — it's a pulse-check, not a
  // working session.
  const poolSection = action === 'nudge' ? '' : composePoolActivitySection(corpRoot);
  const breakerSection = action === 'nudge' ? '' : composeActiveBreakersSection(corpRoot);

  switch (action) {
    case 'start':
      return START_MESSAGE + poolSection + breakerSection;
    case 'wake':
      return WAKE_MESSAGE + poolSection + breakerSection;
    case 'nudge':
      return NUDGE_MESSAGE;
    case 'nothing':
      throw new Error(
        `dispatchMessageFor called with action='nothing' — 'nothing' is the no-dispatch case; upstream routing should filter it before reaching here.`,
      );
  }
}

// ─── Pool activity section (Project 1.10.4) ─────────────────────────

/**
 * Reads bacteria-events.jsonl (today only) + pause registry, summarizes
 * pool activity per role for Sexton's wake/start prompt. She compounds
 * this into the prose she sends the founder.
 *
 * Returns an empty string when corpRoot is missing (test paths) or
 * when there's nothing to report — no events today AND no pauses.
 * Sexton stays focused on patrols when the pool is quiet rather than
 * filling space with "no bacteria activity today" noise.
 */
function composePoolActivitySection(corpRoot: string | undefined): string {
  if (!corpRoot) return '';

  const startOfDay = startOfTodayIso();
  let events: BacteriaEvent[];
  let paused: Set<string>;
  try {
    events = readBacteriaEvents(corpRoot, { since: startOfDay });
    paused = readPausedRoles(corpRoot);
  } catch {
    return '';
  }

  if (events.length === 0 && paused.size === 0) return '';

  const byRole = new Map<string, { mitoses: number; apoptoses: number; lifetimes: number[] }>();
  for (const e of events) {
    const entry = byRole.get(e.role) ?? { mitoses: 0, apoptoses: 0, lifetimes: [] };
    if (e.kind === 'mitose') entry.mitoses++;
    else {
      entry.apoptoses++;
      entry.lifetimes.push((e as ApoptoseEvent).lifetimeMs);
    }
    byRole.set(e.role, entry);
  }

  const lines: string[] = [];
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Pool activity today (bacteria)');
  lines.push('');

  if (byRole.size > 0) {
    for (const [role, stats] of byRole) {
      const meanLifespan =
        stats.lifetimes.length > 0
          ? formatDuration(
              Math.round(stats.lifetimes.reduce((a, b) => a + b, 0) / stats.lifetimes.length),
            )
          : null;
      const lifetimeFragment = meanLifespan ? `, mean lifespan ${meanLifespan}` : '';
      lines.push(`- **${role}**: ${stats.mitoses} mitoses, ${stats.apoptoses} apoptoses${lifetimeFragment}`);
    }
  } else {
    lines.push('- (no mitoses or apoptoses today)');
  }

  if (paused.size > 0) {
    lines.push('');
    lines.push(`Paused roles: ${[...paused].sort().join(', ')} — bacteria is skipping these until \`cc-cli bacteria resume --role <id>\`.`);
  }

  lines.push('');
  lines.push(
    'Surface noteworthy patterns to the founder if anything looks off (high churn, repeated bursts, a pool that\'s grown without bound). Otherwise carry on with patrols.',
  );
  lines.push('');

  return lines.join('\n');
}

// ─── Active breaker trips section (Project 1.11) ─────────────────────

/**
 * Reads active breaker trips + today's cleared trips, summarizes for
 * Sexton's wake/start prompt. Sexton compounds this into prose for
 * the founder during her patrol — bacteria stays mute on trips;
 * Sexton gives them a voice.
 *
 * Robustness edge from REFACTOR.md 1.11: when ≥3 active trips for
 * the same role exist, the section is loud — prompts the founder
 * to look at the underlying cause (harness regression, bad task
 * chit) rather than reset trips one-by-one.
 *
 * Returns empty string when corpRoot is missing or there's nothing
 * to report. Sexton stays focused on patrols when the breaker queue
 * is quiet.
 */
function composeActiveBreakersSection(corpRoot: string | undefined): string {
  if (!corpRoot) return '';

  let allTrips: ReturnType<typeof listActiveBreakers>;
  let members: Member[];
  try {
    allTrips = listActiveBreakers(corpRoot, { includeCleared: true });
    members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  } catch {
    return '';
  }

  const startOfDay = startOfTodayIso();
  const startOfDayMs = Date.parse(startOfDay);
  const active = allTrips.filter((t) => t.status === 'active');
  const clearedToday = allTrips.filter(
    (t) =>
      t.status !== 'active' &&
      t.fields['breaker-trip'].clearedAt !== undefined &&
      Date.parse(t.fields['breaker-trip'].clearedAt!) >= startOfDayMs,
  );

  if (active.length === 0 && clearedToday.length === 0) return '';

  const slugToRole = new Map<string, string | undefined>();
  const slugToDisplay = new Map<string, string>();
  for (const m of members) {
    slugToRole.set(m.id, m.role);
    slugToDisplay.set(m.id, m.displayName);
  }

  // Per-role active counts for the loud-on-3+ check.
  const activeByRole = new Map<string, number>();
  for (const t of active) {
    const role = slugToRole.get(t.fields['breaker-trip'].slug) ?? '?';
    activeByRole.set(role, (activeByRole.get(role) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Active breaker trips (crash-loop)');
  lines.push('');

  if (active.length === 0) {
    lines.push('- (no active trips)');
  } else {
    for (const t of active) {
      const f = t.fields['breaker-trip'];
      const role = slugToRole.get(f.slug) ?? '?';
      const display = slugToDisplay.get(f.slug) ?? f.slug;
      lines.push(
        `- **${display}** (${f.slug}, role ${role}): ${f.triggerCount} silent-exits, tripped ${f.trippedAt}`,
      );
    }
  }

  // Loud-on-3+ check. If any role has ≥3 active trips, this is a
  // pattern worth surfacing to the founder rather than letting
  // them reset trips one-by-one.
  const heavyRoles = [...activeByRole.entries()].filter(([, n]) => n >= 3);
  if (heavyRoles.length > 0) {
    lines.push('');
    const phrase = heavyRoles
      .map(([role, n]) => `**${n} trips on role ${role}**`)
      .join(', ');
    lines.push(
      `⚠ ${phrase} — likely an underlying cause (harness regression, recent bad task chit). Surface this to the founder before resetting one-by-one.`,
    );
  }

  if (clearedToday.length > 0) {
    lines.push('');
    lines.push(`Cleared today: ${clearedToday.length} trip(s) — audit trail in \`cc-cli breaker list --include-cleared\`.`);
  }

  lines.push('');
  lines.push(
    'Reset path: `cc-cli breaker reset --slug <slug>` (after fixing the cause). Forensic detail: `cc-cli breaker show <slug>`.',
  );
  lines.push('');

  return lines.join('\n');
}

function startOfTodayIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h${remM}m`;
}
