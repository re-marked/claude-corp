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
import {
  type ScheduledClock,
  isCronPreset,
  cronPresetToExpression,
  isRawCronExpression,
  readConfig,
  post,
  createTask,
  agentSessionKey,
  CHANNELS_JSON,
  MEMBERS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { join } from 'node:path';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import type { ExternalClockHandle } from './clock-manager.js';
import type { Daemon } from './daemon.js';
import { saveScheduledClock, removeScheduledClock, loadScheduledClocks, FireStatsWriter } from './scheduled-clock-store.js';
import { log, logError } from './logger.js';

// ── Hardening constants ────────────────────────────────────────────

/** Default auto-expiry for recurring crons: 7 days */
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Max jitter to spread thundering herd: 30 seconds */
const MAX_JITTER_MS = 30_000;

/** Scheduler lock file — prevents double-firing across concurrent processes */
const SCHEDULER_LOCK_FILE = '.cron-scheduler.lock';

/** Lock stale threshold: 5 minutes (if a lock is older, it's stale) */
const LOCK_STALE_MS = 5 * 60 * 1000;

// ── Jitter ─────────────────────────────────────────────────────────

/**
 * Deterministic jitter from clock ID using FNV-1a hash.
 * Same clock always gets the same jitter — no randomness.
 * Borrowed from Claude Code's cronScheduler.ts jitter pattern.
 */
function computeJitter(clockId: string, maxMs = MAX_JITTER_MS): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < clockId.length; i++) {
    hash ^= clockId.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, keep as uint32
  }
  return hash % maxMs;
}

// ── Scheduler Lock ─────────────────────────────────────────────────

/**
 * Try to acquire the scheduler lock. Returns true if acquired.
 * Prevents double-firing if two daemon instances run concurrently
 * (e.g., stale process + fresh start).
 */
function tryAcquireSchedulerLock(corpRoot: string): boolean {
  const lockPath = join(corpRoot, SCHEDULER_LOCK_FILE);
  try {
    if (existsSync(lockPath)) {
      const content = readFileSync(lockPath, 'utf-8');
      const lockData = JSON.parse(content) as { pid: number; acquiredAt: number };
      const age = Date.now() - lockData.acquiredAt;

      // If the lock is fresh and held by another PID, we can't acquire
      if (age < LOCK_STALE_MS && lockData.pid !== process.pid) {
        return false;
      }
      // Stale or same PID — take over
    }
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    return true;
  } catch {
    return true; // Can't read lock — assume available
  }
}

/** Release the scheduler lock. */
function releaseSchedulerLock(corpRoot: string): void {
  try { unlinkSync(join(corpRoot, SCHEDULER_LOCK_FILE)); } catch {}
}

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
  /** If true, each fire spawns a fresh task from the template below. */
  spawnTask?: boolean;
  /** Title pattern for spawned tasks — {date} replaced with fire date */
  taskTitle?: string;
  /** Agent slug to assign spawned tasks to */
  assignTo?: string;
  /** Priority for spawned tasks */
  taskPriority?: string;
  /** Description for spawned tasks */
  taskDescription?: string;
  /** Channel where output should be written */
  channelId?: string;
  /** Durable (true=default) persists to clocks.json. false = session-only, dies with daemon. */
  durable?: boolean;
  /** Permanent flag — never expires, can't be accidentally deleted. For system crons. */
  permanent?: boolean;
  /** Custom expiry duration in ms. Default: 7 days for non-permanent. null = no expiry. */
  expiryMs?: number | null;
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

    // Compute deterministic jitter from slug
    const jitterMs = computeJitter(slug);
    const isDurable = opts.durable !== false; // Default: durable
    const isPermanent = opts.permanent === true;

    // Compute expiry: permanent → never, custom → custom, default → 7 days
    let expiresAt: number | null = null;
    if (!isPermanent) {
      if (opts.expiryMs === null) {
        expiresAt = null; // Explicit no expiry
      } else {
        expiresAt = now + (opts.expiryMs ?? DEFAULT_EXPIRY_MS);
      }
    }

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
      channelId: opts.channelId ?? null,
      scheduledStatus: 'running',
      endedAt: null,
      taskId: null, // Crons don't link to tasks — they spawn fresh ones
      spawnTaskTemplate: opts.spawnTask ? {
        title: opts.taskTitle ?? `${opts.command.slice(0, 40)} — {date}`,
        assignTo: opts.assignTo ?? opts.targetAgent ?? null,
        priority: (opts.taskPriority as any) ?? 'normal',
        description: opts.taskDescription ?? null,
      } : null,
      // Hardening fields
      durable: isDurable,
      expiresAt,
      permanent: isPermanent,
      jitterMs,
      missedFire: false,
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

  /** Complete a cron — it did its job. Croner job stops, history preserved. */
  complete(slug: string): void {
    const entry = this.resolveEntry(slug);
    const realSlug = entry.clock.id;

    entry.job.stop();
    this.daemon.clocks.stop(realSlug);
    this.entries.delete(realSlug);

    const store = loadScheduledClocks(this.daemon.corpRoot);
    const cron = store.crons.find(c => c.id === realSlug);
    if (cron) {
      cron.scheduledStatus = 'completed';
      cron.enabled = false;
      cron.endedAt = Date.now();
      saveScheduledClock(this.daemon.corpRoot, cron);
    }

    this.daemon.events.broadcast({ type: 'cron_stopped', name: entry.clock.name });
    log(`[crons] Completed: ${entry.clock.name} (${realSlug})`);
  }

  /** Dismiss a cron — not needed. Hidden from /clock, kept in clocks.json. */
  dismiss(slug: string): void {
    const entry = this.resolveEntry(slug);
    const realSlug = entry.clock.id;

    entry.job.stop();
    this.daemon.clocks.remove(realSlug);
    this.entries.delete(realSlug);

    const store = loadScheduledClocks(this.daemon.corpRoot);
    const cron = store.crons.find(c => c.id === realSlug);
    if (cron) {
      cron.scheduledStatus = 'dismissed';
      cron.enabled = false;
      cron.endedAt = Date.now();
      saveScheduledClock(this.daemon.corpRoot, cron);
    }

    this.daemon.events.broadcast({ type: 'cron_stopped', name: entry.clock.name });
    log(`[crons] Dismissed: ${entry.clock.name} (${realSlug})`);
  }

  /** Resolve a slug to its CronEntry. */
  private resolveEntry(slug: string): CronEntry {
    let entry = this.entries.get(slug);
    if (!entry) {
      for (const [key, e] of this.entries) {
        if (e.clock.name.toLowerCase().replace(/\s+/g, '-') === slug.toLowerCase()) {
          entry = e;
          break;
        }
      }
    }
    if (!entry) throw new Error(`Cron "${slug}" not found`);
    return entry;
  }

  /** List all active crons. */
  list(): ScheduledClock[] {
    const store = loadScheduledClocks(this.daemon.corpRoot);
    return store.crons;
  }

  /** Rehydrate crons from clocks.json on daemon startup. */
  rehydrate(): void {
    // Acquire scheduler lock — prevents double-firing across concurrent instances
    if (!tryAcquireSchedulerLock(this.daemon.corpRoot)) {
      log(`[crons] Scheduler lock held by another process — skipping rehydration`);
      return;
    }

    const store = loadScheduledClocks(this.daemon.corpRoot);
    let count = 0;
    let expired = 0;
    let missed = 0;

    for (const cron of store.crons) {
      if (!cron.enabled) continue;
      if (cron.scheduledStatus === 'completed' || cron.scheduledStatus === 'dismissed' || cron.scheduledStatus === 'deleted') continue;

      // Skip non-durable clocks — they're session-only and shouldn't survive restart
      if (cron.durable === false) {
        log(`[crons] Skipping ephemeral cron "${cron.name}" — session-only`);
        continue;
      }

      // Auto-expiry check — stop expired clocks unless permanent
      const now = Date.now();
      if (!cron.permanent && cron.expiresAt && cron.expiresAt < now) {
        const expiredAgo = Math.round((now - cron.expiresAt) / 3_600_000);
        log(`[crons] "${cron.name}" expired ${expiredAgo}h ago — auto-stopping`);
        cron.scheduledStatus = 'completed';
        cron.enabled = false;
        cron.endedAt = now;
        saveScheduledClock(this.daemon.corpRoot, cron);
        expired++;
        continue;
      }

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

        // Detect missed fires — if stored nextFireAt is in the past, a fire was missed
        if (cron.nextFireAt && cron.nextFireAt < now) {
          const missedAgo = Math.round((now - cron.nextFireAt) / 60_000);
          cron.missedFire = true;
          missed++;

          if (missedAgo < 60) {
            // Missed within the last hour — fire catch-up after rehydration (with jitter)
            log(`[crons] "${cron.name}" missed a fire (${missedAgo}m ago) — scheduling catch-up`);
            const jitter = cron.jitterMs ?? computeJitter(slug);
            // Capture handle+cron for the deferred catch-up execution
            const catchupHandle = handle;
            const catchupCron = cron;
            setTimeout(() => {
              log(`[crons] Catch-up fire: ${catchupCron.name} (missed ${missedAgo}m ago)`);
              // Trigger the croner job's callback manually by calling trigger()
              const entry = this.entries.get(slug);
              if (entry) {
                entry.job.trigger(); // Actually execute the cron callback
              }
              catchupCron.missedFire = false;
              saveScheduledClock(this.daemon.corpRoot, catchupCron);
            }, Math.max(jitter, 2000)); // At least 2s after rehydration to let everything settle
          } else {
            // Missed more than an hour ago — skip to next, just log
            log(`[crons] "${cron.name}" missed a fire (${missedAgo}m ago) — too old, skipping to next`);
            cron.missedFire = false;
          }
        }

        // Create croner job — croner computes next fire from NOW, naturally skipping missed
        const job = this.createCronerJob(slug, cron, handle, expression);

        // Compute next fire from croner (not from stored value)
        const nextRun = job.nextRun();
        if (nextRun) {
          // Apply jitter: delay the next fire by the deterministic jitter amount
          const jitter = cron.jitterMs ?? 0;
          const jitteredTime = nextRun.getTime() + jitter;
          handle.updateNextFire(jitteredTime);
          log(`[crons] "${cron.name}" next fire: ${nextRun.toLocaleString()}${jitter > 0 ? ` (+${Math.round(jitter / 1000)}s jitter)` : ''}`);
        }

        this.entries.set(slug, { job, handle, clock: cron });
        count++;
      } catch (err) {
        logError(`[crons] Failed to rehydrate "${cron.name}": ${err}`);
      }
    }

    const summary = [`Rehydrated ${count} cron(s)`];
    if (expired > 0) summary.push(`${expired} expired`);
    if (missed > 0) summary.push(`${missed} missed`);
    if (count > 0 || expired > 0) log(`[crons] ${summary.join(', ')}`);
  }

  /** Stop all croner jobs. Called on daemon shutdown. */
  stopAll(): void {
    for (const [, entry] of this.entries) {
      entry.job.stop();
    }
    this.statsWriter.stop();
    releaseSchedulerLock(this.daemon.corpRoot);
    log(`[crons] All ${this.entries.size} cron job(s) stopped, scheduler lock released`);
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
      // Apply deterministic jitter — delay execution to spread thundering herd
      const jitter = clock.jitterMs ?? 0;
      if (jitter > 0) {
        await new Promise(r => setTimeout(r, jitter));
      }

      const start = Date.now();
      let output = '';

      // Spawn a fresh task if spawnTaskTemplate is configured
      if (clock.spawnTaskTemplate) {
        try {
          const tpl = clock.spawnTaskTemplate;
          const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const title = tpl.title.replace(/\{date\}/g, dateStr);

          // Resolve assignee member ID from slug
          let assignedTo: string | null = null;
          if (tpl.assignTo) {
            try {
              const members = readConfig<any[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
              const agent = members.find((m: any) =>
                m.type === 'agent' && m.displayName.toLowerCase().replace(/\s+/g, '-') === tpl.assignTo!.toLowerCase(),
              );
              assignedTo = agent?.id ?? null;
            } catch {}
          }

          const task = createTask(this.daemon.corpRoot, {
            title,
            description: tpl.description ?? `Spawned by cron "${clock.name}" on ${dateStr}.`,
            priority: tpl.priority,
            assignedTo,
            createdBy: 'system',
          });

          log(`[crons] Spawned task "${title}" (${task.id}) from cron ${slug}`);

          // Hand the task so the agent gets a DM notification
          if (assignedTo && tpl.assignTo) {
            try {
              await fetch(`http://127.0.0.1:${this.daemon.getPort()}/tasks/${encodeURIComponent(task.id)}/hand`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: tpl.assignTo }),
              });
              log(`[crons] Handed spawned task ${task.id} → @${tpl.assignTo}`);
            } catch {
              // Non-fatal — task exists even if hand fails
            }
          }
        } catch (err) {
          logError(`[crons] Failed to spawn task from cron ${slug}: ${err}`);
        }
      }

      try {
        if (clock.targetAgent) {
          const resp = await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              target: clock.targetAgent,
              message: clock.command,
              sessionKey: agentSessionKey(clock.targetAgent),
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
        // Don't call handle.recordError here — croner's catch handler already does it.
        // Just capture the output for display.
        output = err instanceof Error ? err.message : String(err);
      }

      // Update stats
      const duration = Date.now() - start;
      clock.lastDurationMs = duration;
      clock.lastOutput = output.trim() || null;
      clock.fireCount = handle.getFireCount();

      // Write output to birth channel
      if (clock.channelId && output.trim()) {
        this.writeOutputToChannel(clock, output.trim());
      }

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

  /** Write cron output to its birth channel as a visible message. */
  private writeOutputToChannel(clock: ScheduledClock, output: string): void {
    if (!clock.channelId) return;
    try {
      const channels = readConfig<any[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
      const ch = channels.find((c: any) => c.id === clock.channelId);
      if (!ch) return;
      const msgPath = join(this.daemon.corpRoot, ch.path, MESSAGES_JSONL);

      // Resolve agent member ID for agent dispatches
      let senderId = 'system';
      if (clock.targetAgent) {
        try {
          const members = readConfig<any[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
          const agent = members.find((m: any) =>
            m.type === 'agent' && m.displayName.toLowerCase().replace(/\s+/g, '-') === clock.targetAgent!.toLowerCase(),
          );
          if (agent) senderId = agent.id;
        } catch {}
      }

      post(clock.channelId, msgPath, {
        senderId,
        content: senderId !== 'system' ? output : `[${clock.name}] ${output}`,
        source: 'cron',
        kind: senderId !== 'system' ? 'text' : 'system',
        metadata: { cronId: clock.id },
      });
    } catch {
      // Non-fatal
    }
  }
}
