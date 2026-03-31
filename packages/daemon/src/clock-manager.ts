import { type Clock, type ClockType, type ClockStatus, clockId } from '@claudecorp/shared';
import type { EventBus } from './events.js';
import { log, logError } from './logger.js';

const ALARM_THRESHOLD = 3; // Consecutive errors before alarm

interface ClockEntry {
  clock: Clock;
  callback: () => void | Promise<void>;
  handle: ReturnType<typeof setInterval> | null;
  firing: boolean; // Guard against overlapping async fires
}

/** Handle for externally-driven clocks (crons). Lets the caller update metadata. */
export interface ExternalClockHandle {
  recordFire(durationMs?: number): void;
  recordError(message: string): void;
  updateNextFire(timestamp: number): void;
  getFireCount(): number;
}

export interface RegisterClockOpts {
  id: string;
  name: string;
  type: ClockType;
  intervalMs: number;
  target: string;
  description: string;
  callback: () => void | Promise<void>;
}

/**
 * ClockManager — centralized registry for ALL periodic operations.
 *
 * Every setInterval in the daemon becomes a Clock with:
 * - Millisecond-precise timestamp tracking
 * - Fire count + error count + consecutive error tracking
 * - Pause/resume/stop lifecycle management
 * - WebSocket event broadcasting on each tick
 * - Overlap guard for async callbacks
 *
 * The /clock TUI view reads from this to show animated spinners,
 * progress bars, and real-time fire counts.
 */
export class ClockManager {
  private entries = new Map<string, ClockEntry>();
  private events: EventBus | null;

  constructor(events?: EventBus | null) {
    this.events = events ?? null;
  }

  /**
   * Register a new clock. Creates the setInterval and starts tracking.
   * Returns the interval handle for backward compatibility (existing code
   * stores handles for clearInterval — double-clear is a safe no-op).
   */
  register(opts: RegisterClockOpts): ReturnType<typeof setInterval> {
    // Don't duplicate — keyed by caller slug
    if (this.entries.has(opts.id)) {
      const existing = this.entries.get(opts.id)!;
      log(`[clock] ${opts.id} already registered — skipping`);
      return existing.handle!;
    }

    // Auto-assign ck-NNNN ID, keep caller's id as internal slug
    const now = Date.now();
    const clock: Clock = {
      id: clockId(),
      name: opts.name,
      type: opts.type,
      intervalMs: opts.intervalMs,
      target: opts.target,
      status: 'running',
      lastFiredAt: null,
      nextFireAt: now + opts.intervalMs,
      fireCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      lastError: null,
      description: opts.description,
      createdAt: now,
    };

    const entry: ClockEntry = {
      clock,
      callback: opts.callback,
      handle: null,
      firing: false,
    };

    // Create the interval with wrapped callback
    entry.handle = setInterval(() => this.tick(opts.id), opts.intervalMs);
    this.entries.set(opts.id, entry);

    // Fire immediately on registration — don't wait for first interval
    setTimeout(() => this.tick(opts.id), 0);

    log(`[clock] Registered: ${opts.name} (${opts.id}) — every ${this.formatInterval(opts.intervalMs)}, firing now`);
    return entry.handle;
  }

  /** Internal tick handler — wraps the callback with metadata tracking. */
  private async tick(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;

    // Overlap guard — skip if previous fire is still in progress
    if (entry.firing) {
      log(`[clock] ${entry.clock.name} skipped — previous fire still in progress`);
      return;
    }

    entry.firing = true;
    const firedAt = Date.now();

    try {
      // Execute the callback (handles both sync and async)
      await Promise.resolve(entry.callback());

      // Success — update metadata
      entry.clock.lastFiredAt = firedAt;
      entry.clock.nextFireAt = firedAt + entry.clock.intervalMs;
      entry.clock.fireCount++;
      entry.clock.consecutiveErrors = 0;
      if (entry.clock.status === 'error') {
        entry.clock.status = 'running'; // Recovered from error
      }

      // Broadcast tick event
      this.broadcastTick(entry.clock);
    } catch (err) {
      // Error — track it
      const errorMsg = err instanceof Error ? err.message : String(err);
      entry.clock.errorCount++;
      entry.clock.consecutiveErrors++;
      entry.clock.lastError = errorMsg;
      entry.clock.status = 'error';
      entry.clock.lastFiredAt = firedAt; // Still counts as a fire attempt
      entry.clock.nextFireAt = firedAt + entry.clock.intervalMs;

      logError(`[clock] ${entry.clock.name} error (${entry.clock.consecutiveErrors}/${ALARM_THRESHOLD}): ${errorMsg}`);

      // Alarm on consecutive errors
      if (entry.clock.consecutiveErrors >= ALARM_THRESHOLD) {
        logError(`[clock] ALARM: ${entry.clock.name} has ${entry.clock.consecutiveErrors} consecutive errors`);
        this.broadcastAlarm(entry.clock);
      }
    } finally {
      entry.firing = false;
    }
  }

  /**
   * Register an externally-driven clock (for crons via croner).
   * Creates a Clock entry for observability WITHOUT creating a setInterval.
   * The caller is responsible for driving the schedule and calling handle methods.
   */
  registerExternal(opts: Omit<RegisterClockOpts, 'callback'>): ExternalClockHandle {
    if (this.entries.has(opts.id)) {
      log(`[clock] ${opts.id} already registered (external) — returning existing handle`);
    }

    const now = Date.now();
    const clock: Clock = {
      id: clockId(),
      name: opts.name,
      type: opts.type,
      intervalMs: opts.intervalMs,
      target: opts.target,
      status: 'running',
      lastFiredAt: null,
      nextFireAt: opts.intervalMs > 0 ? now + opts.intervalMs : null,
      fireCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      lastError: null,
      description: opts.description,
      createdAt: now,
    };

    // External clocks have no interval and a no-op callback
    const entry: ClockEntry = {
      clock,
      callback: () => {},
      handle: null,
      firing: false,
    };

    this.entries.set(opts.id, entry);
    log(`[clock] Registered external: ${opts.name} (${opts.id})`);

    // Return handle for the caller to update metadata
    const self = this;
    return {
      recordFire(durationMs?: number) {
        const e = self.entries.get(opts.id);
        if (!e) return;
        const firedAt = Date.now();
        e.clock.lastFiredAt = firedAt;
        e.clock.fireCount++;
        e.clock.consecutiveErrors = 0;
        if (e.clock.status === 'error') e.clock.status = 'running';
        self.broadcastTick(e.clock);
      },
      recordError(message: string) {
        self.recordError(opts.id, message);
      },
      updateNextFire(timestamp: number) {
        const e = self.entries.get(opts.id);
        if (!e) return;
        e.clock.nextFireAt = timestamp;
        // Update intervalMs to reflect actual gap for progress bar accuracy
        if (e.clock.lastFiredAt) {
          e.clock.intervalMs = timestamp - e.clock.lastFiredAt;
        }
      },
      getFireCount() {
        return self.entries.get(opts.id)?.clock.fireCount ?? 0;
      },
    };
  }

  /**
   * Remove a clock completely — stop + delete from entries.
   * Used for user-deleted loops/crons (vs stop which keeps the entry).
   */
  remove(id: string): void {
    const found = this.findEntry(id);
    if (!found) return;
    const [slug] = found;
    this.stop(id);
    this.entries.delete(slug);
    log(`[clock] Removed: ${slug}`);
  }

  /** Pause a clock — stops the interval, preserves metadata. */
  pause(id: string): void {
    const found = this.findEntry(id);
    if (!found) throw new Error(`Clock "${id}" not found`);
    const [, entry] = found;
    if (entry.clock.status === 'paused') return;

    if (entry.handle) {
      clearInterval(entry.handle);
      entry.handle = null;
    }
    entry.clock.status = 'paused';
    entry.clock.nextFireAt = null;
    log(`[clock] Paused: ${entry.clock.name}`);
  }

  /** Resume a paused clock — recreates the interval. */
  resume(id: string): void {
    const found = this.findEntry(id);
    if (!found) throw new Error(`Clock "${id}" not found`);
    const [slug, entry] = found;
    if (entry.clock.status === 'running') return;

    entry.handle = setInterval(() => this.tick(slug), entry.clock.intervalMs);
    entry.clock.status = 'running';
    entry.clock.nextFireAt = Date.now() + entry.clock.intervalMs;
    log(`[clock] Resumed: ${entry.clock.name}`);
  }

  /** Stop a clock permanently. */
  stop(id: string): void {
    const found = this.findEntry(id);
    if (!found) return;
    const [, entry] = found;

    if (entry.handle) {
      clearInterval(entry.handle);
      entry.handle = null;
    }
    entry.clock.status = 'stopped';
    entry.clock.nextFireAt = null;
  }

  /** Stop all clocks. Called during daemon shutdown. */
  stopAll(): void {
    for (const [id] of this.entries) {
      this.stop(id);
    }
    log(`[clock] All ${this.entries.size} clocks stopped`);
  }

  /** Record an error manually (for callbacks that handle their own try/catch). */
  recordError(id: string, message: string): void {
    const found = this.findEntry(id);
    if (!found) return;
    const [, entry] = found;

    entry.clock.errorCount++;
    entry.clock.consecutiveErrors++;
    entry.clock.lastError = message;
    entry.clock.status = 'error';

    if (entry.clock.consecutiveErrors >= ALARM_THRESHOLD) {
      logError(`[clock] ALARM: ${entry.clock.name} — ${message}`);
      this.broadcastAlarm(entry.clock);
    }
  }

  /**
   * Find an entry by slug key OR by ck-NNNN clock.id.
   * The entries map is keyed by caller slug, but the Clock.id is auto-generated ck-NNNN.
   * The TUI/API uses clock.id for lookups, so we need to search both.
   */
  private findEntry(id: string): [string, ClockEntry] | undefined {
    // Direct slug match (fast path)
    const direct = this.entries.get(id);
    if (direct) return [id, direct];
    // Search by ck-NNNN clock.id (fallback)
    for (const [slug, entry] of this.entries) {
      if (entry.clock.id === id) return [slug, entry];
    }
    return undefined;
  }

  /** Resolve any ID (ck-NNNN or slug) to the internal map key (slug). */
  resolveKey(id: string): string | undefined {
    const found = this.findEntry(id);
    return found ? found[0] : undefined;
  }

  /** Get all clocks as metadata (no handles, no callbacks). */
  list(): Clock[] {
    return [...this.entries.values()].map(e => ({ ...e.clock }));
  }

  /** Get a single clock by slug or ck-NNNN ID. */
  get(id: string): Clock | undefined {
    const found = this.findEntry(id);
    return found ? { ...found[1].clock } : undefined;
  }

  /** Number of registered clocks. */
  get size(): number {
    return this.entries.size;
  }

  // --- Event broadcasting ---

  private broadcastTick(clock: Clock): void {
    if (!this.events) return;
    this.events.broadcast({
      type: 'clock_tick',
      clockId: clock.id,
      clockName: clock.name,
      firedAt: clock.lastFiredAt!,
      nextFireAt: clock.nextFireAt!,
      fireCount: clock.fireCount,
    } as any);
  }

  private broadcastAlarm(clock: Clock): void {
    if (!this.events) return;
    this.events.broadcast({
      type: 'clock_alarm',
      clockId: clock.id,
      clockName: clock.name,
      consecutiveErrors: clock.consecutiveErrors,
      lastError: clock.lastError,
    } as any);
  }

  // --- Formatting helpers ---

  private formatInterval(ms: number): string {
    if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
    if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
    return `${ms}ms`;
  }
}
