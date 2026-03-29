import { readConfig, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { join } from 'node:path';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

const CHECK_INTERVAL_MS = 2 * 60 * 1000; // Every 2 minutes
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes busy = stuck
const PULSE_STALE_MS = 10 * 60 * 1000; // If Pulse hasn't responded in 10 min, restart

/**
 * Failsafe — daemon-level watchdog.
 * Monitors all agents for broken/stuck state. Restarts broken agents.
 * Also monitors the Pulse agent itself.
 */
export class Failsafe {
  private daemon: Daemon;
  private interval: ReturnType<typeof setInterval> | null = null;
  /** Track when each agent entered busy state */
  private busySince = new Map<string, number>();
  private pulseAgentId: string | null = null;
  private pulseLastSeen = 0;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    this.findPulse();

    // Track busy transitions via the existing onAgentIdle callback
    this.daemon.onAgentIdle((memberId) => {
      this.busySince.delete(memberId);
      if (memberId === this.pulseAgentId) {
        this.pulseLastSeen = Date.now();
      }
    });

    this.interval = setInterval(() => {
      this.check();
    }, CHECK_INTERVAL_MS);

    log('[failsafe] Started (checking every 2m)');
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  private findPulse(): void {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const pulse = members.find(m => m.displayName === 'Pulse' && m.type === 'agent');
      if (pulse) {
        this.pulseAgentId = pulse.id;
        this.pulseLastSeen = Date.now();
        log(`[failsafe] Pulse agent found: ${pulse.id}`);
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
          log(`[failsafe] ${agent.displayName} is broken — restarting`);
          try {
            await this.daemon.processManager.stopAgent(agent.memberId);
            await new Promise(r => setTimeout(r, 1000));
            await this.daemon.processManager.spawnAgent(agent.memberId);
            this.daemon.setAgentWorkStatus(agent.memberId, agent.displayName, 'idle');
            log(`[failsafe] ${agent.displayName} restarted successfully`);
          } catch (err) {
            logError(`[failsafe] Failed to restart ${agent.displayName}: ${err}`);
          }
        }

        // Detect stuck agents (busy for too long)
        if (workStatus === 'busy') {
          const since = this.busySince.get(agent.memberId);
          if (since && (now - since) > STUCK_THRESHOLD_MS) {
            log(`[failsafe] ${agent.displayName} stuck (busy ${Math.round((now - since) / 60000)}m)`);
          }
        }
      }

      // Monitor Pulse
      if (this.pulseAgentId && this.pulseLastSeen > 0) {
        if ((now - this.pulseLastSeen) > PULSE_STALE_MS) {
          log(`[failsafe] Pulse stale — restarting`);
          try {
            await this.daemon.processManager.stopAgent(this.pulseAgentId);
            await new Promise(r => setTimeout(r, 1000));
            await this.daemon.processManager.spawnAgent(this.pulseAgentId);
            this.daemon.setAgentWorkStatus(this.pulseAgentId, 'Pulse', 'idle');
            this.pulseLastSeen = Date.now();
          } catch (err) {
            logError(`[failsafe] Failed to restart Pulse: ${err}`);
          }
        }
      }
    } catch (err) {
      logError(`[failsafe] Check failed: ${err}`);
    }
  }
}
