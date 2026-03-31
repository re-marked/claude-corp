/**
 * Scheduled Clock Store — persistence layer for user-created loops & crons.
 *
 * Stores to clocks.json at corp root. Uses atomic tmp+rename writes.
 * Debounces fire-stat updates to prevent disk thrash on fast loops.
 */

import { join } from 'node:path';
import { readConfigOr, writeConfig, type ScheduledClock } from '@claudecorp/shared';
import { log } from './logger.js';

const CLOCKS_FILE = 'clocks.json';

export interface ClocksStore {
  loops: ScheduledClock[];
  crons: ScheduledClock[];
}

const EMPTY_STORE: ClocksStore = { loops: [], crons: [] };

/** Read clocks.json — returns empty store if file doesn't exist. */
export function loadScheduledClocks(corpRoot: string): ClocksStore {
  return readConfigOr<ClocksStore>(join(corpRoot, CLOCKS_FILE), { ...EMPTY_STORE, loops: [], crons: [] });
}

/** Save or update a scheduled clock (upsert by id). */
export function saveScheduledClock(corpRoot: string, clock: ScheduledClock): void {
  const store = loadScheduledClocks(corpRoot);
  const list = clock.type === 'loop' ? store.loops : store.crons;
  const idx = list.findIndex(c => c.id === clock.id);
  if (idx >= 0) {
    list[idx] = clock;
  } else {
    list.push(clock);
  }
  writeConfig(join(corpRoot, CLOCKS_FILE), store);
}

/** Remove a scheduled clock by its slug (internal map key). */
export function removeScheduledClock(corpRoot: string, slug: string): void {
  const store = loadScheduledClocks(corpRoot);
  store.loops = store.loops.filter(c => c.id !== slug && !matchSlug(c, slug));
  store.crons = store.crons.filter(c => c.id !== slug && !matchSlug(c, slug));
  writeConfig(join(corpRoot, CLOCKS_FILE), store);
}

/** Match a clock by its slug or ck-NNNN id. */
function matchSlug(clock: ScheduledClock, slug: string): boolean {
  // The internal map key (slug) is stored in the name field since Clock.id
  // gets auto-assigned a ck-NNNN by ClockManager. Check both.
  return clock.name.toLowerCase().replace(/\s+/g, '-') === slug.toLowerCase();
}

/**
 * Debounced fire stats updater — batches disk writes.
 *
 * Fast loops (e.g., every 10s) would write to disk on EVERY fire.
 * This batches updates and flushes every 5 seconds.
 */
export class FireStatsWriter {
  private dirty = new Map<string, Partial<ScheduledClock>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private corpRoot: string;

  constructor(corpRoot: string) {
    this.corpRoot = corpRoot;
  }

  /** Queue a fire stats update. Written to disk within 5 seconds. */
  update(slug: string, stats: {
    lastFiredAt: number;
    fireCount: number;
    lastDurationMs: number;
    lastOutput: string | null;
    errorCount?: number;
    lastError?: string | null;
  }): void {
    this.dirty.set(slug, stats as Partial<ScheduledClock>);

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 5000);
    }
  }

  /** Force-flush all pending updates to disk. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.dirty.size === 0) return;

    try {
      const store = loadScheduledClocks(this.corpRoot);
      const allClocks = [...store.loops, ...store.crons];

      for (const [slug, updates] of this.dirty) {
        const clock = allClocks.find(c => c.id === slug || matchSlug(c, slug));
        if (clock) {
          Object.assign(clock, updates);
        }
      }

      writeConfig(join(this.corpRoot, CLOCKS_FILE), store);
      log(`[clock-store] Flushed fire stats for ${this.dirty.size} clock(s)`);
    } catch (err) {
      // Non-fatal — stats will be re-accumulated on next fire
    }

    this.dirty.clear();
  }

  /** Stop the debounce timer and flush. Called on daemon shutdown. */
  stop(): void {
    this.flush();
  }
}
