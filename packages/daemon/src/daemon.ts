import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import {
  type Member,
  type Channel,
  type ChannelMessage,
  type GlobalConfig,
  type AgentWorkStatus,
  readConfig,
  appendMessage,
  generateId,
  resolveMentions,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
  DAEMON_PID_PATH,
  DAEMON_PORT_PATH,
} from '@claudecorp/shared';
import { ProcessManager } from './process-manager.js';
import { MessageRouter } from './router.js';
import { GitManager } from './git-manager.js';
import { HeartbeatManager } from './heartbeat.js';
import { TaskWatcher } from './task-watcher.js';
import { HireWatcher } from './hire-watcher.js';
import { EventBus, type DaemonEvent } from './events.js';
import { InboxManager } from './inbox.js';
import { Pulse } from './pulse.js';
import { hireFailsafe } from './failsafe.js';
import { hireJanitor } from './janitor.js';
import { hireWarden } from './warden.js';
import { hireHerald } from './herald.js';
import { ContractWatcher } from './contract-watcher.js';
import { ClockManager } from './clock-manager.js';
import { LoopManager } from './loops.js';
import { CronManager } from './crons.js';
import { AnalyticsEngine } from './analytics.js';
import { OpenClawWS } from './openclaw-ws.js';
import { createApi } from './api.js';
import { log, logError } from './logger.js';

export class Daemon {
  corpRoot: string;
  globalConfig: GlobalConfig;
  processManager: ProcessManager;
  router: MessageRouter;
  gitManager: GitManager;
  heartbeat: HeartbeatManager;
  taskWatcher: TaskWatcher;
  hireWatcher: HireWatcher;
  pulse: Pulse;
  contractWatcher: ContractWatcher;
  clocks: ClockManager;
  loops: LoopManager;
  crons: CronManager;
  analytics: AnalyticsEngine;
  readonly startedAt: number = Date.now();
  /** Per-agent partial streaming content — updated as SSE tokens arrive. */
  streaming = new Map<string, { agentName: string; content: string; channelId: string }>();
  /** Computed work status per agent (memberId → status) */
  agentWorkStatus = new Map<string, AgentWorkStatus>();
  /** Agent inbox system — tracks unread messages per channel per agent */
  inbox = new InboxManager();
  /** Callbacks for busy→idle transition (Phase 3: inbox system will use this) */
  private onIdleCallbacks: ((memberId: string, displayName: string) => void)[] = [];
  /** WebSocket event bus for real-time TUI updates. */
  events = new EventBus();
  /** WebSocket to user's personal OpenClaw (for CEO dispatch with tool events). */
  openclawWS: OpenClawWS | null = null;
  /** WebSocket to corp gateway (for worker dispatch with tool events). */
  corpGatewayWS: OpenClawWS | null = null;
  /** Track consecutive overloaded errors per agent for gateway restart logic */
  overloadCounts = new Map<string, number>();
  private server: Server | null = null;
  private port = 0;

  constructor(corpRoot: string, globalConfig: GlobalConfig) {
    this.corpRoot = corpRoot;
    this.globalConfig = globalConfig;
    this.processManager = new ProcessManager(corpRoot, globalConfig);
    this.router = new MessageRouter(this);
    this.gitManager = new GitManager(corpRoot);
    this.heartbeat = new HeartbeatManager(this);
    this.taskWatcher = new TaskWatcher(this);
    this.hireWatcher = new HireWatcher(this);
    this.pulse = new Pulse(this);
    this.contractWatcher = new ContractWatcher(this);
    this.clocks = new ClockManager(this.events);
    this.loops = new LoopManager(this);
    this.crons = new CronManager(this);
    this.analytics = new AnalyticsEngine(this);
    this.inbox.setCorpRoot(corpRoot); // Enable inbox persistence
  }

  // --- Agent Work Status Engine ---

  /** Register a callback for when an agent transitions busy→idle */
  onAgentIdle(cb: (memberId: string, displayName: string) => void): void {
    this.onIdleCallbacks.push(cb);
  }

  /** Update agent work status + broadcast event + fire transition callbacks + analytics */
  setAgentWorkStatus(memberId: string, displayName: string, status: AgentWorkStatus): void {
    const prev = this.agentWorkStatus.get(memberId);
    if (prev === status) return;
    this.agentWorkStatus.set(memberId, status);
    this.events.broadcast({ type: 'agent_status', agentName: displayName, status });
    log(`[status] ${displayName}: ${prev ?? 'unknown'} → ${status}`);

    // Track status transitions for analytics (utilization calculation)
    this.analytics.trackStatusChange(memberId, displayName, status);
    if (status === 'busy') this.analytics.trackDispatch(memberId);

    if (prev === 'busy' && status === 'idle') {
      for (const cb of this.onIdleCallbacks) cb(memberId, displayName);
    }
  }

  /** Get computed work status for an agent */
  getAgentWorkStatus(memberId: string): AgentWorkStatus {
    return this.agentWorkStatus.get(memberId) ?? 'offline';
  }

  /** Initialize work status for all spawned agents */
  initAgentWorkStatuses(): void {
    for (const agent of this.processManager.listAgents()) {
      const status: AgentWorkStatus = agent.status === 'ready' ? 'idle'
        : agent.status === 'starting' ? 'starting'
        : agent.status === 'crashed' ? 'broken'
        : 'offline';
      this.agentWorkStatus.set(agent.memberId, status);
    }
  }

  async start(): Promise<number> {
    // Kill any stale daemon from a previous session (prevents double dispatch)
    await this.killStaleDaemon();

    // Ensure .gateway/ is gitignored (older corps may lack this)
    this.ensureGatewayGitignored();

    // Sync corp-level skills to all agent workspaces
    try {
      const { syncSkillsToAllAgents } = await import('@claudecorp/shared');
      syncSkillsToAllAgents(this.corpRoot);
      log('[daemon] Skills synced to all agents');
    } catch {}

    // Start HTTP API + WebSocket event bus
    this.server = createApi(this);
    this.events.attach(this.server);

    return new Promise((resolve, reject) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (typeof addr === 'object' && addr) {
          this.port = addr.port;
        }

        // Write PID and port files
        writeFileSync(DAEMON_PID_PATH, String(process.pid), 'utf-8');
        writeFileSync(DAEMON_PORT_PATH, String(this.port), 'utf-8');

        log(`[daemon] API + WebSocket listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });

      this.server!.on('error', reject);
    });
  }

  /** Start the router, git manager, heartbeat, and task watcher */
  async startRouter(): Promise<void> {
    // Connect WebSocket BEFORE router starts — so first dispatch uses WS not HTTP
    await this.connectOpenClawWS();
    this.router.start();
    this.gitManager.start(this.clocks);
    this.heartbeat.start();
    this.taskWatcher.start();
    this.hireWatcher.start();
    this.pulse.start();
    this.contractWatcher.start();

    this.analytics.start();

    // NOTE: Failsafe heartbeat removed — Pulse now handles ALL agent heartbeats
    // directly (two-state: idle → check casket, busy → quick ping).

    // Register Herald narration as a Clock
    this.clocks.register({
      id: 'herald-narration',
      name: 'Herald Narration',
      type: 'heartbeat',
      intervalMs: 5 * 60 * 1000,
      target: 'Herald',
      description: 'Herald summarizes corp activity → writes NARRATION.md',
      callback: () => this.dispatchHeraldNarration(),
    });

    // Register Agent Recovery as a Clock — self-healing for crashed agents
    this.clocks.register({
      id: 'agent-recovery',
      name: 'Agent Recovery',
      type: 'system',
      intervalMs: 30 * 1000, // Every 30 seconds
      target: 'Daemon',
      description: 'Detects crashed agents and attempts respawn — self-healing at daemon level',
      callback: () => this.recoverCrashedAgents(),
    });

    // CEO Gateway Recovery — monitors the CEO's OpenClaw connection
    this.clocks.register({
      id: 'ceo-gateway-recovery',
      name: 'CEO Gateway',
      type: 'system',
      intervalMs: 30 * 1000,
      target: 'CEO',
      description: 'Monitors CEO gateway health, reconnects WebSocket, respawns on failure',
      callback: () => this.recoverCeoGateway(),
    });

    // Corp Gateway Recovery — picks up after autoRestart exhausts its 3 attempts
    this.clocks.register({
      id: 'corp-gateway-recovery',
      name: 'Corp Gateway',
      type: 'system',
      intervalMs: 60 * 1000,
      target: 'Workers',
      description: 'Recovers corp gateway after auto-restart exhaustion, reconnects WebSocket',
      callback: () => this.recoverCorpGateway(),
    });

    // Rehydrate user-created loops and crons from clocks.json
    this.loops.rehydrate();
    this.crons.rehydrate();
  }

  /** Dispatch narration request to Herald via say(). Response = NARRATION.md content. */
  private async dispatchHeraldNarration(): Promise<void> {
    try {
      const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
      const herald = members.find(m => m.displayName === 'Herald' && m.type === 'agent');
      if (!herald) return;
      if (this.getAgentWorkStatus(herald.id) === 'busy') return;

      const agentProc = this.processManager.getAgent(herald.id);
      if (!agentProc || agentProc.status !== 'ready') return;

      const resp = await fetch(`http://127.0.0.1:${this.port}/cc/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'herald',
          message: 'Narrate the current state of the corp. Run cc-cli activity and cc-cli status, then give a 1-2 sentence summary.',
          sessionKey: `herald-narration:${Date.now()}`,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      const data = await resp.json() as any;
      if (data.ok && data.response?.trim()) {
        // Write NARRATION.md at corp root
        const { writeFileSync } = await import('node:fs');
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const content = `# Herald — ${timeStr}\n\n${data.response.trim()}\n`;
        writeFileSync(join(this.corpRoot, 'NARRATION.md'), content, 'utf-8');
        log(`[daemon] Herald narration: ${data.response.trim().slice(0, 80)}`);
      }
    } catch (err) {
      logError(`[daemon] Herald narration failed: ${err}`);
    }
  }

  /**
   * Self-healing: detect crashed agents and attempt to respawn them.
   * Runs every 30 seconds. Tracks consecutive failures per agent to avoid
   * infinite retry loops — gives up after 5 consecutive failures and logs.
   */
  private recoveryAttempts = new Map<string, number>();
  private static MAX_RECOVERY_ATTEMPTS = 5;

  private async recoverCrashedAgents(): Promise<void> {
    const agents = this.processManager.listAgents();
    const crashed = agents.filter(a => a.status === 'crashed');

    if (crashed.length === 0) {
      // Reset all recovery counters when everything is healthy
      this.recoveryAttempts.clear();
      return;
    }

    for (const agent of crashed) {
      const attempts = this.recoveryAttempts.get(agent.memberId) ?? 0;

      if (attempts >= Daemon.MAX_RECOVERY_ATTEMPTS) {
        // Already gave up on this one — log once at threshold, then stay quiet
        if (attempts === Daemon.MAX_RECOVERY_ATTEMPTS) {
          logError(`[recovery] ${agent.displayName} — gave up after ${attempts} attempts. Manual restart needed.`);
          this.recoveryAttempts.set(agent.memberId, attempts + 1); // Prevent re-logging
          this.analytics.trackError(agent.memberId);
        }
        continue;
      }

      this.recoveryAttempts.set(agent.memberId, attempts + 1);
      log(`[recovery] ${agent.displayName} crashed — attempting respawn (attempt ${attempts + 1}/${Daemon.MAX_RECOVERY_ATTEMPTS})`);

      try {
        // Stop the old crashed process cleanly
        await this.processManager.stopAgent(agent.memberId);

        // Wait a beat for port release
        await new Promise(r => setTimeout(r, 1000));

        // Respawn
        const respawned = await this.processManager.spawnAgent(agent.memberId);

        if (respawned.status === 'ready' || respawned.status === 'starting') {
          log(`[recovery] ${agent.displayName} respawned successfully (status: ${respawned.status})`);
          this.recoveryAttempts.delete(agent.memberId);

          // Reconnect WebSocket if this was the CEO (remote mode)
          if (respawned.mode === 'remote' || respawned.mode === 'local') {
            // Re-establish WebSocket for tool events
            try {
              this.openclawWS = new OpenClawWS(respawned.port, respawned.gatewayToken);
              await this.openclawWS.connect();
            } catch {
              // Non-fatal — HTTP fallback still works
            }
          }

          // Update work status
          this.agentWorkStatus.set(agent.memberId, 'idle');

          // Flush any queued tasks for this agent
          const queued = this.inbox.peekNext(agent.memberId);
          if (queued) {
            log(`[recovery] ${agent.displayName} has queued work — inbox will dispatch on next idle`);
          }

          this.analytics.trackStatusChange(agent.memberId, agent.displayName, 'idle');
        } else {
          logError(`[recovery] ${agent.displayName} respawn returned status: ${respawned.status}`);
        }
      } catch (err) {
        logError(`[recovery] ${agent.displayName} respawn failed: ${err}`);
      }
    }
  }

  /**
   * CEO Gateway Recovery — verify the CEO's OpenClaw is reachable.
   * If unreachable: mark crashed (agent-recovery handles respawn).
   * If reachable but WebSocket disconnected: reconnect.
   */
  private ceoRecoveryFailures = 0;

  private async recoverCeoGateway(): Promise<void> {
    try {
      const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
      const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
      if (!ceo) return;

      const agentProc = this.processManager.getAgent(ceo.id);
      if (!agentProc) return;

      // Skip if already crashed — agent-recovery handles that
      if (agentProc.status === 'crashed' || agentProc.status === 'stopped') return;

      // Health ping the CEO's gateway
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

        // Gateway is reachable — reset failure counter
        this.ceoRecoveryFailures = 0;

        // Check WebSocket — reconnect if disconnected
        const wsClient = agentProc.mode === 'remote' ? this.openclawWS : null;
        if (agentProc.mode === 'remote' && (!wsClient || !wsClient.isConnected())) {
          log('[ceo-recovery] WebSocket disconnected — reconnecting...');
          try {
            this.openclawWS = new OpenClawWS(agentProc.port, agentProc.gatewayToken);
            await this.openclawWS.connect();
            log('[ceo-recovery] WebSocket reconnected');
          } catch {
            logError('[ceo-recovery] WebSocket reconnect failed (HTTP fallback active)');
          }
        }

        // Local mode CEO — check WebSocket too
        if (agentProc.mode === 'local' && (!this.openclawWS || !this.openclawWS.isConnected())) {
          try {
            this.openclawWS = new OpenClawWS(agentProc.port, agentProc.gatewayToken);
            await this.openclawWS.connect();
            log('[ceo-recovery] Local CEO WebSocket reconnected');
          } catch {
            // Non-fatal
          }
        }
      } catch {
        // Gateway unreachable
        this.ceoRecoveryFailures++;

        if (this.ceoRecoveryFailures >= 3) {
          // Confirmed dead — try to auto-start OpenClaw if remote mode
          if (agentProc.mode === 'remote') {
            log('[ceo-recovery] CEO remote gateway dead — attempting to start OpenClaw...');
            try {
              const { execa: run } = await import('execa');
              // Check if openclaw is already running on the expected port
              const gw = this.globalConfig.userGateway;
              if (gw) {
                const proc = run('openclaw', ['gateway', 'run'], {
                  stdio: 'pipe',
                  reject: false,
                  detached: true,
                });
                // Don't await — let it run in background. Give it 5s to start.
                proc.unref?.();
                await new Promise(r => setTimeout(r, 5000));

                // Check if it came up
                try {
                  const check = await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gw.token}` },
                    body: JSON.stringify({ model: 'openclaw:main', messages: [] }),
                    signal: AbortSignal.timeout(3000),
                  });
                  if (check.status < 500) {
                    log('[ceo-recovery] OpenClaw started successfully — CEO will recover on next agent-recovery tick');
                    this.ceoRecoveryFailures = 0;
                  }
                } catch {
                  logError('[ceo-recovery] OpenClaw start attempted but gateway still unreachable');
                }
              }
            } catch (err) {
              logError(`[ceo-recovery] Failed to start OpenClaw: ${err}`);
            }
          }

          // Mark crashed so agent-recovery handles respawn
          logError(`[ceo-recovery] CEO gateway unreachable (${this.ceoRecoveryFailures} consecutive failures) — marking crashed`);
          agentProc.status = 'crashed';
          this.ceoRecoveryFailures = 0; // Reset so agent-recovery gets a fresh start
        } else {
          log(`[ceo-recovery] CEO gateway ping failed (${this.ceoRecoveryFailures}/3)`);
        }
      }
    } catch (err) {
      logError(`[ceo-recovery] Unexpected error: ${err}`);
    }
  }

  /**
   * Corp Gateway Recovery — picks up after the built-in autoRestart exhausts.
   * Also reconnects the daemon's WebSocket to the corp gateway and updates
   * worker agent statuses after gateway recovery.
   */
  private corpGatewayRecoveryAttempts = 0;

  private async recoverCorpGateway(): Promise<void> {
    try {
      const corpGw = this.processManager.corpGateway;
      if (!corpGw) return; // No corp gateway configured

      const gwStatus = corpGw.getStatus();

      // Gateway is healthy — check WebSocket connection
      if (gwStatus === 'ready') {
        this.corpGatewayRecoveryAttempts = 0;

        // Reconnect WebSocket if disconnected
        if (!this.corpGatewayWS || !this.corpGatewayWS.isConnected()) {
          try {
            this.corpGatewayWS = new OpenClawWS(corpGw.getPort(), corpGw.getToken());
            await this.corpGatewayWS.connect();
            log('[corp-gw-recovery] WebSocket reconnected to corp gateway');
          } catch {
            // Non-fatal — HTTP fallback works
          }
        }

        // Verify worker agents reflect gateway status
        const agents = this.processManager.listAgents();
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

      // Gateway is stopped but has agents — this means autoRestart exhausted
      if (gwStatus === 'stopped' && corpGw.hasAgents()) {
        this.corpGatewayRecoveryAttempts++;

        if (this.corpGatewayRecoveryAttempts > 10) {
          // Give up after 10 attempts (10 minutes at 60s interval)
          if (this.corpGatewayRecoveryAttempts === 11) {
            logError('[corp-gw-recovery] Exhausted 10 recovery attempts — corp gateway is down. Restart TUI to recover.');
          }
          return;
        }

        log(`[corp-gw-recovery] Corp gateway stopped — attempting recovery (attempt ${this.corpGatewayRecoveryAttempts}/10)`);

        try {
          // Refresh auth in case API keys changed
          corpGw.refreshAllAuth();

          // Attempt restart
          await corpGw.start();
          log(`[corp-gw-recovery] Corp gateway recovered on port ${corpGw.getPort()}`);

          // Reconnect WebSocket
          try {
            this.corpGatewayWS = new OpenClawWS(corpGw.getPort(), corpGw.getToken());
            await this.corpGatewayWS.connect();
            log('[corp-gw-recovery] WebSocket connected to recovered corp gateway');
          } catch {
            logError('[corp-gw-recovery] WebSocket connect failed after recovery');
          }

          // Mark all gateway workers as ready
          const agents = this.processManager.listAgents();
          for (const agent of agents) {
            if (agent.mode === 'gateway') {
              agent.status = 'ready';
              agent.port = corpGw.getPort();
              agent.gatewayToken = corpGw.getToken();
              this.agentWorkStatus.set(agent.memberId, 'idle');
              log(`[corp-gw-recovery] ${agent.displayName} → ready`);
            }
          }

          this.corpGatewayRecoveryAttempts = 0;
        } catch (err) {
          logError(`[corp-gw-recovery] Recovery failed: ${err}`);
        }
      }
    } catch (err) {
      logError(`[corp-gw-recovery] Unexpected error: ${err}`);
    }
  }

  /**
   * Dispatch monitoring protocol to Failsafe via say() — the proven Jack path.
   * Calls the daemon's own /cc/say endpoint internally.
   * This is more reliable than direct dispatchToAgent() because say() handles
   * session management, status tracking, and inbox logging automatically.
   */
  private async dispatchFailsafeHeartbeat(): Promise<void> {
    try {
      // Quick checks before making the HTTP call
      const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
      const failsafe = members.find(m => m.displayName === 'Failsafe' && m.type === 'agent');
      if (!failsafe) return;
      if (this.getAgentWorkStatus(failsafe.id) === 'busy') return;

      const agentProc = this.processManager.getAgent(failsafe.id);
      if (!agentProc || agentProc.status !== 'ready') return;

      // Call our own /cc/say endpoint — same path that Jack uses, proven reliable
      const resp = await fetch(`http://127.0.0.1:${this.port}/cc/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'failsafe',
          message: 'Run your monitoring protocol. Check all agent statuses via cc-cli status and report.',
          sessionKey: `failsafe-heartbeat:${Date.now()}`,
        }),
        signal: AbortSignal.timeout(90_000), // 90s timeout
      });

      const data = await resp.json() as any;
      if (data.ok) {
        log(`[daemon] Failsafe heartbeat response: ${data.response?.slice(0, 80) ?? 'ok'}`);

        // Write response to Failsafe's DM for TUI visibility
        const channels = readConfig<Channel[]>(join(this.corpRoot, CHANNELS_JSON));
        const founder = members.find(m => m.rank === 'owner');
        const dmChannel = channels.find(
          c => c.kind === 'direct' &&
          c.memberIds.includes(failsafe.id) &&
          (founder ? c.memberIds.includes(founder.id) : true),
        );
        if (dmChannel && data.response?.trim()) {
          const responseMsg: ChannelMessage = {
            id: generateId(),
            channelId: dmChannel.id,
            senderId: failsafe.id,
            threadId: null,
            content: data.response,
            kind: 'text',
            mentions: [],
            metadata: { source: 'failsafe-heartbeat' },
            depth: 0,
            originId: '',
            timestamp: new Date().toISOString(),
          };
          responseMsg.originId = responseMsg.id;
          appendMessage(join(this.corpRoot, dmChannel.path, MESSAGES_JSONL), responseMsg);
        }
      } else {
        logError(`[daemon] Failsafe say() failed: ${data.error ?? 'unknown'}`);
      }
    } catch (err) {
      logError(`[daemon] Failsafe heartbeat failed: ${err}`);
    }
  }

  /** Connect WebSocket to OpenClaw gateways for tool events. Best-effort, non-blocking. */
  private async connectOpenClawWS(): Promise<void> {
    // User's personal OpenClaw (CEO)
    const userGw = this.globalConfig.userGateway;
    if (userGw) {
      try {
        this.openclawWS = new OpenClawWS(userGw.port, userGw.token);
        await this.openclawWS.connect();
        log('[daemon] WebSocket connected to user OpenClaw (tool events enabled)');
      } catch (err) {
        logError(`[daemon] WebSocket to user OpenClaw failed (falling back to HTTP): ${err}`);
        this.openclawWS = null;
      }
    }

    // Corp gateway (worker agents)
    const corpGw = this.processManager.corpGateway;
    if (corpGw && corpGw.getStatus() === 'ready') {
      try {
        this.corpGatewayWS = new OpenClawWS(corpGw.getPort(), corpGw.getToken());
        await this.corpGatewayWS.connect();
        log('[daemon] WebSocket connected to corp gateway (tool events enabled)');
      } catch (err) {
        logError(`[daemon] WebSocket to corp gateway failed (falling back to HTTP): ${err}`);
        this.corpGatewayWS = null;
      }
    }
  }

  async spawnAllAgents(): Promise<void> {
    // Initialize the shared corp gateway — if it fails, CEO may still work via remote
    try {
      await this.processManager.initCorpGateway();
      // Wire ClockManager to corp gateway for health monitor observability
      if (this.processManager.corpGateway) {
        this.processManager.corpGateway.clocks = this.clocks;
      }
    } catch (err) {
      logError(`[daemon] Corp gateway init failed (agents may start later): ${err}`);
    }

    let members: Member[];
    try {
      members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
    } catch (err) {
      logError(`[daemon] Failed to read members.json: ${err}`);
      return;
    }

    const agents = members.filter((m) => m.type === 'agent' && m.status !== 'archived');

    for (const agent of agents) {
      try {
        await this.processManager.spawnAgent(agent.id);
      } catch (err) {
        logError(`[daemon] Failed to spawn ${agent.displayName}: ${err}`);
      }
    }

    // Initialize work status for all agents
    this.initAgentWorkStatuses();

    // Bootstrap system agents (Failsafe) if missing
    await this.bootstrapSystemAgents();
  }

  /** Ensure system agents (Failsafe, Janitor) exist — auto-hire if missing. */
  private async bootstrapSystemAgents(): Promise<void> {
    try {
      await hireFailsafe(this);
      this.pulse.refreshFailsafe();
    } catch (err) {
      logError(`[daemon] Failed to bootstrap Failsafe agent: ${err}`);
    }
    try {
      await hireJanitor(this);
    } catch (err) {
      logError(`[daemon] Failed to bootstrap Janitor agent: ${err}`);
    }
    try {
      await hireWarden(this);
    } catch (err) {
      logError(`[daemon] Failed to bootstrap Warden agent: ${err}`);
    }
    try {
      await hireHerald(this);
    } catch (err) {
      logError(`[daemon] Failed to bootstrap Herald agent: ${err}`);
    }
  }

  /**
   * Write a user message to a channel. Returns immediately.
   * The router will pick it up via fs.watch and dispatch to agents.
   * Returns the message + whether an agent dispatch is expected.
   */
  async sendMessage(
    channelId: string,
    content: string,
    senderId?: string,
  ): Promise<{ message: ChannelMessage; dispatching: boolean; dispatchTargets: string[] }> {
    const channels = readConfig<Channel[]>(join(this.corpRoot, CHANNELS_JSON));
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
    const founder = members.find((m) => m.rank === 'owner');
    if (!founder) throw new Error('No founder found');

    // Use provided senderId, or detect the currently-dispatching agent, or default to Founder
    let actualSender: Member;
    if (senderId) {
      actualSender = members.find((m) => m.id === senderId) ?? founder;
    } else {
      // If an agent is currently busy (dispatching), it's likely the one sending this message via exec
      const busyAgents = members.filter(m => m.type === 'agent' && this.agentWorkStatus.get(m.id) === 'busy');
      actualSender = busyAgents.length === 1 ? busyAgents[0]! : founder;
    }
    const isAgent = actualSender.type === 'agent';

    const messagesPath = join(this.corpRoot, channel.path, 'messages.jsonl');

    // Write message
    const userMsg: ChannelMessage = {
      id: generateId(),
      channelId,
      senderId: actualSender.id,
      threadId: null,
      content,
      kind: 'text',
      mentions: [],
      metadata: { source: isAgent ? 'router' : 'user' },
      depth: 0,
      originId: '',
      timestamp: new Date().toISOString(),
    };
    userMsg.originId = userMsg.id;
    appendMessage(messagesPath, userMsg);
    this.analytics.trackMessage();

    // Poke the router to process this channel (Windows fs.watch can miss appends)
    setTimeout(() => this.router.pokeChannel(channelId), 100);

    // Mark for git commit
    this.gitManager.markDirty(founder.displayName);

    // Predict which agents the router will dispatch to
    const dispatchTargets: string[] = [];
    if (channel.kind === 'direct') {
      const otherId = channel.memberIds.find((id) => id !== founder.id);
      if (otherId) {
        const other = members.find((m) => m.id === otherId);
        const proc = this.processManager.getAgent(otherId);
        if (other && proc && proc.status === 'ready') {
          dispatchTargets.push(other.displayName);
        }
      }
    } else {
      const mentionedIds = resolveMentions(content, members);
      for (const id of mentionedIds) {
        const m = members.find((mem) => mem.id === id);
        if (!m || m.type !== 'agent') continue;
        const proc = this.processManager.getAgent(id);
        if (proc && proc.status === 'ready') {
          dispatchTargets.push(m.displayName);
        }
      }
    }

    return { message: userMsg, dispatching: dispatchTargets.length > 0, dispatchTargets };
  }

  async stop(): Promise<void> {
    this.heartbeat.stop();
    this.taskWatcher.stop();
    this.hireWatcher.stop();
    this.pulse.stop();
    this.contractWatcher.stop();
    this.crons.stopAll(); // Stop croner jobs before ClockManager
    this.loops.shutdown(); // Flush loop stats
    this.clocks.stopAll();
    this.inbox.flush(); // Persist inbox state before shutdown
    this.analytics.stop(); // Persist analytics before shutdown
    this.router.stop();
    await this.gitManager.stop();
    await this.processManager.stopAll();
    this.openclawWS?.close();
    this.corpGatewayWS?.close();
    this.events.close();
    if (this.server) {
      this.server.close();
    }
    // Clean up PID/port files
    try { unlinkSync(DAEMON_PID_PATH); } catch {}
    try { unlinkSync(DAEMON_PORT_PATH); } catch {}
  }

  getPort(): number {
    return this.port;
  }

  /**
   * Kill ALL Claude Corp processes from a previous session.
   *
   * Orphans can survive in 3 places:
   * 1. The daemon itself (tracked by .daemon.pid)
   * 2. The corp gateway (openclaw process on .gateway/ port)
   * 3. Local agent gateways (openclaw per agent, each on their own port)
   *
   * We scan the corp structure, find every port that was in use,
   * and kill the process holding each one. Then clean up state files.
   */
  private async killStaleDaemon(): Promise<void> {
    const portsToKill = new Set<number>();
    const pidsToKill = new Set<number>();

    // 1. Old daemon PID
    try {
      if (existsSync(DAEMON_PID_PATH)) {
        const oldPid = parseInt(readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
        if (oldPid && oldPid !== process.pid) {
          pidsToKill.add(oldPid);
        }
      }
    } catch {}

    // 2. Old daemon port
    try {
      if (existsSync(DAEMON_PORT_PATH)) {
        const oldPort = parseInt(readFileSync(DAEMON_PORT_PATH, 'utf-8').trim(), 10);
        if (oldPort) portsToKill.add(oldPort);
      }
    } catch {}

    // 3. Corp gateway port — read from .gateway/openclaw.json
    try {
      const gwConfigPath = join(this.corpRoot, '.gateway', 'openclaw.json');
      if (existsSync(gwConfigPath)) {
        const gwConfig = JSON.parse(readFileSync(gwConfigPath, 'utf-8'));
        const gwPort = gwConfig?.gateway?.port;
        if (gwPort && typeof gwPort === 'number') portsToKill.add(gwPort);
      }
    } catch {}

    // 4. Local agent gateway ports — scan agents/*/config.json for port,
    //    and agents/*/.openclaw/openclaw.json for gateway.port
    try {
      const agentsDir = join(this.corpRoot, 'agents');
      if (existsSync(agentsDir)) {
        const agents = readdirSync(agentsDir, { withFileTypes: true });
        for (const agent of agents) {
          if (!agent.isDirectory()) continue;

          // Check agent config.json for port
          try {
            const configPath = join(agentsDir, agent.name, 'config.json');
            if (existsSync(configPath)) {
              const config = JSON.parse(readFileSync(configPath, 'utf-8'));
              if (config.port && typeof config.port === 'number') {
                portsToKill.add(config.port);
              }
            }
          } catch {}

          // Check agent's .openclaw/openclaw.json for gateway port
          try {
            const ocConfigPath = join(agentsDir, agent.name, '.openclaw', 'openclaw.json');
            if (existsSync(ocConfigPath)) {
              const ocConfig = JSON.parse(readFileSync(ocConfigPath, 'utf-8'));
              const agentPort = ocConfig?.gateway?.port;
              if (agentPort && typeof agentPort === 'number') {
                portsToKill.add(agentPort);
              }
            }
          } catch {}
        }
      }
    } catch {}

    // 5. Project-scoped agent ports — scan projects/*/agents/*
    try {
      const projectsDir = join(this.corpRoot, 'projects');
      if (existsSync(projectsDir)) {
        const projects = readdirSync(projectsDir, { withFileTypes: true });
        for (const proj of projects) {
          if (!proj.isDirectory()) continue;
          const projAgentsDir = join(projectsDir, proj.name, 'agents');
          if (!existsSync(projAgentsDir)) continue;
          const projAgents = readdirSync(projAgentsDir, { withFileTypes: true });
          for (const agent of projAgents) {
            if (!agent.isDirectory()) continue;
            try {
              const configPath = join(projAgentsDir, agent.name, 'config.json');
              if (existsSync(configPath)) {
                const config = JSON.parse(readFileSync(configPath, 'utf-8'));
                if (config.port && typeof config.port === 'number') portsToKill.add(config.port);
              }
            } catch {}
            try {
              const ocConfigPath = join(projAgentsDir, agent.name, '.openclaw', 'openclaw.json');
              if (existsSync(ocConfigPath)) {
                const ocConfig = JSON.parse(readFileSync(ocConfigPath, 'utf-8'));
                const p = ocConfig?.gateway?.port;
                if (p && typeof p === 'number') portsToKill.add(p);
              }
            } catch {}
          }
        }
      }
    } catch {}

    if (pidsToKill.size === 0 && portsToKill.size === 0) return;

    log(`[daemon] Cleaning up stale processes — ${pidsToKill.size} PIDs, ${portsToKill.size} ports`);
    const { execa: run } = await import('execa');

    // Kill PIDs first (with process tree on Windows)
    for (const pid of pidsToKill) {
      try {
        if (process.platform === 'win32') {
          await run('taskkill', ['/F', '/T', '/PID', String(pid)], { reject: false, timeout: 5000 });
        } else {
          try { process.kill(pid, 'SIGTERM'); } catch {}
        }
        log(`[daemon] Killed stale PID ${pid}`);
      } catch {}
    }

    // Kill anything holding our ports
    if (process.platform === 'win32') {
      for (const port of portsToKill) {
        try {
          const check = await run('cmd', ['/c', `netstat -ano | findstr :${port} | findstr LISTENING`], { reject: false, timeout: 5000 });
          if (check.stdout) {
            // Extract all unique PIDs from netstat output
            const lines = check.stdout.trim().split('\n');
            for (const line of lines) {
              const match = line.trim().match(/\s(\d+)\s*$/);
              if (match?.[1]) {
                const holderPid = parseInt(match[1]);
                if (holderPid !== process.pid && !pidsToKill.has(holderPid)) {
                  await run('taskkill', ['/F', '/T', '/PID', String(holderPid)], { reject: false, timeout: 5000 });
                  log(`[daemon] Killed stale process on port ${port} (PID ${holderPid})`);
                }
              }
            }
          }
        } catch {}
      }
    } else {
      // Unix: kill processes on ports via lsof
      for (const port of portsToKill) {
        try {
          const check = await run('lsof', ['-ti', `:${port}`], { reject: false, timeout: 5000 });
          if (check.stdout) {
            for (const pidStr of check.stdout.trim().split('\n')) {
              const pid = parseInt(pidStr);
              if (pid && pid !== process.pid) {
                try { process.kill(pid, 'SIGTERM'); } catch {}
                log(`[daemon] Killed stale process on port ${port} (PID ${pid})`);
              }
            }
          }
        } catch {}
      }
    }

    // Wait for processes to die
    await new Promise(r => setTimeout(r, 2000));

    // Clean up stale files
    try { unlinkSync(DAEMON_PID_PATH); } catch {}
    try { unlinkSync(DAEMON_PORT_PATH); } catch {}

    log(`[daemon] Stale process cleanup complete`);
  }

  /** Get formatted uptime string like "12m 34s" or "1h 5m 12s" */
  getUptime(): string {
    const ms = Date.now() - this.startedAt;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  /** Count total messages across all channel JSONL files */
  countAllMessages(): number {
    let total = 0;
    try {
      const channelsDir = join(this.corpRoot, 'channels');
      if (!existsSync(channelsDir)) return 0;
      const dirs = readdirSync(channelsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const msgPath = join(channelsDir, dir.name, MESSAGES_JSONL);
        try {
          const content = readFileSync(msgPath, 'utf-8');
          const lines = content.trim().split('\n').filter((l: string) => l.trim());
          total += lines.length;
        } catch {
          // File doesn't exist or empty
        }
      }
    } catch {
      // channels dir doesn't exist
    }
    return total;
  }

  /** Get uptime info for API endpoint */
  getUptimeInfo(): { uptime: string; totalMessages: number; startedAt: number } {
    return {
      uptime: this.getUptime(),
      totalMessages: this.countAllMessages(),
      startedAt: this.startedAt,
    };
  }

  /** Patch .gitignore to exclude .gateway/ if not already present. */
  private ensureGatewayGitignored(): void {
    try {
      const gitignorePath = join(this.corpRoot, '.gitignore');
      if (!existsSync(gitignorePath)) return;
      const content = readFileSync(gitignorePath, 'utf-8');
      if (!content.includes('.gateway/')) {
        writeFileSync(gitignorePath, content.trimEnd() + '\n\n# Corp gateway runtime state\n.gateway/\n', 'utf-8');
      }
    } catch {}
  }
}

export function isDaemonRunning(): { running: boolean; port: number | null } {
  try {
    // Port file is the source of truth. If it exists and has a valid port, trust it.
    // PID checks are unreliable on Windows (fail across process trees, MSYS2 vs cmd.exe).
    // The actual HTTP call from DaemonClient will verify connectivity.
    if (!existsSync(DAEMON_PORT_PATH)) {
      return { running: false, port: null };
    }
    const port = parseInt(readFileSync(DAEMON_PORT_PATH, 'utf-8').trim(), 10);
    if (!port || port <= 0) {
      return { running: false, port: null };
    }

    // Optional PID check (best-effort, non-blocking)
    if (existsSync(DAEMON_PID_PATH)) {
      const pid = parseInt(readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
      if (pid > 0) {
        try {
          process.kill(pid, 0); // Works if same process tree
        } catch {
          // PID check failed — but port file exists. Trust the port.
          // On Windows this always fails across process trees. That's fine.
        }
      }
    }

    return { running: true, port };
  } catch {
    return { running: false, port: null };
  }
}
