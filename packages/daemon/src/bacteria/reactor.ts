/**
 * Bacteria — reactor module.
 *
 * Drives the decision/execute loop on a fixed interval. Maintains
 * BacteriaState across ticks (the hysteresis bookkeeping), serializes
 * tick execution behind an in-flight flag so a slow tick can't be
 * re-entered, and surfaces a simple start/stop API for the daemon.
 *
 * v1 is polling-only (5-second tick by default — see
 * BACTERIA_TICK_INTERVAL_MS in types.ts). No fs.watch hook. The
 * trade-off: latency is bounded by the tick interval, but the
 * implementation steers clear of the Windows fs.watch surface that
 * the rest of the daemon's watchers have to paper over with
 * fire-3-5-times / miss-appends workarounds. Quieter, simpler,
 * ships v1.
 *
 * If sub-second responsiveness becomes worth the cost, an event-
 * driven trigger can layer on top of the existing tick — the tick
 * itself stays as a safety net for hysteresis time-fires (which
 * need a clock, not a write event, to detect "this slot has been
 * idle for 3 minutes and nothing happened").
 */

import { decideBacteriaActions } from './decision.js';
import {
  executeBacteriaActions,
  type ExecutorContext,
} from './executor.js';
import {
  emptyBacteriaState,
  type BacteriaState,
  BACTERIA_TICK_INTERVAL_MS,
} from './types.js';
import { log, logError } from '../logger.js';

export class BacteriaReactor {
  private state: BacteriaState = emptyBacteriaState();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly ctx: ExecutorContext;
  private readonly tickIntervalMs: number;

  constructor(ctx: ExecutorContext, tickIntervalMs: number = BACTERIA_TICK_INTERVAL_MS) {
    this.ctx = ctx;
    this.tickIntervalMs = tickIntervalMs;
  }

  /**
   * Begin reacting. Idempotent — calling twice is a no-op so the
   * daemon's own start/restart paths can call this without guarding.
   * Fires one tick immediately (so a corp booted with pre-existing
   * unprocessed tasks gets bacteria's reaction without waiting for
   * the first interval) and then schedules the recurring interval.
   */
  start(): void {
    if (this.intervalHandle !== null) return;
    log(`[bacteria] reactor starting — tick every ${this.tickIntervalMs}ms`);
    void this.tick();
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle === null) return;
    clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    log('[bacteria] reactor stopped');
  }

  /**
   * Single tick: read state, compute actions, apply them, advance
   * the in-memory hysteresis state. Public so tests can drive ticks
   * synchronously without spinning real timers.
   *
   * Skips re-entrant invocations — if the previous tick is still
   * running (slow disk, big batch), we don't queue a second one. The
   * next interval will pick up wherever the queue stands then.
   */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const result = decideBacteriaActions({
        corpRoot: this.ctx.corpRoot,
        previousState: this.state,
        now: new Date(),
      });
      if (result.actions.length > 0) {
        const summary = await executeBacteriaActions(this.ctx, result.actions);
        log(
          `[bacteria] tick: ${result.actions.length} actions (${summary.applied} applied, ${summary.failed} failed)`,
        );
      }
      this.state = result.nextState;
    } catch (err) {
      logError(`[bacteria] tick threw: ${(err as Error).message}`);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Read the current hysteresis state. Test-only; production daemon
   * consumers shouldn't need this. The reactor owns its own state and
   * exposes it for assertions in unit tests that drive ticks
   * synchronously.
   */
  getState(): BacteriaState {
    return this.state;
  }
}
