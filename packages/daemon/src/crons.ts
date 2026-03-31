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
  type ChannelMessage,
  isCronPreset,
  cronPresetToExpression,
  isRawCronExpression,
  readConfig,
  appendMessage,
  generateId,
  createTask,
  CHANNELS_JSON,
  MEMBERS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { join } from 'node:path';
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
    const store = loadScheduledClocks(this.daemon.corpRoot);
    let count = 0;

    for (const cron of store.crons) {
      if (!cron.enabled) continue;
      if (cron.scheduledStatus === 'completed' || cron.scheduledStatus === 'dismissed' || cron.scheduledStatus === 'deleted') continue;

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
        const now = Date.now();
        if (cron.nextFireAt && cron.nextFireAt < now) {
          const missedAgo = Math.round((now - cron.nextFireAt) / 60_000);
          log(`[crons] "${cron.name}" missed a fire (${missedAgo}m ago) — skipping to next scheduled time`);
        }

        // Create croner job — croner computes next fire from NOW, naturally skipping missed
        const job = this.createCronerJob(slug, cron, handle, expression);

        // Compute next fire from croner (not from stored value)
        const nextRun = job.nextRun();
        if (nextRun) {
          handle.updateNextFire(nextRun.getTime());
          log(`[crons] "${cron.name}" next fire: ${nextRun.toLocaleString()}`);
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

      const msg: ChannelMessage = {
        id: generateId(),
        channelId: clock.channelId,
        senderId,
        threadId: null,
        content: senderId !== 'system' ? output : `[${clock.name}] ${output}`,
        kind: senderId !== 'system' ? 'text' : 'system',
        mentions: [],
        metadata: { source: 'cron', cronId: clock.id },
        depth: 0,
        originId: '',
        timestamp: new Date().toISOString(),
      };
      msg.originId = msg.id;
      appendMessage(msgPath, msg);
    } catch {
      // Non-fatal
    }
  }
}
