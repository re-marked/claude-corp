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
  MEMBERS_JSON,
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { buildDreamPrompt } from './dream-prompt.js';
import { log, logError } from './logger.js';

// ── Configuration ───────────────────────────────────────────────────

const DREAM_CHECK_INTERVAL_MS = 30 * 60 * 1000; // Check gates every 30 min
const DEFAULT_MIN_HOURS = 24;                     // 24h between dreams
const DEFAULT_MIN_SESSIONS = 5;                   // 5 work sessions minimum
const LOCK_STALE_MS = 60 * 60 * 1000;            // Lock stale after 1 hour (from source)
const DREAM_TIMEOUT_MS = 5 * 60 * 1000;          // 5 min timeout per dream
const SESSION_HEADER_RE = /^## Session/m;         // WORKLOG.md session boundary marker

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

  constructor(daemon: Daemon) {
    this.daemon = daemon;
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
   * Check all agents' gates and dispatch dreams for those that qualify.
   * Dispatches are concurrent — OpenClaw's maxConcurrent handles throttling.
   */
  private async dreamCycle(): Promise<void> {
    let members: Member[];
    try {
      members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    } catch { return; }

    const agents = members.filter(m => m.type === 'agent' && m.status === 'active' && m.agentDir);
    if (agents.length === 0) return;

    let dreamCount = 0;
    for (const agent of agents) {
      if (this.dreaming.has(agent.id)) continue;

      const agentDir = join(this.daemon.corpRoot, agent.agentDir!);
      if (!existsSync(agentDir)) continue;

      // Check if this agent's process is online
      const agentProc = this.daemon.processManager.getAgent(agent.id);
      if (!agentProc || agentProc.status !== 'ready') continue;

      // Check gates
      const gateResult = this.checkGates(agentDir, agent.displayName);
      if (!gateResult.open) continue;

      // Dispatch dream (non-blocking — don't await, let them run in parallel)
      dreamCount++;
      this.dispatchDream(agent, agentDir, gateResult.hoursSince, gateResult.sessionsSince);
    }

    if (dreamCount > 0) {
      log(`[dreams] Dispatched ${dreamCount} dream(s) this cycle`);
    }
  }

  // ── Gate Checks ─────────────────────────────────────────────────

  private checkGates(agentDir: string, displayName: string): {
    open: boolean;
    hoursSince: number;
    sessionsSince: number;
  } {
    const closed = { open: false, hoursSince: 0, sessionsSince: 0 };

    // Gate 1: Time — hours since last dream
    const state = this.readDreamState(agentDir);
    const hoursSince = (Date.now() - state.lastDreamAt) / 3_600_000;
    if (hoursSince < DEFAULT_MIN_HOURS) return closed;

    // Gate 2: Sessions — count WORKLOG.md session boundaries since last dream
    const sessionsSince = this.countSessionsSince(agentDir, state.lastDreamAt);
    if (sessionsSince < DEFAULT_MIN_SESSIONS) return closed;

    // Gate 3: Lock — no other dream in progress
    if (!this.tryAcquireLock(agentDir)) {
      log(`[dreams] ${displayName} — lock held, skipping`);
      return closed;
    }

    log(`[dreams] ${displayName} gates open — ${hoursSince.toFixed(1)}h since last, ${sessionsSince} sessions`);
    return { open: true, hoursSince, sessionsSince };
  }

  /**
   * Count session boundaries in WORKLOG.md since a given timestamp.
   * Session boundaries are "## Session" headers written by the Casket system.
   * We scan for timestamps in the headers that are after lastDreamAt.
   */
  private countSessionsSince(agentDir: string, sinceMs: number): number {
    const worklogPath = join(agentDir, 'WORKLOG.md');
    if (!existsSync(worklogPath)) return 0;

    try {
      const content = readFileSync(worklogPath, 'utf-8');
      const lines = content.split('\n');
      let count = 0;

      for (const line of lines) {
        if (!SESSION_HEADER_RE.test(line)) continue;
        // Try to extract timestamp from the session header
        // Format: "## Session — 2026-03-31T14:00:00.000Z" or similar
        const isoMatch = line.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/);
        if (isoMatch) {
          const ts = new Date(isoMatch[0]).getTime();
          if (ts > sinceMs) count++;
        } else {
          // No parseable timestamp — count it if WORKLOG.md mtime > sinceMs
          // (conservative: if we can't parse, assume it's recent)
          const stat = statSync(worklogPath);
          if (stat.mtimeMs > sinceMs) count++;
          break; // Only count once for unparseable headers
        }
      }

      return count;
    } catch {
      return 0;
    }
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
      const prompt = buildDreamPrompt({
        agentName: agent.displayName,
        agentDir: agentDir.replace(/\\/g, '/'),
        corpRoot: this.daemon.corpRoot.replace(/\\/g, '/'),
        sessionsSince,
        hoursSinceLast: hoursSince,
      });

      const resp = await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: slug,
          message: prompt,
          sessionKey: `dream:${slug}:${Date.now()}`,
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
