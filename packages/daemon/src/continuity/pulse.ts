/**
 * Pulse — the daemon's mechanical meta-watchdog tick.
 *
 * ### Role in the continuity chain
 *
 * Pulse sits at the bottom of Project 1.9's three-tier wake architecture:
 *
 *     OS supervisor     → restarts daemon if killed
 *         Daemon         → runs Pulse
 *             Pulse       → ticks every N min, fires Alarum
 *                 Alarum   → ephemeral triage AI, decides whether to wake Sexton
 *                     Sexton → caretaker; walks patrol blueprints, dispatches sweepers
 *
 * Pulse's job is exactly one thing: tick at a known interval and invoke a
 * callback. It carries no judgment, no agent-specific logic, no dispatch
 * loops. It is small enough to basically never die, and the one thing it
 * does (call the callback) is mechanical enough that failures are
 * observable as "no ticks" in logs — a signal the OS supervisor can watch.
 *
 * ### Why this is a reshape, not a rewrite
 *
 * Pre-1.9, Pulse ran a smart two-state agent-heartbeat loop: every 5 min
 * it pinged each online agent (idle → "check your casket"; busy → "quick
 * HEARTBEAT_OK?"), tracked missed heartbeats, and escalated to CEO after
 * two misses. That behavior had real value (it surfaced stuck + dead
 * sessions in the absence of a caretaker), but it conflated two
 * concerns: (a) keeping a tick heartbeat alive in the daemon as the
 * unkillability anchor, and (b) reasoning about individual agent
 * responsiveness. Those are different jobs.
 *
 * Project 1.9 separates them:
 *   - (a) stays here as Pulse — tick-only, absolute minimum surface.
 *   - (b) moves up the stack: Alarum makes the per-tick judgment
 *     (does ANY agent need attention?), and if the answer is yes,
 *     Sexton's patrol cycle (via the `agentstuck` + `silentexit`
 *     sweepers) does the per-agent reasoning.
 *
 * This commit lands the reshape. Alarum wiring + Sexton runtime land in
 * subsequent commits of 1.9.3 and 1.9.4 respectively. Until then, Pulse
 * ticks into a no-op logger — observability without action.
 *
 * ### Behavioral gap during the PR series
 *
 * Between this commit and the Sexton-runtime PR landing, there is no
 * per-agent responsiveness check in the corp. Agents that silent-exit
 * won't get auto-restarted; stuck sessions won't get nudged. This is
 * an intentional intermediate state — Claude Corp has no real users
 * yet, and building the Alarum → Sexton → sweepers chain properly
 * matters more than preserving the 1.8-era heartbeat behavior during
 * the transition. When the chain completes, the corp regains
 * (and surpasses) the pre-1.9 self-heal surface.
 */

import type { Daemon } from '../daemon.js';
import { log, logError } from '../logger.js';
import { invokeAlarum } from './alarum.js';

/**
 * Tick cadence. 5 minutes is a reasonable default: short enough that a
 * stuck agent is caught within minutes, long enough that Alarum's
 * per-tick cost (one Haiku invocation) stays bounded — roughly 288 ticks
 * per day, which at Haiku's pricing is pennies per day even before
 * Alarum's early-exit-on-quiet path kicks in to skip most invocations.
 */
const TICK_INTERVAL_MS = 5 * 60 * 1000;

export class Pulse {
  private daemon: Daemon;
  private interval: ReturnType<typeof setInterval> | null = null;

  /**
   * Monotonic tick counter — bumped on every tick, surfaces in logs so
   * a reader can verify Pulse is alive ("tick #142" vs "tick #0"
   * stalled). Never resets within a daemon's lifetime; resets on
   * daemon restart (observable in the jump back to 0 in logs).
   */
  private tickCount = 0;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    this.interval = this.daemon.clocks.register({
      id: 'pulse-tick',
      name: 'Pulse Tick',
      type: 'heartbeat',
      intervalMs: TICK_INTERVAL_MS,
      target: 'alarum',
      description: 'Fires Alarum each tick; Alarum decides whether to wake Sexton.',
      callback: () => this.tick(),
    });
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  /**
   * One tick of the continuity chain. Bumps the tick counter, logs it,
   * invokes Alarum for a triage decision. Alarum's decision is logged
   * here; actually acting on it (spawning Sexton, sending her a wake
   * message) is PR 2's Sexton-runtime territory. For 1.9.3 the chain
   * stops at "decision logged" — observable, testable, inert.
   *
   * Never throws: any error bubbling out of invokeAlarum is caught +
   * logged + swallowed. The dispatcher itself already has safe-default
   * fallback on every exec/parse failure, so this guard is defense-
   * in-depth — Pulse's one job (keep ticking) must be unkillable
   * regardless of what happens above it. A broken Alarum takes itself
   * down, not the tick.
   */
  private async tick(): Promise<void> {
    this.tickCount++;
    log(`[pulse] tick #${this.tickCount}`);

    try {
      const decision = await invokeAlarum(this.daemon);
      log(`[pulse] tick #${this.tickCount} → alarum decision: ${decision.action} (${decision.reason})`);
      // TODO(1.9.4 — Sexton runtime): route non-'nothing' decisions
      // into Sexton's wake/start/nudge paths. For now the decision is
      // logged and dropped; Sexton's runtime lands in the next PR.
    } catch (err) {
      // Defense-in-depth: invokeAlarum is supposed to never reject
      // (it catches + returns a safe default), but if it does anyway,
      // swallow the error here so Pulse's tick loop keeps running.
      logError(`[pulse] tick #${this.tickCount} alarum invocation threw (dispatcher bug): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
