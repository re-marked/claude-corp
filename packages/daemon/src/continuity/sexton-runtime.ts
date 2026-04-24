/**
 * Sexton runtime — the dispatcher that closes the continuity chain.
 *
 * ### What this ships
 *
 * One function, `dispatchSexton(daemon, decision)`, that turns an
 * `AlarumDecision` into a real dispatch against Sexton's session:
 *
 *   - `nothing` → no-op (defensive; upstream should filter too)
 *   - `start`   → spawn Sexton's process if dead, then dispatch START_MESSAGE
 *   - `wake`    → dispatch WAKE_MESSAGE to her running session
 *   - `nudge`   → dispatch NUDGE_MESSAGE (lightest case)
 *
 * Routes through the daemon's existing `/cc/say` HTTP endpoint (same
 * path dreams uses for its agent dispatch), which hands off to the
 * dispatch → processManager → harness chain. dispatchSexton is pure
 * plumbing — it doesn't own Sexton's session lifecycle itself, just
 * triggers the right dispatch for the right decision.
 *
 * ### Busy-skip
 *
 * If Sexton is currently 'busy' (mid-turn on a prior dispatch), this
 * function skips and logs. Alarum's next tick (5 min later) will see
 * her as busy via `agentStatusCounts` and pick `nothing` anyway —
 * the double-check here is defense-in-depth against Alarum occasionally
 * returning `wake` on a tick where she's already working.
 *
 * ### Fail-soft
 *
 * Every error path logs + returns cleanly. Sexton-dispatch failures
 * must never propagate up to Pulse — Pulse's tick loop has to keep
 * running regardless of what happens above it. The dispatcher is the
 * continuity chain's highest-risk surface (network call, process
 * spawn, subprocess); guarding it aggressively is the cost of
 * putting it between Pulse (must-not-die) and the agent layer.
 */

import { readConfig, agentSessionKey, type Member, type Channel, MEMBERS_JSON, CHANNELS_JSON } from '@claudecorp/shared';
import { join } from 'node:path';
import type { Daemon } from '../daemon.js';
import { log, logError } from '../logger.js';
import type { AlarumDecision } from './alarum-prompt.js';
import { dispatchMessageFor } from './sexton-wake-prompts.js';

/**
 * Dispatch timeout for the /cc/say POST. Sexton's turn (read handoff,
 * decide, write observation, write handoff) typically completes in
 * 15-60s depending on model + tool-call count. 120s is generous. If
 * she's genuinely stuck past that, Alarum's next tick will see her
 * 'busy' and pick `nothing`; the dispatch request is canceled via
 * AbortSignal.
 */
const DISPATCH_TIMEOUT_MS = 120_000;

/**
 * Route an Alarum decision to Sexton. Never throws — every failure
 * path is logged and swallowed. Pulse's tick loop depends on this.
 */
export async function dispatchSexton(
  daemon: Daemon,
  decision: AlarumDecision,
): Promise<void> {
  // Filter `nothing` defensively — Pulse already filters this case,
  // but guarding here means an upstream bug doesn't cascade into a
  // pointless member lookup + spawn attempt.
  if (decision.action === 'nothing') return;

  let sexton: Member;
  try {
    const members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
    // Filter out archived (fired) Sextons — if the founder fired Sexton,
    // every Pulse tick would otherwise try to respawn her, defeating
    // the fire action. Status === 'archived' means "retired, don't
    // touch"; we treat it the same as "no Sexton exists."
    const found = members.find(
      (m) => m.displayName === 'Sexton' && m.type === 'agent' && m.status !== 'archived',
    );
    if (!found) {
      logError(
        `[continuity] dispatchSexton: no active Sexton member found (either not hired yet, or fired — archived). Skipping dispatch.`,
      );
      return;
    }
    sexton = found;
  } catch (err) {
    logError(`[continuity] dispatchSexton: members.json read failed — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Busy-skip: if Sexton's already mid-turn on a prior dispatch,
  // don't pile another on. Alarum's next tick catches up.
  const workStatus = daemon.getAgentWorkStatus(sexton.id);
  if (workStatus === 'busy') {
    log(
      `[continuity] dispatchSexton: Sexton is busy on a prior turn — skipping ${decision.action} (Alarum's next tick will re-evaluate)`,
    );
    return;
  }

  // For 'start', ensure her process is up. For 'wake'/'nudge', assume
  // it's already running — Alarum returned these actions because she
  // saw Sexton's process as ready. If it's died between Alarum's
  // state-read and this dispatch (rare race), spawnAgent below is
  // idempotent for the 'already running' case and will just log.
  if (decision.action === 'start') {
    const proc = daemon.processManager.getAgent(sexton.id);
    if (!proc || proc.status !== 'ready') {
      try {
        log(`[continuity] dispatchSexton: spawning Sexton process for 'start' decision`);
        await daemon.processManager.spawnAgent(sexton.id);
      } catch (err) {
        logError(
          `[continuity] dispatchSexton: failed to spawn Sexton for 'start' — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
  }

  const message = dispatchMessageFor(decision.action);
  const sessionKey = agentSessionKey(sexton.displayName);

  // Resolve Sexton's DM channel with the founder so her response +
  // tool events stream where Mark can see them. Without this, her
  // patrol output lands only in the daemon log (first 80 chars) —
  // functionally mute. Same pattern dreams.ts uses.
  //
  // Fail-soft: if the channel can't be found (shouldn't happen post-
  // 1.1's hire flow that creates Partner/founder DMs, but be
  // defensive), dispatch without channelId. Her response only hits
  // the log as a fallback — degraded but not broken.
  let dmChannelId: string | undefined;
  try {
    const channels = readConfig<Channel[]>(join(daemon.corpRoot, CHANNELS_JSON));
    const allMembers = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
    const founder = allMembers.find((m) => m.rank === 'owner');
    const dm = channels.find(
      (c) =>
        c.kind === 'direct' &&
        c.memberIds.includes(sexton.id) &&
        (founder ? c.memberIds.includes(founder.id) : false),
    );
    dmChannelId = dm?.id;
    if (!dmChannelId) {
      log(`[continuity] dispatchSexton: no founder DM channel resolved for Sexton — dispatching without channelId (response will only hit daemon log)`);
    }
  } catch (err) {
    logError(
      `[continuity] dispatchSexton: channel resolution failed — ${err instanceof Error ? err.message : String(err)}. Dispatching without channelId.`,
    );
  }

  // Dispatch via /cc/say — same path dreams.ts uses, routes through
  // the harness + handles streaming / tool events / session
  // continuity transparently. We pass the target by memberId so the
  // endpoint doesn't re-resolve via displayName (faster + unambiguous
  // when multiple members could share a display name in edge cases).
  try {
    const resp = await fetch(`http://127.0.0.1:${daemon.getPort()}/cc/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: sexton.id,
        message,
        sessionKey,
        ...(dmChannelId !== undefined && { channelId: dmChannelId }),
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });

    const data = (await resp.json()) as { ok?: boolean; error?: string; response?: string };

    if (!data.ok) {
      logError(
        `[continuity] dispatchSexton: /cc/say rejected (${decision.action}) — ${data.error ?? 'unknown error'}`,
      );
      return;
    }

    log(
      `[continuity] dispatchSexton: ${decision.action} completed — Sexton response: ${(data.response ?? '').slice(0, 80)}`,
    );
  } catch (err) {
    // Timeout or network error. Non-fatal; next Pulse tick re-evaluates.
    logError(
      `[continuity] dispatchSexton: ${decision.action} dispatch failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
