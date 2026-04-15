/**
 * Daemon Recovery — self-healing subsystem.
 *
 * Three recovery clocks run on the daemon:
 * 1. Agent Recovery (30s) — detects crashed agents, respawns with 5-attempt limit
 * 2. CEO Gateway Recovery (30s) — health pings CEO's OpenClaw, reconnects WebSocket
 * 3. Corp Gateway Recovery (60s) — picks up after autoRestart exhausts, restores workers
 *
 * Extracted from daemon.ts to keep the main class focused on lifecycle and coordination.
 */

import { join } from 'node:path';
import { readConfig, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { OpenClawWS } from './openclaw-ws.js';
import { log, logError } from './logger.js';
import type { Daemon } from './daemon.js';

// ── State ──────────────────────────────────────────────────────────

/** Per-agent respawn attempt counter. Resets when all agents are healthy. */
const recoveryAttempts = new Map<string, number>();
const MAX_RECOVERY_ATTEMPTS = 5;

let ceoRecoveryFailures = 0;
let corpGatewayRecoveryAttempts = 0;

/** Reset all recovery state (called on daemon restart). */
export function resetRecoveryState(): void {
  recoveryAttempts.clear();
  ceoRecoveryFailures = 0;
  corpGatewayRecoveryAttempts = 0;
}

// ── Agent Recovery ─────────────────────────────────────────────────

/**
 * Detect crashed agents and attempt to respawn them.
 * Gives up after MAX_RECOVERY_ATTEMPTS consecutive failures per agent.
 */
export async function recoverCrashedAgents(daemon: Daemon): Promise<void> {
  const agents = daemon.processManager.listAgents();
  const crashed = agents.filter(a => a.status === 'crashed');

  if (crashed.length === 0) {
    recoveryAttempts.clear();
    return;
  }

  for (const agent of crashed) {
    const attempts = recoveryAttempts.get(agent.memberId) ?? 0;

    if (attempts >= MAX_RECOVERY_ATTEMPTS) {
      if (attempts === MAX_RECOVERY_ATTEMPTS) {
        logError(`[recovery] ${agent.displayName} — gave up after ${attempts} attempts. Manual restart needed.`);
        recoveryAttempts.set(agent.memberId, attempts + 1);
        daemon.analytics.trackError(agent.memberId);
      }
      continue;
    }

    recoveryAttempts.set(agent.memberId, attempts + 1);
    log(`[recovery] ${agent.displayName} crashed — attempting respawn (attempt ${attempts + 1}/${MAX_RECOVERY_ATTEMPTS})`);

    try {
      await daemon.processManager.stopAgent(agent.memberId);
      await new Promise(r => setTimeout(r, 1000));
      const respawned = await daemon.processManager.spawnAgent(agent.memberId);

      if (respawned.status === 'ready' || respawned.status === 'starting') {
        log(`[recovery] ${agent.displayName} respawned successfully (status: ${respawned.status})`);
        recoveryAttempts.delete(agent.memberId);

        if (respawned.mode === 'remote' || respawned.mode === 'local') {
          try {
            daemon.openclawWS = new OpenClawWS(respawned.port, respawned.gatewayToken);
            await daemon.openclawWS.connect();
          } catch {}
        }

        daemon.setAgentWorkStatus(agent.memberId, agent.displayName, 'idle');

        const queued = daemon.inbox.peekNext(agent.memberId);
        if (queued) {
          log(`[recovery] ${agent.displayName} has queued work — inbox will dispatch on next idle`);
        }

        daemon.analytics.trackStatusChange(agent.memberId, agent.displayName, 'idle');
      } else {
        logError(`[recovery] ${agent.displayName} respawn returned status: ${respawned.status}`);
      }
    } catch (err) {
      logError(`[recovery] ${agent.displayName} respawn failed: ${err}`);
    }
  }
}

// ── CEO Gateway Recovery ───────────────────────────────────────────

/**
 * Verify the CEO's OpenClaw gateway is reachable.
 * If unreachable 3 times: mark crashed so agent-recovery handles respawn.
 * If reachable but WebSocket disconnected: reconnect.
 *
 * Skips harness-mode CEOs entirely — a claude-code CEO has no listening
 * gateway port (port=0, gatewayToken=''), so the HTTP ping below would
 * always fail and after 3 ticks (~90s) we'd mark a perfectly healthy
 * CEO as crashed. The next dispatch then errors with "Agent CEO is
 * not online" — which is exactly what Mark hit on a fresh claude-code
 * corp once the recovery clock fired enough times. Recovery for
 * harness-mode agents is the harness's own job: each dispatch spawns
 * a fresh subprocess, so there's nothing to keep alive between ticks.
 */
export async function recoverCeoGateway(daemon: Daemon): Promise<void> {
  try {
    const members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
    const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
    if (!ceo) return;

    const agentProc = daemon.processManager.getAgent(ceo.id);
    if (!agentProc) return;
    if (agentProc.mode === 'harness') return;
    if (agentProc.status === 'crashed' || agentProc.status === 'stopped') return;

    try {
      const resp = await fetch(`http://127.0.0.1:${agentProc.port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${agentProc.gatewayToken}`,
        },
        body: JSON.stringify({ model: agentProc.model, messages: [] }),
        signal: AbortSignal.timeout(3000),
      });

      if (resp.status >= 500) throw new Error(`HTTP ${resp.status}`);

      ceoRecoveryFailures = 0;

      // Check WebSocket — reconnect if disconnected
      const wsClient = agentProc.mode === 'remote' ? daemon.openclawWS : null;
      if (agentProc.mode === 'remote' && (!wsClient || !wsClient.isConnected())) {
        log('[ceo-recovery] WebSocket disconnected — reconnecting...');
        try {
          daemon.openclawWS = new OpenClawWS(agentProc.port, agentProc.gatewayToken);
          await daemon.openclawWS.connect();
          log('[ceo-recovery] WebSocket reconnected');
        } catch {
          logError('[ceo-recovery] WebSocket reconnect failed (HTTP fallback active)');
        }
      }

      if (agentProc.mode === 'local' && (!daemon.openclawWS || !daemon.openclawWS.isConnected())) {
        try {
          daemon.openclawWS = new OpenClawWS(agentProc.port, agentProc.gatewayToken);
          await daemon.openclawWS.connect();
          log('[ceo-recovery] Local CEO WebSocket reconnected');
        } catch {}
      }
    } catch {
      ceoRecoveryFailures++;

      if (ceoRecoveryFailures >= 3) {
        if (agentProc.mode === 'remote') {
          log('[ceo-recovery] CEO remote gateway dead — attempting to start OpenClaw...');
          try {
            const { execa: run } = await import('execa');
            const gw = daemon.globalConfig.userGateway;
            if (gw) {
              const proc = run('openclaw', ['gateway', 'run'], {
                stdio: 'pipe',
                reject: false,
                detached: true,
              });
              proc.unref?.();
              await new Promise(r => setTimeout(r, 5000));

              try {
                const check = await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gw.token}` },
                  body: JSON.stringify({ model: 'openclaw:main', messages: [] }),
                  signal: AbortSignal.timeout(3000),
                });
                if (check.status < 500) {
                  log('[ceo-recovery] OpenClaw started successfully — CEO will recover on next agent-recovery tick');
                  ceoRecoveryFailures = 0;
                }
              } catch {
                logError('[ceo-recovery] OpenClaw start attempted but gateway still unreachable');
              }
            }
          } catch (err) {
            logError(`[ceo-recovery] Failed to start OpenClaw: ${err}`);
          }
        }

        logError(`[ceo-recovery] CEO gateway unreachable (${ceoRecoveryFailures} consecutive failures) — marking crashed`);
        agentProc.status = 'crashed';
        ceoRecoveryFailures = 0;
      } else {
        log(`[ceo-recovery] CEO gateway ping failed (${ceoRecoveryFailures}/3)`);
      }
    }
  } catch (err) {
    logError(`[ceo-recovery] Unexpected error: ${err}`);
  }
}

// ── Corp Gateway Recovery ──────────────────────────────────────────

/**
 * Corp Gateway Recovery — picks up after autoRestart exhausts.
 * Reconnects WebSocket and updates worker agent statuses.
 */
export async function recoverCorpGateway(daemon: Daemon): Promise<void> {
  try {
    const corpGw = daemon.processManager.corpGateway;
    if (!corpGw) return;

    const gwStatus = corpGw.getStatus();

    if (gwStatus === 'ready') {
      corpGatewayRecoveryAttempts = 0;

      if (!daemon.corpGatewayWS || !daemon.corpGatewayWS.isConnected()) {
        try {
          daemon.corpGatewayWS = new OpenClawWS(corpGw.getPort(), corpGw.getToken());
          await daemon.corpGatewayWS.connect();
          log('[corp-gw-recovery] WebSocket reconnected to corp gateway');
        } catch {}
      }

      const agents = daemon.processManager.listAgents();
      for (const agent of agents) {
        if (agent.mode === 'gateway' && agent.status !== 'ready') {
          agent.status = 'ready';
          agent.port = corpGw.getPort();
          agent.gatewayToken = corpGw.getToken();
          log(`[corp-gw-recovery] Updated ${agent.displayName} → ready (gateway is healthy)`);
        }
      }
      return;
    }

    if (gwStatus === 'stopped' && corpGw.hasAgents()) {
      corpGatewayRecoveryAttempts++;

      if (corpGatewayRecoveryAttempts > 10) {
        if (corpGatewayRecoveryAttempts === 11) {
          logError('[corp-gw-recovery] Exhausted 10 recovery attempts — corp gateway is down. Restart TUI to recover.');
        }
        return;
      }

      log(`[corp-gw-recovery] Corp gateway stopped — attempting recovery (attempt ${corpGatewayRecoveryAttempts}/10)`);

      try {
        corpGw.refreshAllAuth();
        await corpGw.start();
        log(`[corp-gw-recovery] Corp gateway recovered on port ${corpGw.getPort()}`);

        try {
          daemon.corpGatewayWS = new OpenClawWS(corpGw.getPort(), corpGw.getToken());
          await daemon.corpGatewayWS.connect();
          log('[corp-gw-recovery] WebSocket connected to recovered corp gateway');
        } catch {
          logError('[corp-gw-recovery] WebSocket connect failed after recovery');
        }

        const agents = daemon.processManager.listAgents();
        for (const agent of agents) {
          if (agent.mode === 'gateway') {
            agent.status = 'ready';
            agent.port = corpGw.getPort();
            agent.gatewayToken = corpGw.getToken();
            daemon.setAgentWorkStatus(agent.memberId, agent.displayName, 'idle');
            log(`[corp-gw-recovery] ${agent.displayName} → ready`);
          }
        }

        corpGatewayRecoveryAttempts = 0;
      } catch (err) {
        logError(`[corp-gw-recovery] Recovery failed: ${err}`);
      }
    }
  } catch (err) {
    logError(`[corp-gw-recovery] Unexpected error: ${err}`);
  }
}
