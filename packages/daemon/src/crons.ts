/**
 * CronManager — user-created schedule-based recurring jobs.
 *
 * Crons fire on a calendar schedule (e.g., "every Monday at 9am") using
 * croner for correct cron expression parsing and scheduling. The Clock
 * primitive's observability layer (fire counts, progress bars, error tracking)
 * is maintained via ClockManager.registerExternal().
 *
 * Persisted to clocks.json. Rehydrated on daemon restart.
 */

import { Cron } from 'croner';
import cronstrue from 'cronstrue';
import { type ScheduledClock, isCronPreset, cronPresetToExpression, isRawCronExpression } from '@claudecorp/shared';
import type { ExternalClockHandle } from './clock-manager.js';
import type { Daemon } from './daemon.js';
import { saveScheduledClock, removeScheduledClock, loadScheduledClocks, FireStatsWriter } from './scheduled-clock-store.js';
import { log, logError } from './logger.js';

export interface CreateCronOpts {
  /** Human-readable name. Auto-generated if omitted. */
  name?: string;
  /** Cron expression: "0 9 * * 1", "@daily", "@hourly", "@weekly" */
  schedule: string;
  /** Shell command or prompt text */
  command: string;
  /** If set, dispatch to this agent via say() */
  targetAgent?: string;
  /** Auto-stop after N fires */
  maxRuns?: number;
}

interface CronEntry {
  job: Cron;
  handle: ExternalClockHandle;
  clock: ScheduledClock;
}

export class CronManager {
  private daemon: Daemon;
  private entries = new Map<string, CronEntry>(); // keyed by slug
  private statsWriter: FireStatsWriter;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
    this.statsWriter = new FireStatsWriter(daemon.corpRoot);
  }

  /** Create and start a new cron job. Returns the ScheduledClock. */
  create(opts: CreateCronOpts): ScheduledClock {
    // Normalize the expression
    const expression = this.normalizeExpression(opts.schedule);

    // Validate via croner dry run
    try {
      new Cron(expression, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    } catch (err) {
      throw new Error(`Invalid cron expression "${opts.schedule}": ${err instanceof Error ? err.message : String(err)}`);
    }

    const slug = this.generateSlug(opts);
    if (this.entries.has(slug)) throw new Error(`Cron "${slug}" already exists`);

    // Human-readable label via cronstrue
    let humanSchedule: string;
    try {
      humanSchedule = cronstrue.toString(expression, { use24HourTimeFormat: true });
    } catch {
      humanSchedule = opts.schedule; // Fallback to raw expression
    }

    const now = Date.now();

    // Build ScheduledClock
    const clock: ScheduledClock = {
      id: slug,
      name: opts.name ?? this.generateName(opts, humanSchedule),
      type: 'cron',
      intervalMs: 0, // Will be computed from croner's nextRun
      target: opts.targetAgent ?? 'shell',
      status: 'running',
      lastFiredAt: null,
      nextFireAt: null,
      fireCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      lastError: null,
      description: opts.targetAgent
        ? `${humanSchedule} → @${opts.targetAgent}: ${opts.command.slice(0, 60)}`
        : `${humanSchedule} → ${opts.command.slice(0, 60)}`,
      createdAt: now,
      expression,
      humanSchedule,
      command: opts.command,
      targetAgent: opts.targetAgent ?? null,
      maxRuns: opts.maxRuns ?? null,
      enabled: true,
      lastDurationMs: null,
      lastOutput: null,
    };

    // Register external clock for observability
    const handle = this.daemon.clocks.registerExternal({
      id: slug,
      name: clock.name,
      type: 'cron',
      intervalMs: 0,
      target: clock.target,
      description: clock.description,
    });

    // Create croner job
    const job = this.createCronerJob(slug, clock, handle, expression);

    // Compute next fire
    const nextRun = job.nextRun();
    if (nextRun) {
      const nextFireAt = nextRun.getTime();
      clock.nextFireAt = nextFireAt;
      handle.updateNextFire(nextFireAt);
    }

    // Store entry
    this.entries.set(slug, { job, handle, clock });

    // Persist
    saveScheduledClock(this.daemon.corpRoot, clock);

    // Broadcast
    this.daemon.events.broadcast({
      type: 'cron_created',
      name: clock.name,
      schedule: humanSchedule,
    });

    log(`[crons] Created: ${clock.name} (${slug}) — ${humanSchedule}`);
    return clock;
  }

  /** Stop and remove a cron by slug. */
  stop(slug: string): void {
    let entry = this.entries.get(slug);

    // Try matching by name if slug doesn't match directly
    if (!entry) {
      for (const [key, e] of this.entries) {
        if (e.clock.name.toLowerCase().replace(/\s+/g, '-') === slug.toLowerCase()) {
          slug = key;
          entry = e;
          break;
        }
      }
    }

    if (!entry) throw new Error(`Cron "${slug}" not found`);

    entry.job.stop();
    this.daemon.clocks.remove(slug);
    this.entries.delete(slug);
    removeScheduledClock(this.daemon.corpRoot, slug);

    this.daemon.events.broadcast({ type: 'cron_stopped', name: entry.clock.name });
    log(`[crons] Stopped: ${entry.clock.name} (${slug})`);
  }

  /** List all active crons. */
  list(): ScheduledClock[] {
    const store = loadScheduledClocks(this.daemon.corpRoot);
    return store.crons;
  }

  /** Rehydrate crons from clocks.json on daemon startup. */
  rehydrate(): void {
    const store = loadScheduledClocks(this.daemon.corpRoot);
    let count = 0;

    for (const cron of store.crons) {
      if (!cron.enabled) continue;

      try {
        const expression = this.normalizeExpression(cron.expression);
        const slug = cron.id;

        // Register external clock
        const handle = this.daemon.clocks.registerExternal({
          id: slug,
          name: cron.name,
          type: 'cron',
          intervalMs: 0,
          target: cron.target,
          description: cron.description,
        });

        // Create croner job
        const job = this.createCronerJob(slug, cron, handle, expression);

        // Compute next fire
        const nextRun = job.nextRun();
        if (nextRun) {
          handle.updateNextFire(nextRun.getTime());
        }

        this.entries.set(slug, { job, handle, clock: cron });
        count++;
      } catch (err) {
        logError(`[crons] Failed to rehydrate "${cron.name}": ${err}`);
      }
    }

    if (count > 0) log(`[crons] Rehydrated ${count} cron(s) from clocks.json`);
  }

  /** Stop all croner jobs. Called on daemon shutdown. */
  stopAll(): void {
    for (const [, entry] of this.entries) {
      entry.job.stop();
    }
    this.statsWriter.stop();
    log(`[crons] All ${this.entries.size} cron job(s) stopped`);
  }

  // ── Private ──────────────────────────────────────────────────────

  /** Normalize presets to 5-field expressions. */
  private normalizeExpression(input: string): string {
    if (isCronPreset(input)) {
      return cronPresetToExpression(input) ?? input;
    }
    return input.trim();
  }

  /** Create a croner Cron job with the shared callback pattern. */
  private createCronerJob(
    slug: string,
    clock: ScheduledClock,
    handle: ExternalClockHandle,
    expression: string,
  ): Cron {
    // Watchdog timeout: 5 minutes default for crons (they fire less frequently)
    const watchdogMs = 5 * 60_000;

    const job = new Cron(expression, {
      protect: true, // Prevent overlapping runs
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      catch: (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        handle.recordError(msg);
        logError(`[crons] ${clock.name} error: ${msg}`);
      },
    }, async () => {
      const start = Date.now();
      let output = '';

      try {
        if (clock.targetAgent) {
          const resp = await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              target: clock.targetAgent,
              message: clock.command,
              sessionKey: `cron:${slug}`,
            }),
            signal: AbortSignal.timeout(watchdogMs),
          });
          const data = await resp.json() as Record<string, unknown>;
          output = (data.response as string ?? data.error as string ?? '').slice(0, 500);
        } else {
          const { execa } = await import('execa');
          const result = await execa('bash', ['-c', clock.command], {
            cwd: this.daemon.corpRoot,
            timeout: watchdogMs,
            reject: false,
            env: { ...process.env, PATH: process.env.PATH },
          });
          output = ((result.stdout ?? '') + (result.stderr ? `\n${result.stderr}` : '')).slice(0, 500);
        }

        // Record successful fire
        handle.recordFire(Date.now() - start);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        handle.recordError(msg);
        output = msg;
      }

      // Update stats
      const duration = Date.now() - start;
      clock.lastDurationMs = duration;
      clock.lastOutput = output.trim() || null;
      clock.fireCount = handle.getFireCount();

      this.statsWriter.update(slug, {
        lastFiredAt: Date.now(),
        fireCount: clock.fireCount,
        lastDurationMs: duration,
        lastOutput: clock.lastOutput,
      });

      // Update next fire time
      const nextRun = job.nextRun();
      if (nextRun) {
        handle.updateNextFire(nextRun.getTime());
      }

      // maxRuns check
      if (clock.maxRuns && clock.fireCount >= clock.maxRuns) {
        log(`[crons] ${clock.name} reached maxRuns (${clock.maxRuns}) — auto-stopping`);
        setTimeout(() => {
          try { this.stop(slug); } catch {}
        }, 100);
      }
    });

    return job;
  }

  /** Generate a slug for the cron. */
  private generateSlug(opts: CreateCronOpts): string {
    if (opts.name) {
      return `cron-${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`;
    }
    if (opts.targetAgent) {
      const firstWord = opts.command.split(/\s+/)[0]?.toLowerCase() ?? 'task';
      return `cron-${opts.targetAgent.toLowerCase()}-${firstWord}`;
    }
    const words = opts.command
      .replace(/[^a-z0-9\s]/gi, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 3)
      .map(w => w.toLowerCase());
    return `cron-${words.join('-') || 'unnamed'}`;
  }

  /** Generate a display name. */
  private generateName(opts: CreateCronOpts, humanSchedule: string): string {
    if (opts.targetAgent) {
      return `${opts.targetAgent} (${humanSchedule.toLowerCase()})`;
    }
    const short = opts.command.split(/\s+/).slice(0, 2).join(' ');
    return `${short} (${humanSchedule.toLowerCase()})`;
  }
}
