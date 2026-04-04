/**
 * DreamManager — background memory consolidation for agents.
 *
 * Adapted from Claude Code's autoDream system (services/autoDream/).
 * Agents periodically "dream" — reviewing recent sessions, consolidating
 * learnings into BRAIN/ topic files, and pruning stale MEMORY.md entries.
 *
 * Three-gate trigger (cheapest first):
 *   1. Time: hours since lastDreamAt >= minHours (one stat)
 *   2. Sessions: WORKLOG.md session count since last dream >= minSessions
 *   3. Lock: no other dream in progress for this agent
 *
 * Dispatches via say() — the agent runs the consolidation prompt with
 * full workspace access. Corp gateway's maxConcurrent handles throttling.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  readConfig,
  type Member,
  type Channel,
  MEMBERS_JSON,
  CHANNELS_JSON,
  countRecentObservations,
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { buildDreamPrompt } from './dream-prompt.js';
import { log, logError } from './logger.js';

// ── Configuration ───────────────────────────────────────────────────

const DREAM_CHECK_INTERVAL_MS = 2 * 60 * 1000;  // Check every 2 min (lightweight — just stat checks)
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;          // 5 min idle before dreaming
const MIN_HOURS_BETWEEN_DREAMS = 1;                // At least 1h between dreams (prevent thrashing)
const LOCK_STALE_MS = 60 * 60 * 1000;             // Lock stale after 1 hour
const DREAM_TIMEOUT_MS = 5 * 60 * 1000;           // 5 min timeout per dream

// ── State Files ─────────────────────────────────────────────────────

const DREAM_STATE_FILE = 'dream-state.json';
const DREAM_LOCK_FILE = '.dream-lock';

interface DreamState {
  lastDreamAt: number;     // Timestamp of last successful dream
  dreamCount: number;      // Total dreams completed
  lastSummary: string | null;  // What the last dream consolidated
}

const DEFAULT_STATE: DreamState = {
  lastDreamAt: 0,
  dreamCount: 0,
  lastSummary: null,
};

// ── DreamManager ────────────────────────────────────────────────────

export class DreamManager {
  private daemon: Daemon;
  /** Agents currently dreaming — prevents double-dispatch */
  private dreaming = new Set<string>();
  /** Track when each agent became idle (memberId → timestamp) */
  private idleSince = new Map<string, number>();

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  /**
   * Schedule dreams for all agents that were active during SLUMBER.
   * Called on /wake — agents consolidate what they learned autonomously.
   * Staggered by 30s to avoid overwhelming the gateway.
   */
  schedulePostSlumberDreams(agentIds: string[]): void {
    if (agentIds.length === 0) return;
    log(`[dreams] Scheduling post-SLUMBER dreams for ${agentIds.length} agent(s): ${agentIds.join(', ')}`);

    for (let i = 0; i < agentIds.length; i++) {
      const agentId = agentIds[i]!;
      const delay = i * 30_000; // 30s stagger between agents
      setTimeout(async () => {
        try {
          const result = await this.forceDream(agentId);
          if (result.ok) {
            log(`[dreams] Post-SLUMBER dream complete for ${agentId}`);
          } else {
            log(`[dreams] Post-SLUMBER dream failed for ${agentId}: ${result.error}`);
          }
        } catch (err) {
          log(`[dreams] Post-SLUMBER dream error for ${agentId}: ${err}`);
        }
      }, delay);
    }
  }

  /** Force-trigger a dream for a specific agent (skips all gates). For testing/CLI. */
  async forceDream(agentSlug: string): Promise<{ ok: boolean; summary?: string; error?: string }> {
    let members: Member[];
    try {
      members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    } catch { return { ok: false, error: 'Cannot read members' }; }

    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
    const agent = members.find(m =>
      m.type === 'agent' && (normalize(m.displayName) === normalize(agentSlug) || m.id === agentSlug),
    );
    if (!agent || !agent.agentDir) return { ok: false, error: `Agent "${agentSlug}" not found` };

    const agentDir = join(this.daemon.corpRoot, agent.agentDir);
    if (this.dreaming.has(agent.id)) return { ok: false, error: `${agent.displayName} is already dreaming` };

    const state = this.readDreamState(agentDir);
    const hoursSince = (Date.now() - state.lastDreamAt) / 3_600_000;
    const sessionsSince = this.countSessionsSince(agentDir, state.lastDreamAt);

    await this.dispatchDream(agent, agentDir, hoursSince, sessionsSince);

    const updated = this.readDreamState(agentDir);
    return { ok: true, summary: updated.lastSummary ?? 'Dream completed' };
  }

  /** Register the dream check clock. Called from daemon.startRouter(). */
  start(): void {
    this.daemon.clocks.register({
      id: 'dream-consolidation',
      name: 'Agent Dreams',
      type: 'system',
      intervalMs: DREAM_CHECK_INTERVAL_MS,
      target: 'all agents',
      description: 'Memory consolidation — agents review sessions and update BRAIN/ topics',
      callback: () => this.dreamCycle(),
    });
  }

  // ── Dream Cycle ─────────────────────────────────────────────────

  /**
   * Natural dream cycle — check all agents for idle + no pending work.
   * Runs every 2 min (lightweight stat checks, no API calls).
   *
   * An agent dreams when:
   *   1. Idle for 5+ minutes (nobody's talking to it)
   *   2. No pending inbox items or queued tasks
   *   3. At least 1 hour since last dream
   *   4. Lock free (no concurrent dream)
   */
  private async dreamCycle(): Promise<void> {
    let members: Member[];
    try {
      members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    } catch { return; }

    const agents = members.filter(m => m.type === 'agent' && m.status === 'active' && m.agentDir);
    if (agents.length === 0) return;

    const now = Date.now();

    for (const agent of agents) {
      if (this.dreaming.has(agent.id)) continue;

      const agentDir = join(this.daemon.corpRoot, agent.agentDir!);
      if (!existsSync(agentDir)) continue;

      // Must be online
      const agentProc = this.daemon.processManager.getAgent(agent.id);
      if (!agentProc || agentProc.status !== 'ready') {
        this.idleSince.delete(agent.id);
        continue;
      }

      // Track idle state
      const workStatus = this.daemon.getAgentWorkStatus(agent.id);
      if (workStatus === 'busy') {
        this.idleSince.delete(agent.id);
        continue;
      }

      // Record when agent became idle
      if (!this.idleSince.has(agent.id)) {
        this.idleSince.set(agent.id, now);
        continue; // Just became idle — check again next cycle
      }

      // Check natural gates
      const gateResult = this.checkGates(agent, agentDir, now);
      if (!gateResult.open) continue;

      // Dispatch (non-blocking)
      this.dispatchDream(agent, agentDir, gateResult.hoursSince, gateResult.sessionsSince);
    }
  }

  // ── Natural Gate Checks ─────────────────────────────────────────

  private checkGates(agent: Member, agentDir: string, now: number): {
    open: boolean;
    hoursSince: number;
    sessionsSince: number;
  } {
    const closed = { open: false, hoursSince: 0, sessionsSince: 0 };

    // Gate 1: Idle for 5+ minutes
    const idleStart = this.idleSince.get(agent.id);
    if (!idleStart || (now - idleStart) < IDLE_THRESHOLD_MS) return closed;

    // Gate 2: No pending work — check inbox queue
    const pendingTask = this.daemon.inbox.peekNext(agent.id);
    if (pendingTask) return closed;

    // Gate 3: Cooldown since last dream.
    // Default: 1 hour. Reduced to 30 min if agent has rich signal (10+ observations today).
    // Rich signal = more to consolidate = dream sooner.
    const state = this.readDreamState(agentDir);
    const hoursSince = (Date.now() - state.lastDreamAt) / 3_600_000;
    const todaysObservations = countRecentObservations(agentDir, 1); // last 24h
    const cooldownHours = todaysObservations >= 10 ? 0.5 : MIN_HOURS_BETWEEN_DREAMS;
    if (hoursSince < cooldownHours) return closed;

    // Gate 4: Lock free
    if (!this.tryAcquireLock(agentDir)) return closed;

    // Count sessions + observations for the prompt context (not gates — just informational)
    const sessionsSince = this.countSessionsSince(agentDir, state.lastDreamAt);
    const observationCount = countRecentObservations(agentDir, 7);

    log(`[dreams] ${agent.displayName} — idle ${Math.round((now - idleStart) / 60_000)}m, ${hoursSince.toFixed(1)}h since last dream, ${sessionsSince} sessions, ${observationCount} observations → dreaming`);
    return { open: true, hoursSince, sessionsSince };
  }

  /** Count WORKLOG.md session boundaries since a timestamp (informational, not a gate). */
  private countSessionsSince(agentDir: string, sinceMs: number): number {
    const worklogPath = join(agentDir, 'WORKLOG.md');
    if (!existsSync(worklogPath)) return 0;
    try {
      const content = readFileSync(worklogPath, 'utf-8');
      let count = 0;
      for (const line of content.split('\n')) {
        if (!/^## Session/.test(line)) continue;
        const isoMatch = line.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/);
        if (isoMatch) {
          if (new Date(isoMatch[0]).getTime() > sinceMs) count++;
        }
      }
      return count;
    } catch { return 0; }
  }

  // ── Lock (adapted from consolidationLock.ts) ─────────────────────

  /**
   * Acquire per-agent dream lock. Returns true if acquired.
   * Lock file contains PID. Stale after 1 hour.
   *
   * From Claude Code: "write PID → mtime = now. Returns the pre-acquire
   * mtime for rollback, or null if blocked / lost a race."
   */
  private tryAcquireLock(agentDir: string): boolean {
    const lockPath = join(agentDir, DREAM_LOCK_FILE);

    // Check existing lock
    try {
      const stat = statSync(lockPath);
      const raw = readFileSync(lockPath, 'utf-8');
      const holderPid = parseInt(raw.trim(), 10);

      // Lock is fresh — check if holder is alive
      if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
        if (Number.isFinite(holderPid) && this.isProcessAlive(holderPid)) {
          return false; // Held by live process
        }
        // Dead PID or unparseable — reclaim (fall through)
      }
      // Stale lock — reclaim (fall through)
    } catch {
      // No lock file — acquire below
    }

    // Acquire: write our PID
    try {
      writeFileSync(lockPath, String(process.pid), 'utf-8');

      // Race check: re-read to verify we won (from source: "two reclaimers
      // both write → last wins the PID. Loser bails on re-read.")
      const verify = readFileSync(lockPath, 'utf-8');
      if (parseInt(verify.trim(), 10) !== process.pid) return false;

      return true;
    } catch {
      return false;
    }
  }

  /** Release lock after dream completes or fails. */
  private releaseLock(agentDir: string): void {
    try {
      unlinkSync(join(agentDir, DREAM_LOCK_FILE));
    } catch {} // Non-fatal
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0); // Signal 0 = check existence
      return true;
    } catch {
      return false;
    }
  }

  // ── Dream Dispatch ──────────────────────────────────────────────

  /**
   * Dispatch a dream to an agent via say(). Non-blocking — runs in
   * background. Updates dream-state.json on completion, releases lock.
   */
  private async dispatchDream(
    agent: Member,
    agentDir: string,
    hoursSince: number,
    sessionsSince: number,
  ): Promise<void> {
    const slug = agent.displayName.toLowerCase().replace(/\s+/g, '-');
    this.dreaming.add(agent.id);

    log(`[dreams] ${agent.displayName} entering dream — ${sessionsSince} sessions to review`);

    // Ensure BRAIN/ directory exists before the agent tries to write to it
    const brainDir = join(agentDir, 'BRAIN');
    if (!existsSync(brainDir)) {
      mkdirSync(brainDir, { recursive: true });
    }

    try {
      // Resolve channel paths for rich signal gathering
      let channels: Channel[] = [];
      let members: Member[] = [];
      try {
        channels = readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
        members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      } catch {}

      const founder = members.find(m => m.rank === 'owner');
      const corpRootNorm = this.daemon.corpRoot.replace(/\\/g, '/');

      // Find the agent's DM with the founder
      const dmChannel = channels.find(c =>
        c.kind === 'direct' &&
        c.memberIds.includes(agent.id) &&
        (founder ? c.memberIds.includes(founder.id) : false),
      );

      // Find corp-level #general and #tasks channels
      const generalChannel = channels.find(c =>
        c.scope === 'corp' && c.kind === 'broadcast',
      );
      const tasksChannel = channels.find(c =>
        c.scope === 'corp' && c.kind === 'system' && c.name.includes('task'),
      );

      // Build agent summaries for context
      const agentSummaries: string[] = [];
      for (const m of members.filter(m2 => m2.type === 'agent' && m2.id !== agent.id)) {
        const status = this.daemon.getAgentWorkStatus(m.id);
        agentSummaries.push(`${m.displayName} (${m.rank}) — ${status ?? 'unknown'}`);
      }

      const prompt = buildDreamPrompt({
        agentName: agent.displayName,
        agentDir: agentDir.replace(/\\/g, '/'),
        corpRoot: corpRootNorm,
        sessionsSince,
        hoursSinceLast: hoursSince,
        dmChannelPath: dmChannel ? join(corpRootNorm, dmChannel.path) : null,
        generalChannelPath: generalChannel ? join(corpRootNorm, generalChannel.path) : null,
        tasksChannelPath: tasksChannel ? join(corpRootNorm, tasksChannel.path) : null,
        agentSummaries,
      });

      const resp = await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: slug,
          message: prompt,
          sessionKey: `jack:${slug}`,
          // Pass DM channelId so tool events + streaming show in the agent's DM
          channelId: dmChannel?.id ?? undefined,
        }),
        signal: AbortSignal.timeout(DREAM_TIMEOUT_MS),
      });

      const data = await resp.json() as Record<string, unknown>;

      if (data.ok) {
        const response = (data.response as string ?? '').trim();
        const isClean = response.includes('DREAM_CLEAN');

        // Update dream state
        const state = this.readDreamState(agentDir);
        state.lastDreamAt = Date.now();
        state.dreamCount++;
        state.lastSummary = isClean ? 'No changes needed' : response.slice(0, 500);
        this.writeDreamState(agentDir, state);

        log(`[dreams] ${agent.displayName} dream complete (dream #${state.dreamCount}) — ${isClean ? 'clean' : 'consolidated'}`);
      } else {
        logError(`[dreams] ${agent.displayName} dream dispatch failed: ${data.error ?? 'unknown'}`);
      }
    } catch (err) {
      logError(`[dreams] ${agent.displayName} dream failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.releaseLock(agentDir);
      this.dreaming.delete(agent.id);
    }
  }

  // ── State Persistence ───────────────────────────────────────────

  private readDreamState(agentDir: string): DreamState {
    try {
      const path = join(agentDir, DREAM_STATE_FILE);
      if (!existsSync(path)) return { ...DEFAULT_STATE };
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private writeDreamState(agentDir: string, state: DreamState): void {
    try {
      writeFileSync(
        join(agentDir, DREAM_STATE_FILE),
        JSON.stringify(state, null, 2) + '\n',
        'utf-8',
      );
    } catch (err) {
      logError(`[dreams] Failed to write dream state: ${err}`);
    }
  }
}
