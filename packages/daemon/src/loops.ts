/**
 * LoopManager — user-created interval-based recurring commands.
 *
 * Loops fire on a fixed interval (e.g., every 5 minutes) and either:
 *   1. Run a shell command (cc-cli status, bash one-liners)
 *   2. Dispatch to an agent via say() with a persistent session
 *
 * Persisted to clocks.json. Rehydrated on daemon restart.
 * Registered as ClockManager entries with type='loop' for full observability.
 */

import {
  type ScheduledClock,
  type ChannelMessage,
  parseIntervalExpression,
  formatIntervalMs,
  readConfig,
  appendMessage,
  generateId,
  CHANNELS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { join } from 'node:path';
import type { Daemon } from './daemon.js';
import { saveScheduledClock, removeScheduledClock, loadScheduledClocks, FireStatsWriter } from './scheduled-clock-store.js';
import { log, logError } from './logger.js';

export interface CreateLoopOpts {
  /** Human-readable name. Auto-generated if omitted. */
  name?: string;
  /** Interval expression: "@every 5m", "5m", "30s", "2h", "1h30m" */
  interval: string;
  /** Shell command or prompt text */
  command: string;
  /** If set, dispatch to this agent via say() instead of running as shell */
  targetAgent?: string;
  /** Auto-stop after N fires (null = unlimited) */
  maxRuns?: number;
  /** Channel where output should be written. Null = output captured but not posted. */
  channelId?: string;
}

export class LoopManager {
  private daemon: Daemon;
  private slugs = new Set<string>(); // Track active loop slugs
  private statsWriter: FireStatsWriter;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
    this.statsWriter = new FireStatsWriter(daemon.corpRoot);
  }

  /** Create and start a new loop. Returns the ScheduledClock. */
  create(opts: CreateLoopOpts): ScheduledClock {
    const intervalMs = parseIntervalExpression(opts.interval);
    if (!intervalMs) throw new Error(`Invalid interval: "${opts.interval}"`);
    if (intervalMs < 10_000) throw new Error('Minimum loop interval is 10 seconds');

    const slug = this.generateSlug(opts);
    if (this.slugs.has(slug)) throw new Error(`Loop "${slug}" already exists`);

    const now = Date.now();
    const humanSchedule = `Every ${formatIntervalMs(intervalMs)}`;

    // Build the ScheduledClock
    const clock: ScheduledClock = {
      // Clock base fields
      id: slug,
      name: opts.name ?? this.generateName(opts),
      type: 'loop',
      intervalMs,
      target: opts.targetAgent ?? 'shell',
      status: 'running',
      lastFiredAt: null,
      nextFireAt: now + intervalMs,
      fireCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      lastError: null,
      description: opts.targetAgent
        ? `Dispatch to @${opts.targetAgent}: ${opts.command.slice(0, 80)}`
        : `Run: ${opts.command.slice(0, 80)}`,
      createdAt: now,
      // ScheduledClock extensions
      expression: opts.interval,
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
    };

    // Register with ClockManager for observability
    const callback = this.buildCallback(slug, clock);
    this.daemon.clocks.register({
      id: slug,
      name: clock.name,
      type: 'loop',
      intervalMs,
      target: clock.target,
      description: clock.description,
      callback,
    });

    // Persist and track
    this.slugs.add(slug);
    saveScheduledClock(this.daemon.corpRoot, clock);

    // Broadcast creation event
    this.daemon.events.broadcast({
      type: 'loop_created',
      name: clock.name,
      interval: humanSchedule,
    });

    log(`[loops] Created: ${clock.name} (${slug}) — ${humanSchedule}`);
    return clock;
  }

  /** Delete a loop permanently — remove from clocks.json entirely. */
  stop(slug: string): void {
    slug = this.resolveSlug(slug);
    const clockEntry = this.daemon.clocks.get(slug);
    const name = clockEntry?.name ?? slug;

    this.daemon.clocks.remove(slug);
    this.slugs.delete(slug);
    removeScheduledClock(this.daemon.corpRoot, slug);

    this.daemon.events.broadcast({ type: 'loop_stopped', name });
    log(`[loops] Deleted: ${name} (${slug})`);
  }

  /** Complete a loop — it did its job. History preserved, shown as completed in /clock. */
  complete(slug: string): void {
    slug = this.resolveSlug(slug);
    const clockEntry = this.daemon.clocks.get(slug);
    const name = clockEntry?.name ?? slug;

    // Stop the interval but keep the entry in ClockManager (for /clock view)
    this.daemon.clocks.stop(slug);
    this.slugs.delete(slug);

    // Update persistence — mark as completed, not removed
    const store = loadScheduledClocks(this.daemon.corpRoot);
    const loop = store.loops.find(l => l.id === slug);
    if (loop) {
      loop.scheduledStatus = 'completed';
      loop.enabled = false;
      loop.endedAt = Date.now();
      saveScheduledClock(this.daemon.corpRoot, loop);
    }

    this.daemon.events.broadcast({ type: 'loop_stopped', name });
    log(`[loops] Completed: ${name} (${slug}) — ${loop?.fireCount ?? 0} fires`);
  }

  /** Dismiss a loop — not needed anymore. Hidden from /clock, kept in clocks.json. */
  dismiss(slug: string): void {
    slug = this.resolveSlug(slug);
    const clockEntry = this.daemon.clocks.get(slug);
    const name = clockEntry?.name ?? slug;

    this.daemon.clocks.remove(slug); // Fully remove from ClockManager (hidden)
    this.slugs.delete(slug);

    // Update persistence — mark as dismissed, not removed
    const store = loadScheduledClocks(this.daemon.corpRoot);
    const loop = store.loops.find(l => l.id === slug);
    if (loop) {
      loop.scheduledStatus = 'dismissed';
      loop.enabled = false;
      loop.endedAt = Date.now();
      saveScheduledClock(this.daemon.corpRoot, loop);
    }

    this.daemon.events.broadcast({ type: 'loop_stopped', name });
    log(`[loops] Dismissed: ${name} (${slug})`);
  }

  /** List all active loops. */
  list(): ScheduledClock[] {
    const store = loadScheduledClocks(this.daemon.corpRoot);
    return store.loops;
  }

  /** Rehydrate loops from clocks.json on daemon startup. */
  rehydrate(): void {
    const store = loadScheduledClocks(this.daemon.corpRoot);
    let count = 0;

    for (const loop of store.loops) {
      if (!loop.enabled) continue;

      try {
        // Re-register without re-persisting (it's already in clocks.json)
        const intervalMs = parseIntervalExpression(loop.expression);
        if (!intervalMs) continue;

        const slug = loop.id;
        const callback = this.buildCallback(slug, loop);

        this.daemon.clocks.register({
          id: slug,
          name: loop.name,
          type: 'loop',
          intervalMs,
          target: loop.target,
          description: loop.description,
          callback,
        });

        this.slugs.add(slug);
        count++;
      } catch (err) {
        logError(`[loops] Failed to rehydrate "${loop.name}": ${err}`);
      }
    }

    if (count > 0) log(`[loops] Rehydrated ${count} loop(s) from clocks.json`);
  }

  /** Flush pending stats on shutdown. */
  shutdown(): void {
    this.statsWriter.stop();
  }

  // ── Private ──────────────────────────────────────────────────────

  /** Resolve a slug — try direct match, then name match. */
  private resolveSlug(slug: string): string {
    if (this.slugs.has(slug)) return slug;
    const store = loadScheduledClocks(this.daemon.corpRoot);
    const match = store.loops.find(l =>
      l.name.toLowerCase().replace(/\s+/g, '-') === slug.toLowerCase() || l.id === slug,
    );
    if (match) return match.id;
    throw new Error(`Loop "${slug}" not found`);
  }

  /** Write loop output to its birth channel as a visible message. */
  private writeOutputToChannel(clock: ScheduledClock, output: string, agentMemberId: string | null): void {
    if (!clock.channelId) return;
    try {
      const channels = readConfig<any[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
      const ch = channels.find((c: any) => c.id === clock.channelId);
      if (!ch) return;
      const msgPath = join(this.daemon.corpRoot, ch.path, MESSAGES_JSONL);

      // Agent dispatch → message from the agent. Shell → system message.
      const msg: ChannelMessage = {
        id: generateId(),
        channelId: clock.channelId,
        senderId: agentMemberId ?? 'system',
        threadId: null,
        content: agentMemberId ? output : `[${clock.name}] ${output}`,
        kind: agentMemberId ? 'text' : 'system',
        mentions: [],
        metadata: { source: 'loop', loopId: clock.id },
        depth: 0,
        originId: '',
        timestamp: new Date().toISOString(),
      };
      msg.originId = msg.id;
      appendMessage(msgPath, msg);
    } catch {
      // Non-fatal — loop still works, just can't post to channel
    }
  }

  /** Build the callback function for a loop. */
  private buildCallback(slug: string, clock: ScheduledClock): () => Promise<void> {
    // Watchdog timeout: 80% of interval, min 5s, max 5min
    const watchdogMs = Math.max(5_000, Math.min(5 * 60_000, Math.floor(clock.intervalMs * 0.8)));

    return async () => {
      const start = Date.now();
      let output = '';
      let agentMemberId: string | null = null;

      try {
        if (clock.targetAgent) {
          // Dispatch to agent via say() — pass channelId for streaming events
          const sayPayload: Record<string, string> = {
            target: clock.targetAgent,
            message: clock.command,
            sessionKey: `loop:${slug}`,
          };
          if (clock.channelId) sayPayload.channelId = clock.channelId;

          const resp = await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sayPayload),
            signal: AbortSignal.timeout(watchdogMs),
          });
          const data = await resp.json() as Record<string, unknown>;
          output = (data.response as string ?? data.error as string ?? '').slice(0, 500);

          // Resolve agent member ID for writing response to channel
          if (data.ok && clock.channelId) {
            try {
              const members = readConfig<any[]>(join(this.daemon.corpRoot, CHANNELS_JSON))
                ? readConfig<any[]>(join(this.daemon.corpRoot, 'members.json'))
                : [];
              const agent = members.find((m: any) =>
                m.type === 'agent' && m.displayName.toLowerCase().replace(/\s+/g, '-') === clock.targetAgent!.toLowerCase(),
              );
              agentMemberId = agent?.id ?? null;
            } catch {}
          }
        } else {
          // Shell command via execa
          const { execa } = await import('execa');
          const result = await execa('bash', ['-c', clock.command], {
            cwd: this.daemon.corpRoot,
            timeout: watchdogMs,
            reject: false,
            env: { ...process.env, PATH: process.env.PATH },
          });
          output = ((result.stdout ?? '') + (result.stderr ? `\n${result.stderr}` : '')).slice(0, 500);
        }
      } catch (err) {
        output = err instanceof Error ? err.message : String(err);
        throw err; // Re-throw so ClockManager tracks the error
      } finally {
        const duration = Date.now() - start;
        clock.lastDurationMs = duration;
        clock.lastOutput = output.trim() || null;
        clock.fireCount++;

        // Write output to the channel where the loop was created
        if (clock.channelId && output.trim()) {
          this.writeOutputToChannel(clock, output.trim(), agentMemberId);
        }

        // Debounced stats persistence
        this.statsWriter.update(slug, {
          lastFiredAt: Date.now(),
          fireCount: clock.fireCount,
          lastDurationMs: duration,
          lastOutput: clock.lastOutput,
        });

        // maxRuns check — auto-complete after N fires
        if (clock.maxRuns && clock.fireCount >= clock.maxRuns) {
          log(`[loops] ${clock.name} reached maxRuns (${clock.maxRuns}) — auto-completing`);
          setTimeout(() => {
            try { this.complete(slug); } catch {}
          }, 100);
        }
      }
    };
  }

  /** Generate a slug for the loop. */
  private generateSlug(opts: CreateLoopOpts): string {
    if (opts.name) {
      return `loop-${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`;
    }
    if (opts.targetAgent) {
      const firstWord = opts.command.split(/\s+/)[0]?.toLowerCase() ?? 'task';
      return `loop-${opts.targetAgent.toLowerCase()}-${firstWord}`;
    }
    // Extract meaningful words from command
    const words = opts.command
      .replace(/[^a-z0-9\s]/gi, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 3)
      .map(w => w.toLowerCase());
    return `loop-${words.join('-') || 'unnamed'}`;
  }

  /** Generate a display name for the loop. */
  private generateName(opts: CreateLoopOpts): string {
    if (opts.targetAgent) {
      return `${opts.targetAgent} loop`;
    }
    // Take first meaningful part of command
    const short = opts.command.split(/\s+/).slice(0, 3).join(' ');
    return short.length > 30 ? short.slice(0, 27) + '...' : short;
  }
}
