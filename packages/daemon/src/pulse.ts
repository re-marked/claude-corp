import { readConfig, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { join } from 'node:path';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

const CHECK_INTERVAL_MS = 3 * 60 * 1000; // Every 3 minutes
const PING_TIMEOUT_MS = 30_000; // 30s timeout per agent ping
const STUCK_THRESHOLD_MS = 8 * 60 * 1000; // 8 minutes busy = stuck
const MAX_MISSED_BEFORE_ESCALATE = 2; // 2 missed heartbeats → escalate

/** Two-state heartbeat messages */
const IDLE_HEARTBEAT = 'HEARTBEAT: You are idle. Check your Casket — read TASKS.md and INBOX.md for pending work. If nothing needs attention, reply HEARTBEAT_OK.';
const BUSY_HEARTBEAT = 'HEARTBEAT: Quick check-in. Reply HEARTBEAT_OK to confirm you are working normally. Do NOT stop your current task.';

interface AgentHeartbeatState {
  /** Consecutive missed heartbeats (no response) */
  missedCount: number;
  /** Last successful heartbeat response timestamp */
  lastResponseAt: number;
  /** Whether we've already escalated this agent to CEO */
  escalated: boolean;
  /** When the agent entered busy state */
  busySince: number | null;
}

/**
 * Pulse — smart two-state heartbeat system.
 *
 * Every 3 minutes, pings each agent based on their work status:
 * - IDLE → "Check your Casket and Inbox for pending work"
 * - BUSY → lightweight "HEARTBEAT_OK?" ping
 *
 * Tracks responses. If an agent doesn't respond:
 * - 1 miss → logged, retry next cycle
 * - 2 misses → escalated to CEO via Failsafe with reason
 *
 * System agents (Failsafe, Janitor, Warden, Herald) are pinged too.
 * The only exception: don't ping an agent that's currently being dispatched to
 * by the heartbeat itself (prevents recursion).
 */
export class Pulse {
  private daemon: Daemon;
  private interval: ReturnType<typeof setInterval> | null = null;
  private agentStates = new Map<string, AgentHeartbeatState>();
  /** Agents currently being pinged (prevent concurrent pings to same agent) */
  private pinging = new Set<string>();

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    this.interval = this.daemon.clocks.register({
      id: 'pulse-heartbeat',
      name: 'Pulse Heartbeat',
      type: 'heartbeat',
      intervalMs: CHECK_INTERVAL_MS,
      target: 'all agents',
      description: 'Smart two-state heartbeat: IDLE → check casket, BUSY → quick ping. Escalates non-responders to CEO.',
      callback: () => this.heartbeatCycle(),
    });
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  /** Re-scan members — called after bootstrap adds new agents. */
  refreshFailsafe(): void {
    // No-op now — we discover agents dynamically each cycle
  }

  // ── Core Heartbeat Cycle ───────────────────────────────────────────

  private async heartbeatCycle(): Promise<void> {
    const agents = this.daemon.processManager.listAgents();
    const now = Date.now();

    // Filter to only online agents
    const online = agents.filter(a => a.status === 'ready');
    if (online.length === 0) return;

    log(`[pulse] Heartbeat cycle — ${online.length} agents online`);

    // Ping all agents concurrently (with individual timeouts)
    const results = await Promise.allSettled(
      online.map(agent => this.pingAgent(agent.memberId, agent.displayName, now)),
    );

    // Count results
    let responded = 0;
    let missed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) responded++;
      else missed++;
    }

    log(`[pulse] Heartbeat results: ${responded} responded, ${missed} missed`);

    // Check for agents that need escalation
    await this.checkEscalations(now);
  }

  // ── Per-Agent Ping ────────────────────────────────────────────────

  private async pingAgent(memberId: string, displayName: string, now: number): Promise<boolean> {
    // Don't ping if already pinging (prevents stacking)
    if (this.pinging.has(memberId)) {
      log(`[pulse] Skipping ${displayName} — previous ping still in progress`);
      return true; // Don't count as missed
    }

    // Initialize state if new
    if (!this.agentStates.has(memberId)) {
      this.agentStates.set(memberId, {
        missedCount: 0,
        lastResponseAt: now,
        escalated: false,
        busySince: null,
      });
    }
    const state = this.agentStates.get(memberId)!;

    // Determine work status → choose heartbeat message
    const workStatus = this.daemon.getAgentWorkStatus(memberId);
    const isBusy = workStatus === 'busy';
    const message = isBusy ? BUSY_HEARTBEAT : IDLE_HEARTBEAT;

    // Track busy duration
    if (isBusy && !state.busySince) {
      state.busySince = now;
    } else if (!isBusy) {
      state.busySince = null;
    }

    // Detect stuck (busy too long)
    if (isBusy && state.busySince && (now - state.busySince) > STUCK_THRESHOLD_MS) {
      log(`[pulse] ${displayName} stuck — busy for ${Math.round((now - state.busySince) / 60_000)}m`);
    }

    this.pinging.add(memberId);
    try {
      const agentSlug = displayName.toLowerCase().replace(/\s+/g, '-');
      const resp = await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: agentSlug,
          message,
          sessionKey: `heartbeat:${agentSlug}`,
        }),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });

      const data = await resp.json() as Record<string, unknown>;

      if (data.ok) {
        // Agent responded — reset missed count
        state.missedCount = 0;
        state.lastResponseAt = now;
        state.escalated = false;

        const response = (data.response as string ?? '').trim();
        const isOk = response.includes('HEARTBEAT_OK') || response.length > 0;

        if (isOk) {
          log(`[pulse] ${displayName} ${isBusy ? '(busy)' : '(idle)'} — responded OK`);
        }
        return true;
      } else {
        // Dispatch failed (agent error, not network)
        state.missedCount++;
        log(`[pulse] ${displayName} — dispatch failed: ${data.error ?? 'unknown'} (miss ${state.missedCount})`);
        return false;
      }
    } catch (err) {
      // Timeout or network error
      state.missedCount++;
      const msg = err instanceof Error ? err.message : String(err);
      log(`[pulse] ${displayName} — no response: ${msg} (miss ${state.missedCount})`);
      return false;
    } finally {
      this.pinging.delete(memberId);
    }
  }

  // ── Escalation ────────────────────────────────────────────────────

  private async checkEscalations(now: number): Promise<void> {
    const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');

    for (const [memberId, state] of this.agentStates) {
      if (state.missedCount < MAX_MISSED_BEFORE_ESCALATE) continue;
      if (state.escalated) continue; // Already escalated, don't spam CEO

      const agent = members.find(m => m.id === memberId);
      if (!agent) continue;

      // Don't escalate CEO to CEO
      if (agent.rank === 'master') continue;

      // Determine the reason
      const agentProc = this.daemon.processManager.getAgent(memberId);
      let reason: string;
      if (!agentProc) {
        reason = 'not registered in process manager';
      } else if (agentProc.status === 'crashed') {
        reason = 'process crashed';
      } else if (agentProc.status === 'stopped') {
        reason = 'process stopped';
      } else {
        const workStatus = this.daemon.getAgentWorkStatus(memberId);
        if (workStatus === 'busy' && state.busySince) {
          reason = `stuck busy for ${Math.round((now - state.busySince) / 60_000)} minutes — not responding to heartbeat`;
        } else {
          reason = `not responding to heartbeat (${state.missedCount} consecutive misses)`;
        }
      }

      logError(`[pulse] ESCALATING: ${agent.displayName} — ${reason}`);
      state.escalated = true;

      // Escalate to CEO
      if (ceo) {
        try {
          await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              target: 'ceo',
              message: `ESCALATION from Pulse: Agent "${agent.displayName}" is unresponsive. Reason: ${reason}. Missed ${state.missedCount} consecutive heartbeats. Please investigate — the agent may need to be restarted or the issue may need founder attention.`,
              sessionKey: `pulse-escalation:${Date.now()}`,
            }),
            signal: AbortSignal.timeout(60_000),
          });
          log(`[pulse] Escalation sent to CEO about ${agent.displayName}`);
        } catch (err) {
          logError(`[pulse] Failed to escalate to CEO: ${err}`);
        }
      }
    }
  }
}
