import { readConfig, agentSessionKey, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { join } from 'node:path';
import type { Daemon } from '../daemon.js';
import { log, logError } from '../logger.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes
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
 * - 2 misses → escalated to CEO with reason
 *
 * System agents (Sexton, Janitor, Warden, Herald) are pinged too.
 * The only exception: don't ping an agent that's currently being dispatched to
 * by the heartbeat itself (prevents recursion).
 *
 * Project 1.9 shape change (future PR): this whole heartbeat mechanism
 * becomes a tick-and-fire-Alarum skeleton — Pulse stops pinging agents
 * directly; Alarum spawns each tick and decides whether to wake Sexton,
 * who runs patrol blueprints that dispatch sweepers to check agent
 * state. Current behavior preserved until the runtime-skeleton PR
 * lands.
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

  // ── Core Heartbeat Cycle ───────────────────────────────────────────

  private async heartbeatCycle(): Promise<void> {
    const agents = this.daemon.processManager.listAgents();
    const now = Date.now();

    // Filter to only online agents
    const online = agents.filter(a => a.status === 'ready');
    if (online.length === 0) return;

    log(`[pulse] Heartbeat cycle — ${online.length} agents online`);

    // Stagger pings with 1.5s delay between each — prevents thundering herd
    // on a single API key. Sequential, not concurrent.
    let responded = 0;
    let missed = 0;
    let skippedAutoemon = 0;
    for (let i = 0; i < online.length; i++) {
      const agent = online[i]!;

      // Skip agents enrolled in autoemon — they receive <tick> prompts instead
      if (this.daemon.autoemon?.isEnrolled(agent.memberId)) {
        skippedAutoemon++;
        continue;
      }

      if (i > 0) await new Promise(r => setTimeout(r, 1500));
      try {
        const ok = await this.pingAgent(agent.memberId, agent.displayName, now);
        if (ok) responded++; else missed++;
      } catch {
        missed++;
      }
    }

    const autoemonNote = skippedAutoemon > 0 ? `, ${skippedAutoemon} on autoemon` : '';
    log(`[pulse] Heartbeat results: ${responded} responded, ${missed} missed${autoemonNote}`);

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
          sessionKey: agentSessionKey(agentSlug),
        }),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });

      const data = await resp.json() as Record<string, unknown>;

      if (data.ok) {
        // Agent responded — check if recovering from escalation
        const wasEscalated = state.escalated;
        state.missedCount = 0;
        state.lastResponseAt = now;
        state.escalated = false;

        log(`[pulse] ${displayName} ${isBusy ? '(busy)' : '(idle)'} — responded OK`);

        // Recovery notification — tell CEO the agent is back. Routed
        // into the CEO's main jack:<slug> thread so the recovery lands
        // in the same conversation where the escalation arrived —
        // the CEO sees "Herald crashed" and "Herald recovered" as two
        // messages in one coherent thread, with full memory of what
        // was happening in between. Previous `pulse-recovery:${ts}`
        // key minted a fresh claude session every fire, so each
        // recovery was context-free.
        if (wasEscalated) {
          log(`[pulse] ${displayName} RECOVERED after escalation`);
          try {
            await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                target: 'ceo',
                message: `RECOVERY: Agent "${displayName}" is back online and responding to heartbeats. Previous escalation resolved.`,
                sessionKey: agentSessionKey('ceo'),
              }),
              signal: AbortSignal.timeout(30_000),
            });
          } catch {} // Non-fatal
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

      // Don't escalate agents enrolled in autoemon — autoemon handles their health
      if (this.daemon.autoemon?.isEnrolled(memberId)) continue;

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

      // Escalate to CEO, landing in its main jack:ceo thread so the
      // escalation arrives with full conversational context (CEO knows
      // what the corp was doing when Herald stopped responding) and
      // the recovery notification below lands in the same thread.
      // Previous `pulse-escalation:${ts}` key minted a fresh session
      // for every escalation — each time the CEO saw an escalation it
      // was from a stranger persona that didn't remember the chat.
      if (ceo) {
        try {
          await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              target: 'ceo',
              message: `ESCALATION from Pulse: Agent "${agent.displayName}" is unresponsive. Reason: ${reason}. Missed ${state.missedCount} consecutive heartbeats. Please investigate — the agent may need to be restarted or the issue may need founder attention.`,
              sessionKey: agentSessionKey('ceo'),
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
