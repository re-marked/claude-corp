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
 * Project 1.9 landed the reshape across a small PR series: 1.9.3 wired
 * Pulse → Alarum (decision-logged, no dispatch); 1.9.4 (this commit
 * closes it) wires Alarum → dispatchSexton so non-'nothing' decisions
 * actually spawn / wake / nudge Sexton's session. The chain from
 * Pulse tick to Sexton's dispatch is now whole. Per-agent sweepers
 * (the layer Sexton herself orchestrates) land in subsequent 1.9 PRs.
 */

import type { Daemon } from '../daemon.js';
import { log, logError } from '../logger.js';
import { invokeAlarum } from './alarum.js';
import { dispatchSexton } from './sexton-runtime.js';

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
   * invokes Alarum for a triage decision, and routes the decision to
   * Sexton via dispatchSexton. 'nothing' decisions short-circuit inside
   * dispatchSexton; the others spawn (if needed) and wake her session.
   *
   * Never throws: any error bubbling out of invokeAlarum OR dispatchSexton
   * is caught + logged + swallowed. Both callees already have safe-default
   * fallback on every exec / parse / fetch / spawn failure, so this guard
   * is defense-in-depth — Pulse's one job (keep ticking) must be
   * unkillable regardless of what happens above it. A broken Alarum or
   * broken dispatcher takes itself down, not the tick.
   */
  private async tick(): Promise<void> {
    this.tickCount++;
    log(`[pulse] tick #${this.tickCount}`);

    try {
      const decision = await invokeAlarum(this.daemon);
      log(`[pulse] tick #${this.tickCount} → alarum decision: ${decision.action} (${decision.reason})`);
      await dispatchSexton(this.daemon, decision);
    } catch (err) {
      // Defense-in-depth: invokeAlarum and dispatchSexton are both
      // supposed to never reject (each catches + returns cleanly), but
      // if either does anyway, swallow the error here so Pulse's tick
      // loop keeps running.
      logError(`[pulse] tick #${this.tickCount} continuity chain threw (upstream bug): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
