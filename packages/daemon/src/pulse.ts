import { readConfig, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { join } from 'node:path';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

const CHECK_INTERVAL_MS = 2 * 60 * 1000; // Every 2 minutes
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes busy = stuck
const FAILSAFE_STALE_MS = 5 * 60 * 1000; // If Failsafe agent hasn't responded in 5 min, restart

/**
 * Pulse — daemon-level heartbeat timer.
 * Monitors all agents for broken/stuck state. Restarts broken agents.
 * Also monitors the Failsafe agent itself.
 */
export class Pulse {
  private daemon: Daemon;
  private interval: ReturnType<typeof setInterval> | null = null;
  /** Track when each agent entered busy state */
  private busySince = new Map<string, number>();
  private failsafeAgentId: string | null = null;
  private failsafeLastSeen = 0;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    this.findFailsafe();

    // Track busy transitions via the existing onAgentIdle callback
    this.daemon.onAgentIdle((memberId) => {
      this.busySince.delete(memberId);
      if (memberId === this.failsafeAgentId) {
        this.failsafeLastSeen = Date.now();
      }
    });

    this.interval = this.daemon.clocks.register({
      id: 'pulse-monitor',
      name: 'Pulse Monitor',
      type: 'timer',
      intervalMs: CHECK_INTERVAL_MS,
      target: 'all agents',
      description: 'Scans all agents for broken/stuck state, restarts broken ones, monitors Failsafe',
      callback: () => this.check(),
    });
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  /** Re-scan members for Failsafe agent (called after bootstrap) */
  refreshFailsafe(): void {
    this.findFailsafe();
  }

  private findFailsafe(): void {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const failsafe = members.find(m => m.displayName === 'Failsafe' && m.type === 'agent');
      if (failsafe) {
        this.failsafeAgentId = failsafe.id;
        this.failsafeLastSeen = Date.now();
        log(`[pulse] Failsafe agent found: ${failsafe.id}`);
      }
    } catch {}
  }

  private async check(): Promise<void> {
    const now = Date.now();

    try {
      const agents = this.daemon.processManager.listAgents();

      for (const agent of agents) {
        const workStatus = this.daemon.getAgentWorkStatus(agent.memberId);

        // Track busy start times
        if (workStatus === 'busy' && !this.busySince.has(agent.memberId)) {
          this.busySince.set(agent.memberId, now);
        }

        // Restart broken agents
        if (workStatus === 'broken') {
          log(`[pulse] ${agent.displayName} is broken — restarting`);
          try {
            await this.daemon.processManager.stopAgent(agent.memberId);
            await new Promise(r => setTimeout(r, 1000));
            await this.daemon.processManager.spawnAgent(agent.memberId);
            this.daemon.setAgentWorkStatus(agent.memberId, agent.displayName, 'idle');
            log(`[pulse] ${agent.displayName} restarted successfully`);
          } catch (err) {
            logError(`[pulse] Failed to restart ${agent.displayName}: ${err}`);
          }
        }

        // Detect stuck agents (busy for too long)
        if (workStatus === 'busy') {
          const since = this.busySince.get(agent.memberId);
          if (since && (now - since) > STUCK_THRESHOLD_MS) {
            log(`[pulse] ${agent.displayName} stuck (busy ${Math.round((now - since) / 60000)}m)`);
          }
        }
      }

      // Monitor Failsafe agent
      if (this.failsafeAgentId && this.failsafeLastSeen > 0) {
        if ((now - this.failsafeLastSeen) > FAILSAFE_STALE_MS) {
          log(`[pulse] Failsafe agent stale — restarting`);
          try {
            await this.daemon.processManager.stopAgent(this.failsafeAgentId);
            await new Promise(r => setTimeout(r, 1000));
            await this.daemon.processManager.spawnAgent(this.failsafeAgentId);
            this.daemon.setAgentWorkStatus(this.failsafeAgentId, 'Failsafe', 'idle');
            this.failsafeLastSeen = Date.now();
          } catch (err) {
            logError(`[pulse] Failed to restart Failsafe: ${err}`);
          }
        }
      }
    } catch (err) {
      logError(`[pulse] Check failed: ${err}`);
    }
  }
}
