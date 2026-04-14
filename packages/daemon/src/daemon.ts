import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import {
  type Member,
  type Channel,
  type ChannelMessage,
  type Corporation,
  type GlobalConfig,
  type AgentWorkStatus,
  readConfig,
  post,
  resolveMentions,
  MEMBERS_JSON,
  CHANNELS_JSON,
  CORP_JSON,
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
import { hirePlanner } from './planner.js';
import { ContractWatcher } from './contract-watcher.js';
import { ClockManager } from './clock-manager.js';
import { LoopManager } from './loops.js';
import { CronManager } from './crons.js';
import { DreamManager } from './dreams.js';
import { AutoemonManager } from './autoemon.js';
import { AnalyticsEngine } from './analytics.js';
import { OpenClawWS } from './openclaw-ws.js';
import {
  type AgentHarness,
  HarnessRouter,
  OpenClawHarness,
  defaultHarnessRegistry,
} from './harness/index.js';
import { createApi } from './api.js';
import { recoverCrashedAgents, recoverCeoGateway, recoverCorpGateway } from './daemon-recovery.js';
import { killStaleProcesses } from './stale-cleanup.js';
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
  dreams: DreamManager;
  autoemon: AutoemonManager;
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
  /**
   * Agent execution substrate. A HarnessRouter that delegates per-agent to
   * the right underlying AgentHarness. PR 2: only OpenClawHarness is
   * registered, so every agent still resolves to it. PR 3 adds
   * ClaudeCodeHarness alongside.
   */
  harness: AgentHarness;
  /** Track consecutive overloaded errors per agent for gateway restart logic */
  overloadCounts = new Map<string, number>();
  /** Founder presence tracking for autoemon — when was the last user interaction? */
  lastFounderInteractionAt = 0;
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
    this.dreams = new DreamManager(this);
    this.autoemon = new AutoemonManager(this);
    this.analytics = new AnalyticsEngine(this);
    this.inbox.setCorpRoot(corpRoot); // Enable inbox persistence

    // Harness abstraction — every dispatch flows through this.
    // PR 2: daemon.harness is a HarnessRouter that owns a Map of underlying
    // harnesses keyed by registered name, delegating per-agent via the
    // resolveHarnessForAgent lookup (Member.harness → Corporation.harness
    // → fallback 'openclaw'). In this PR the only registered harness is
    // OpenClawHarness, so every agent resolves to it and behavior is
    // identical to PR 1. PR 3 adds ClaudeCodeHarness to the map.
    const makeOpenClawHarness = () => new OpenClawHarness({
      processManager: this.processManager,
      getUserGatewayWS: () => this.openclawWS,
      getCorpGatewayWS: () => this.corpGatewayWS,
    });
    if (!defaultHarnessRegistry.has('openclaw')) {
      defaultHarnessRegistry.register('openclaw', makeOpenClawHarness);
    }
    const openclaw = makeOpenClawHarness();
    this.harness = new HarnessRouter({
      harnesses: new Map<string, AgentHarness>([['openclaw', openclaw]]),
      resolveHarness: (agentId) => this.resolveHarnessForAgent(agentId),
      fallbackHarness: 'openclaw',
    });
  }

  /**
   * Look up which harness name should handle a given agent's turns.
   * Resolution order: Member.harness → Corporation.harness → undefined.
   * The HarnessRouter applies its fallback when we return undefined.
   *
   * Called on every dispatch — intentionally does small sync fs reads
   * (members.json + corp.json) so the source of truth stays the on-disk
   * config. Caching can come later if profiling warrants it.
   */
  private resolveHarnessForAgent(agentId: string): string | undefined {
    try {
      const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
      const member = members.find((m) => m.id === agentId);
      if (member?.harness) return member.harness;
      const corp = readConfig<Corporation>(join(this.corpRoot, CORP_JSON));
      if (corp.harness) return corp.harness;
    } catch {
      // Malformed configs — fall through to router fallback.
    }
    return undefined;
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
    await killStaleProcesses(this.corpRoot);

    // Ensure .gateway/ is gitignored (older corps may lack this)
    this.ensureGatewayGitignored();

    // Sync corp-level skills to all agent workspaces
    try {
      const { syncSkillsToAllAgents } = await import('@claudecorp/shared');
      syncSkillsToAllAgents(this.corpRoot);
      log('[daemon] Skills synced to all agents');
    } catch {}

    // Initialize the harness before the API server starts so dispatch
    // call sites can assume it's ready. init() is cheap for OpenClawHarness
    // (just records a start timestamp for telemetry); real connectivity
    // happens later via connectOpenClawWS().
    await this.harness.init({ corpRoot: this.corpRoot, globalConfig: this.globalConfig });

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

    // Dispatch CEO onboarding kickoff via say() (Jack session) if unresponded.
    // The kickoff was written before the daemon started, so the router never saw it.
    // Using say() gives: streaming + persistent Jack session (CEO remembers this).
    setTimeout(async () => {
      try {
        const channels = readConfig<Channel[]>(join(this.corpRoot, CHANNELS_JSON));
        const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
        const ceoDm = channels.find(c => c.kind === 'direct' && c.name.includes('ceo'));
        const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
        if (!ceoDm || !ceo) return;

        // Check if CEO has already responded (don't re-dispatch on restart)
        const msgPath = join(this.corpRoot, ceoDm.path, MESSAGES_JSONL);
        const { tailMessages } = await import('@claudecorp/shared');
        const recent = tailMessages(msgPath, 20);
        const hasKickoff = recent.some(m => m.senderId === 'system' && m.content.includes('Introduce yourself'));
        const hasCeoResponse = recent.some(m => m.senderId === ceo.id && m.kind === 'text');
        if (!hasKickoff || hasCeoResponse) return;

        // Dispatch kickoff via say() — Jack session for memory persistence
        const ceoSlug = ceo.displayName.toLowerCase().replace(/\s+/g, '-');
        const kickoffContent = recent.find(m => m.senderId === 'system' && m.content.includes('Introduce yourself'))!.content;
        log(`[daemon] Dispatching onboarding kickoff to CEO via Jack session`);

        await fetch(`http://127.0.0.1:${this.port}/cc/say`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: ceoSlug,
            message: kickoffContent,
            sessionKey: `jack:${ceoSlug}`,
            channelId: ceoDm.id,
          }),
        });
      } catch (err) {
        logError(`[daemon] Kickoff dispatch failed: ${err}`);
      }
    }, 5000);

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
      callback: () => recoverCrashedAgents(this),
    });

    // CEO Gateway Recovery — monitors the CEO's OpenClaw connection
    this.clocks.register({
      id: 'ceo-gateway-recovery',
      name: 'CEO Gateway',
      type: 'system',
      intervalMs: 30 * 1000,
      target: 'CEO',
      description: 'Monitors CEO gateway health, reconnects WebSocket, respawns on failure',
      callback: () => recoverCeoGateway(this),
    });

    // Corp Gateway Recovery — picks up after autoRestart exhausts its 3 attempts
    this.clocks.register({
      id: 'corp-gateway-recovery',
      name: 'Corp Gateway',
      type: 'system',
      intervalMs: 60 * 1000,
      target: 'Workers',
      description: 'Recovers corp gateway after auto-restart exhaustion, reconnects WebSocket',
      callback: () => recoverCorpGateway(this),
    });

    // Rehydrate user-created loops and crons from clocks.json
    this.loops.rehydrate();
    this.crons.rehydrate();

    // Start Agent Dreams — background memory consolidation
    this.dreams.start();

    // Start autoemon tick loop if it was active before daemon restart
    if (this.autoemon.isOn()) {
      this.autoemon.startTickLoop();
      this.autoemon.rehydrateDurationTimer(); // Restart duration timer if SLUMBER has endsAt
      log(`[daemon] Autoemon rehydrated — tick loop resumed (${this.autoemon.getEnrolledAgents().length} agents enrolled)`);
    }

    // Start Founder Away checker (if dangerouslyEnableAutoAfk is on in corp.json)
    this.autoemon.startFounderAwayChecker();
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

  // Recovery methods extracted to daemon-recovery.ts
  // Stale process cleanup extracted to stale-cleanup.ts

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
          post(dmChannel.id, join(this.corpRoot, dmChannel.path, MESSAGES_JSONL), {
            senderId: failsafe.id,
            content: data.response,
            source: 'system',
            metadata: { heartbeat: 'failsafe' },
          });
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
    try {
      await hirePlanner(this);
    } catch (err) {
      logError(`[daemon] Failed to bootstrap Planner agent: ${err}`);
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

    // Use provided senderId, or default to Founder.
    // NEVER guess from busy agents — that heuristic causes misattribution
    // when 0 or 2+ agents are busy (defaults to Founder, making CEO's
    // words appear as Mark's). All callers must pass explicit senderId.
    let actualSender: Member;
    if (senderId) {
      actualSender = members.find((m) => m.id === senderId) ?? founder;
    } else {
      actualSender = founder;
    }
    const isAgent = actualSender.type === 'agent';

    const messagesPath = join(this.corpRoot, channel.path, 'messages.jsonl');

    // Write message
    const userMsg = post(channelId, messagesPath, {
      senderId: actualSender.id,
      content,
      source: isAgent ? 'router' : 'user',
    });
    if (!userMsg) {
      // Deduped — same message sent within 5s. Return empty dispatch.
      return { message: {} as any, dispatching: false, dispatchTargets: [] };
    }
    this.analytics.trackMessage();

    // Track founder interaction for autoemon presence
    if (!isAgent) {
      this.lastFounderInteractionAt = Date.now();
    }

    // Poke the router to process this channel (Windows fs.watch can miss appends)
    setTimeout(() => this.router.pokeChannel(channelId), 100);

    // Wake sleeping autoemon agents if the founder sends them a message
    if (!isAgent && channel.kind === 'direct') {
      const otherId = channel.memberIds.find((id) => id !== actualSender.id);
      if (otherId && this.autoemon.isSleeping(otherId)) {
        this.autoemon.wakeAgent(otherId, 'user_message', `Founder sent: "${content.slice(0, 60)}"`);
      }
    }

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
    this.autoemon.stop(); // Persist autoemon state before shutdown
    this.crons.stopAll(); // Stop croner jobs before ClockManager
    this.loops.shutdown(); // Flush loop stats
    this.clocks.stopAll();
    this.inbox.flush(); // Persist inbox state before shutdown
    this.analytics.stop(); // Persist analytics before shutdown
    this.router.stop();
    await this.gitManager.stop();
    await this.processManager.stopAll();
    await this.harness.shutdown();
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
