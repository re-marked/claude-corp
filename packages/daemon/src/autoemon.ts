/**
 * AutoemonManager — the autonomous tick engine.
 *
 * Internally called "Autoemon" (auto + daemon). User-facing name is "SLUMBER."
 * This is the machinery that makes agents work autonomously — receiving periodic
 * <tick> prompts and deciding what to do on their own.
 *
 * Architecture (Decision C from PR1-PLAN.md):
 * - Autoemon is SEPARATE from Pulse
 * - Pulse monitors ("are you alive?") — Autoemon drives work ("here's a tick")
 * - When an agent enrolls, Pulse skips it, Autoemon handles it
 * - Clean ownership: each agent has exactly one heartbeat source
 *
 * Borrowed from Claude Code's proactive module:
 * - One continuous session per agent (autoemon:<slug>), compaction handles growth
 * - Agent-driven observation logging (prompt teaches, daemon doesn't auto-record)
 * - Explicit activation only (no auto-suggest)
 * - Tick telemetry persisted locally to autoemon-telemetry.jsonl
 *
 * State machine:
 *   INACTIVE → ACTIVE → PAUSED (user) / BLOCKED (error)
 *   Per-agent: active / sleeping / blocked
 *
 * Built incrementally — this file starts as the state machine skeleton.
 * Tick loop, sleep, conscription, blocking budget added in subsequent commits.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readConfig,
  listTasks,
  listAllContracts,
  type Member,
  type Contract,
  MEMBERS_JSON,
  parseIntervalExpression,
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';
import {
  buildTickMessage,
  buildFirstTickMessage,
  buildSleepWakeTick,
  buildBatchedTickMessage,
  type FounderPresence,
  type TickContext,
} from './autoemon-prompt.js';

// ── Constants ──────────────────────────────────────────────────────

const STATE_FILE = 'autoemon-state.json';
const TELEMETRY_FILE = 'autoemon-telemetry.jsonl';

/** How often the tick loop checks for due agents: 10 seconds */
const TICK_CHECK_INTERVAL_MS = 10 * 1000;

/** Dispatch timeout for tick dispatch: 90 seconds (ticks should be fast) */
const TICK_DISPATCH_TIMEOUT_MS = 90 * 1000;

/** Interval for productive agents: stay close */
const PRODUCTIVE_INTERVAL_MS = 30 * 1000;

/** Interval for administrative/idle agents */
const IDLE_INTERVAL_MS = 2 * 60 * 1000;

/** Interval after 3+ consecutive idle ticks: auto-slow */
const AUTO_SLOW_INTERVAL_MS = 5 * 60 * 1000;

/** Consecutive idle ticks before auto-slowing */
const AUTO_SLOW_THRESHOLD = 3;

/** Max response length to consider "idle" (short HEARTBEAT_OK-style) */
const IDLE_RESPONSE_MAX_CHARS = 80;

/** Regex to detect SLEEP command in agent response */
const SLEEP_PATTERN = /SLEEP\s+(\d+[smhd](?:\d+[smh])?)\s*(?:—\s*(.+))?/i;

/** Default tick interval: 2 minutes */
export const DEFAULT_TICK_INTERVAL_MS = 2 * 60 * 1000;

/** Minimum tick interval: 30 seconds (prevent API burn) */
export const MIN_TICK_INTERVAL_MS = 30 * 1000;

/** Maximum tick interval: 30 minutes (prevent coma) */
export const MAX_TICK_INTERVAL_MS = 30 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────

export type AutoemonGlobalState = 'inactive' | 'active' | 'paused' | 'blocked';
export type AutoemonAgentState = 'active' | 'sleeping' | 'blocked';
export type ActivationSource = 'slumber' | 'manual' | 'afk';
export type WakeReason = 'timer' | 'user_message' | 'urgent_task' | 'manual_wake';

/** Persisted state for a single enrolled agent. */
export interface AgentTickState {
  /** Current agent-level state */
  state: AutoemonAgentState;
  /** When this agent was enrolled */
  enrolledAt: number;
  /** Tick interval for this agent (ms) — adapts based on workload */
  tickIntervalMs: number;
  /** When the next tick should fire */
  nextTickAt: number;
  /** Sleep expiry timestamp (null if not sleeping) */
  sleepUntil: number | null;
  /** Sleep reason for telemetry */
  sleepReason: string | null;
  /** Total ticks fired for this agent */
  tickCount: number;
  /** Productive ticks (agent did something, not just slept) */
  productiveTickCount: number;
  /** Consecutive idle ticks (slept without doing work) */
  consecutiveIdleTicks: number;
  /** Consecutive errors for this agent */
  consecutiveErrors: number;
}

/** Full persisted state — saved to autoemon-state.json at corp root. */
export interface AutoemonPersistedState {
  /** Global activation state */
  globalState: AutoemonGlobalState;
  /** Who/what activated autoemon */
  activatedBy: ActivationSource | null;
  /** When autoemon was activated */
  activatedAt: number | null;
  /** SLUMBER duration in ms (null = indefinite) */
  durationMs: number | null;
  /** When SLUMBER should auto-end (activatedAt + durationMs, null = indefinite) */
  endsAt: number | null;
  /** Per-agent state keyed by member ID */
  agents: Record<string, AgentTickState>;
  /** Total ticks across all agents (lifetime) */
  totalTicks: number;
  /** Total productive ticks (lifetime) */
  totalProductiveTicks: number;
  /** Block reason if blocked */
  blockReason: string | null;
}

const DEFAULT_PERSISTED_STATE: AutoemonPersistedState = {
  globalState: 'inactive',
  activatedBy: null,
  activatedAt: null,
  durationMs: null,
  endsAt: null,
  agents: {},
  totalTicks: 0,
  totalProductiveTicks: 0,
  blockReason: null,
};

// ── AutoemonManager ────────────────────────────────────────────────

export class AutoemonManager {
  private daemon: Daemon;
  private state: AutoemonPersistedState;
  /** In-memory set of enrolled agent IDs — fast lookup for Pulse skip check */
  private enrolled = new Set<string>();
  /** Whether the tick loop clock is currently registered */
  private tickLoopRunning = false;
  /** Duration timer — auto-deactivates after SLUMBER duration expires */
  private durationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
    this.state = this.loadState();
    // Rebuild enrolled set from persisted state
    for (const agentId of Object.keys(this.state.agents)) {
      this.enrolled.add(agentId);
    }
  }

  // ── State Queries ────────────────────────────────────────────────

  /** Is autoemon globally active? (active or paused — not inactive or blocked) */
  isActive(): boolean {
    return this.state.globalState === 'active';
  }

  /** Is autoemon in any non-inactive state? */
  isOn(): boolean {
    return this.state.globalState !== 'inactive';
  }

  /** Is this agent enrolled in autoemon? Used by Pulse to skip enrolled agents. */
  isEnrolled(agentId: string): boolean {
    return this.enrolled.has(agentId);
  }

  /** Get the current global state. */
  getGlobalState(): AutoemonGlobalState {
    return this.state.globalState;
  }

  /** Get per-agent tick state. Returns null if agent is not enrolled. */
  getAgentState(agentId: string): AgentTickState | null {
    return this.state.agents[agentId] ?? null;
  }

  /** Get all enrolled agent IDs. */
  getEnrolledAgents(): string[] {
    return [...this.enrolled];
  }

  /** Get the full state for API/TUI display. */
  getStatus(): {
    globalState: AutoemonGlobalState;
    activatedBy: ActivationSource | null;
    activatedAt: number | null;
    enrolledCount: number;
    enrolledAgents: string[];
    totalTicks: number;
    totalProductiveTicks: number;
    blockReason: string | null;
    agents: Record<string, AgentTickState>;
  } {
    return {
      globalState: this.state.globalState,
      activatedBy: this.state.activatedBy,
      activatedAt: this.state.activatedAt,
      enrolledCount: this.enrolled.size,
      enrolledAgents: [...this.enrolled],
      totalTicks: this.state.totalTicks,
      totalProductiveTicks: this.state.totalProductiveTicks,
      blockReason: this.state.blockReason,
      agents: { ...this.state.agents },
    };
  }

  // ── State Transitions ────────────────────────────────────────────

  /**
   * Activate autoemon — start the autonomous work loop.
   * Transitions: INACTIVE → ACTIVE, or PAUSED → ACTIVE (resume).
   */
  activate(source: ActivationSource, durationMs?: number): void {
    const prev = this.state.globalState;
    if (prev === 'active') {
      log(`[autoemon] Already active (activated by ${this.state.activatedBy})`);
      return;
    }

    if (prev !== 'inactive' && prev !== 'paused') {
      logError(`[autoemon] Cannot activate from state '${prev}'`);
      return;
    }

    const now = Date.now();
    this.state.globalState = 'active';
    this.state.activatedBy = source;
    this.state.activatedAt = now;
    this.state.durationMs = durationMs ?? null;
    this.state.endsAt = durationMs ? now + durationMs : null;
    this.state.blockReason = null;

    // Start duration timer if a duration was set
    if (durationMs) {
      this.startDurationTimer(durationMs);
    }

    this.persist();
    const durationLabel = durationMs ? ` for ${Math.round(durationMs / 60_000)}m` : ' (indefinite)';
    log(`[autoemon] ACTIVATED (source: ${source}${durationLabel}, prev: ${prev})`);

    // Broadcast event for TUI
    this.daemon.events.broadcast({
      type: 'autoemon_state',
      state: 'active',
      source,
    });
  }

  /**
   * Deactivate autoemon — stop all ticks, discharge all agents.
   * Transitions: ANY → INACTIVE.
   */
  deactivate(): void {
    const prev = this.state.globalState;
    if (prev === 'inactive') return;

    // Cancel duration timer
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }

    // Stop the tick loop clock first
    this.stopTickLoop();

    // Discharge all agents
    const agentIds = [...this.enrolled];
    for (const agentId of agentIds) {
      this.discharge(agentId);
    }

    this.state.globalState = 'inactive';
    this.state.activatedBy = null;
    this.state.activatedAt = null;
    this.state.durationMs = null;
    this.state.endsAt = null;
    this.state.blockReason = null;

    this.persist();
    log(`[autoemon] DEACTIVATED (prev: ${prev}, was enrolled: ${agentIds.length} agents)`);

    this.daemon.events.broadcast({
      type: 'autoemon_state',
      state: 'inactive',
    });
  }

  /**
   * Pause autoemon — ticks stop, state preserved.
   * Transitions: ACTIVE → PAUSED.
   * Triggered by: user Esc, /stop command.
   */
  pause(): void {
    if (this.state.globalState !== 'active') {
      log(`[autoemon] Cannot pause from state '${this.state.globalState}'`);
      return;
    }

    this.state.globalState = 'paused';
    this.persist();
    log(`[autoemon] PAUSED (${this.enrolled.size} agents enrolled, ticks halted)`);

    this.daemon.events.broadcast({
      type: 'autoemon_state',
      state: 'paused',
    });
  }

  /**
   * Resume autoemon — ticks restart.
   * Transitions: PAUSED → ACTIVE.
   * Triggered by: user input, /resume command.
   */
  resume(): void {
    if (this.state.globalState !== 'paused') {
      log(`[autoemon] Cannot resume from state '${this.state.globalState}'`);
      return;
    }

    this.state.globalState = 'active';
    this.state.blockReason = null;
    this.persist();
    log(`[autoemon] RESUMED (${this.enrolled.size} agents enrolled)`);

    this.daemon.events.broadcast({
      type: 'autoemon_state',
      state: 'active',
    });
  }

  /**
   * Block autoemon — API error, all ticks paused.
   * Transitions: ACTIVE → BLOCKED.
   * Triggered by: context blocker detecting rate limit, auth error, etc.
   */
  block(reason: string): void {
    if (this.state.globalState !== 'active') return;

    this.state.globalState = 'blocked';
    this.state.blockReason = reason;
    this.persist();
    log(`[autoemon] BLOCKED: ${reason}`);

    this.daemon.events.broadcast({
      type: 'autoemon_state',
      state: 'blocked',
      reason,
    });
  }

  /**
   * Unblock autoemon — successful response, ticks resume.
   * Transitions: BLOCKED → ACTIVE.
   */
  unblock(): void {
    if (this.state.globalState !== 'blocked') return;

    this.state.globalState = 'active';
    this.state.blockReason = null;
    this.persist();
    log(`[autoemon] UNBLOCKED — ticks resuming`);

    this.daemon.events.broadcast({
      type: 'autoemon_state',
      state: 'active',
    });
  }

  // ── Agent Enrollment ─────────────────────────────────────────────

  /**
   * Enroll an agent in autoemon — they start receiving <tick> prompts.
   * Pulse will skip this agent from now on.
   */
  enroll(agentId: string): void {
    if (this.enrolled.has(agentId)) return; // Already enrolled

    this.enrolled.add(agentId);
    this.state.agents[agentId] = {
      state: 'active',
      enrolledAt: Date.now(),
      tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
      nextTickAt: Date.now() + DEFAULT_TICK_INTERVAL_MS,
      sleepUntil: null,
      sleepReason: null,
      tickCount: 0,
      productiveTickCount: 0,
      consecutiveIdleTicks: 0,
      consecutiveErrors: 0,
    };

    this.persist();
    log(`[autoemon] Enrolled ${agentId} (interval: ${DEFAULT_TICK_INTERVAL_MS / 1000}s)`);
  }

  /**
   * Discharge an agent — back to Pulse heartbeat.
   * Removes all autoemon state for this agent.
   */
  discharge(agentId: string): void {
    if (!this.enrolled.has(agentId)) return;

    const agentState = this.state.agents[agentId];
    const tickCount = agentState?.tickCount ?? 0;
    const productive = agentState?.productiveTickCount ?? 0;

    this.enrolled.delete(agentId);
    delete this.state.agents[agentId];

    this.persist();
    log(`[autoemon] Discharged ${agentId} (${tickCount} ticks, ${productive} productive)`);
  }

  // ── Conscription Cascade ──────────────────────────────────────────

  /**
   * Conscript agents based on active contracts and hierarchy.
   * CEO always enrolls. Team leaders on active contracts enroll.
   * Workers with active tasks on those contracts enroll.
   *
   * Called on activation and periodically (every 10 ticks) to pick up
   * newly hired workers and new contract assignments.
   */
  conscript(): void {
    const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    const beforeCount = this.enrolled.size;

    // 1. CEO always enrolls (entry point)
    const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
    if (ceo) this.enroll(ceo.id);

    // 2. Find active contracts → enroll their leads + workers
    try {
      const allContracts = listAllContracts(this.daemon.corpRoot);
      const activeContracts = allContracts.filter(
        (c) => c.contract.status === 'active',
      );

      for (const { contract } of activeContracts) {
        // Enroll the contract lead (team leader)
        const leaderId = (contract as any).leaderId ?? (contract as any).assignedTo;
        if (leaderId) {
          this.enroll(leaderId);
        }

        // Enroll workers assigned to tasks in this contract
        try {
          const allTasks = listTasks(this.daemon.corpRoot, {});
          const contractTasks = allTasks.filter(
            (t) => (t.task as any).contractId === contract.id || (t.task as any).parentTaskId === contract.id,
          );
          for (const { task } of contractTasks) {
            if (task.assignedTo && task.status !== 'completed' && task.status !== 'cancelled') {
              this.enroll(task.assignedTo);
            }
          }
        } catch {} // Tasks might not exist yet
      }
    } catch {} // No contracts yet — just CEO

    // 3. Also enroll any agents with active (in_progress) tasks even without contracts
    try {
      const activeTasks = listTasks(this.daemon.corpRoot, { status: 'in_progress' });
      for (const { task } of activeTasks) {
        if (task.assignedTo) {
          this.enroll(task.assignedTo);
        }
      }
    } catch {}

    const newlyEnrolled = this.enrolled.size - beforeCount;
    if (newlyEnrolled > 0) {
      log(`[autoemon] Conscription: ${newlyEnrolled} new agent(s) enrolled (total: ${this.enrolled.size})`);
    }
  }

  /**
   * Discharge agents whose contracts or tasks completed.
   * Workers with no active tasks → discharge.
   * Leaders with no active contracts → discharge.
   * CEO never discharged.
   *
   * Called after contract completion events and periodically.
   */
  dischargeCompleted(): void {
    const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    const discharged: string[] = [];

    for (const agentId of [...this.enrolled]) {
      const member = members.find(m => m.id === agentId);
      if (!member) continue;

      // CEO never discharged
      if (member.rank === 'master') continue;

      // Check if agent still has active work
      try {
        const agentTasks = listTasks(this.daemon.corpRoot, { assignedTo: agentId });
        const hasActiveWork = agentTasks.some(
          (t) => t.task.status === 'in_progress' || t.task.status === 'pending',
        );

        if (!hasActiveWork) {
          this.discharge(agentId);
          discharged.push(member.displayName);
        }
      } catch {
        // Can't check tasks — keep enrolled to be safe
      }
    }

    if (discharged.length > 0) {
      log(`[autoemon] Discharged ${discharged.length} agent(s) (no active work): ${discharged.join(', ')}`);
    }
  }

  /** Counter for periodic re-scan (every 10 ticks). */
  private conscriptionCounter = 0;

  /** Called after each tick cycle to check if re-scan is due. */
  checkConscription(): void {
    this.conscriptionCounter++;
    if (this.conscriptionCounter >= 10) {
      this.conscriptionCounter = 0;
      this.conscript();
      this.dischargeCompleted();
    }
  }

  // ── Tick Loop ─────────────────────────────────────────────────────

  /** Start the tick loop — registers a Clock for observability. */
  startTickLoop(): void {
    if (this.tickLoopRunning) {
      log(`[autoemon] Tick loop already running — skipping re-registration`);
      return;
    }

    this.daemon.clocks.register({
      id: 'autoemon-tick',
      name: 'Autoemon Ticks',
      type: 'system',
      intervalMs: TICK_CHECK_INTERVAL_MS,
      target: 'enrolled agents',
      description: 'Fires <tick> prompts to enrolled autoemon agents on their adaptive schedules',
      callback: () => this.tickCycle(),
    });
    this.tickLoopRunning = true;
    log(`[autoemon] Tick loop started (check interval: ${TICK_CHECK_INTERVAL_MS / 1000}s)`);
  }

  /** Stop the tick loop — removes the Clock. */
  stopTickLoop(): void {
    if (!this.tickLoopRunning) return;
    this.daemon.clocks.remove('autoemon-tick');
    this.tickLoopRunning = false;
    log(`[autoemon] Tick loop stopped`);
  }

  /**
   * The core tick cycle — runs every 10 seconds.
   * Iterates enrolled agents, dispatches ticks to any that are due.
   * Agents are dispatched sequentially with stagger (like Pulse) to avoid
   * thundering herd on the API.
   */
  private async tickCycle(): Promise<void> {
    if (this.state.globalState !== 'active') return; // Only tick when active

    const now = Date.now();
    const dueAgents: string[] = [];

    // Find agents with due ticks
    for (const [agentId, agentState] of Object.entries(this.state.agents)) {
      if (agentState.state === 'blocked') continue;

      // Sleeping agents: check if sleep expired
      if (agentState.state === 'sleeping' && agentState.sleepUntil) {
        if (now < agentState.sleepUntil) continue; // Still sleeping
        // Sleep expired — wake up
        this.wakeAgent(agentId);
      }

      // Check if tick is due
      if (now >= agentState.nextTickAt) {
        dueAgents.push(agentId);
      }
    }

    if (dueAgents.length === 0) return;

    // Dispatch ticks as fire-and-forget — DO NOT await.
    // The ClockManager has an overlap guard that blocks subsequent fires
    // if the callback is still running. Dispatches can take 30+ seconds,
    // which would freeze the entire tick loop. Instead, we fire and track.
    for (const agentId of dueAgents) {
      // Mark agent as dispatching so we don't double-dispatch
      const agentState = this.state.agents[agentId];
      if (!agentState) continue;

      // Set nextTickAt far into the future to prevent re-dispatch
      // while this tick is in flight. Will be reset on completion.
      agentState.nextTickAt = Date.now() + 10 * 60 * 1000; // 10min safety

      // Fire-and-forget — handle result asynchronously
      this.dispatchTick(agentId).catch(err => {
        logError(`[autoemon] Tick dispatch failed for ${agentId}: ${err}`);
        this.recordError(agentId);
        // Reset nextTickAt so agent gets another chance
        if (agentState) {
          agentState.nextTickAt = Date.now() + agentState.tickIntervalMs;
        }
      });
    }

    // Periodic re-scan: pick up new workers, discharge completed
    this.checkConscription();
  }

  /**
   * Dispatch a single tick to an agent via say().
   * Handles: response parsing, interval adaptation, sleep detection, telemetry.
   */
  private async dispatchTick(agentId: string): Promise<void> {
    const agentState = this.state.agents[agentId];
    if (!agentState) return;

    // Resolve the agent's display name for the slug
    const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    const member = members.find(m => m.id === agentId);
    if (!member) {
      logError(`[autoemon] Agent ${agentId} not found in members — discharging`);
      this.discharge(agentId);
      return;
    }

    const agentSlug = member.displayName.toLowerCase().replace(/\s+/g, '-');
    const isFirstTick = agentState.tickCount === 0;
    const wasSleeping = agentState.sleepUntil !== null;

    // Build the tick context — brief snapshot to save agent from re-reading
    const tickContext: TickContext = {
      pendingTasks: this.countAgentPendingTasks(agentId),
      unreadInbox: this.countAgentUnreadInbox(agentId),
      lastAction: undefined, // Will be populated from telemetry in future
    };

    // Get founder presence
    const presence = this.getFounderPresence();

    // Build the appropriate tick message
    let tickMessage: string;
    if (isFirstTick) {
      tickMessage = buildFirstTickMessage({
        presence,
        agentName: member.displayName,
        source: this.state.activatedBy ?? 'manual',
        enrolledCount: this.enrolled.size,
        context: tickContext,
      });
    } else if (wasSleeping) {
      const sleptFor = agentState.sleepUntil! - (agentState.nextTickAt - agentState.tickIntervalMs);
      const wakeInfo = this.consumeWakeReason(agentId);
      tickMessage = buildSleepWakeTick({
        presence,
        sleptForMs: Math.max(sleptFor, 0),
        wakeReason: wakeInfo?.reason ?? 'timer',
        whileAsleep: wakeInfo?.detail,
        context: tickContext,
      });
      agentState.sleepUntil = null;
      agentState.sleepReason = null;
    } else {
      tickMessage = buildTickMessage({
        presence,
        context: tickContext,
      });
    }

    // Dispatch via say() — persistent session per agent
    const sessionKey = `autoemon:${agentSlug}`;
    const startTime = Date.now();

    log(`[autoemon] Tick #${agentState.tickCount + 1} → ${member.displayName} (interval: ${Math.round(agentState.tickIntervalMs / 1000)}s)`);

    try {
      const resp = await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: agentSlug,
          message: tickMessage,
          sessionKey,
        }),
        signal: AbortSignal.timeout(TICK_DISPATCH_TIMEOUT_MS),
      });

      const data = await resp.json() as Record<string, unknown>;
      const durationMs = Date.now() - startTime;

      if (!data.ok) {
        const errorMsg = String(data.error ?? 'unknown');
        logError(`[autoemon] ${member.displayName} tick failed: ${errorMsg}`);
        this.recordError(agentId);
        this.adaptInterval(agentId, 'error');
        this.writeTelemetry(agentId, member.displayName, durationMs, 'error', errorMsg);
        return;
      }

      const response = String(data.response ?? '');

      // Parse the response to determine what happened
      const tickResult = this.parseTickResponse(response);
      const productive = tickResult.type === 'productive';

      // Record the tick
      this.recordTick(agentId, productive);

      // Handle sleep
      if (tickResult.type === 'sleep') {
        this.setSleeping(agentId, Date.now() + tickResult.durationMs, tickResult.reason);
        this.writeTelemetry(agentId, member.displayName, durationMs, 'sleep', tickResult.reason);
      } else {
        // Adapt interval based on result
        this.adaptInterval(agentId, tickResult.type);
        this.writeTelemetry(agentId, member.displayName, durationMs, tickResult.type, response.slice(0, 200));
      }

      // Schedule next tick
      agentState.nextTickAt = Date.now() + agentState.tickIntervalMs;

    } catch (err) {
      const durationMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[autoemon] ${member.displayName} tick dispatch error: ${msg}`);
      this.recordError(agentId);
      this.adaptInterval(agentId, 'error');
      this.writeTelemetry(agentId, member.displayName, durationMs, 'error', msg);

      // Schedule next tick with backoff
      agentState.nextTickAt = Date.now() + agentState.tickIntervalMs;
    }
  }

  // ── Response Parsing ─────────────────────────────────────────────

  /** Parse the agent's tick response to classify what happened. */
  private parseTickResponse(
    response: string,
  ): { type: 'productive' | 'idle' | 'sleep' | 'error'; durationMs: number; reason: string } {
    // Check for SLEEP command first — highest priority signal
    const sleepMatch = response.match(SLEEP_PATTERN);
    if (sleepMatch) {
      const durationStr = sleepMatch[1]!;
      const reason = sleepMatch[2]?.trim() ?? 'no reason given';
      const durationMs = this.parseSleepDuration(durationStr);
      return { type: 'sleep', durationMs, reason };
    }

    const lower = response.toLowerCase();

    // Explicit idle signals
    if (lower.includes('heartbeat_ok') || lower.includes('nothing to do') || lower.includes('no pending work')) {
      return { type: 'idle', durationMs: 0, reason: 'explicit idle' };
    }

    // Short response with no work evidence → idle
    if (response.length < IDLE_RESPONSE_MAX_CHARS) {
      return { type: 'idle', durationMs: 0, reason: 'short response' };
    }

    // Content-based productive detection — look for evidence of actual work
    // (since /cc/say doesn't return tool event metadata)
    const productiveSignals = [
      /\b(?:read|wrote|created|updated|modified|fixed|committed|deleted|moved|renamed)\b/i,
      /\b(?:build|test|pass|fail|error|warning)\b.*\b(?:pass|fail|success|output)\b/i,
      /\b(?:src|dist|packages|agents|tasks)\//,     // File paths
      /\.[a-z]{1,4}(?:\s|$|:|\))/i,                 // File extensions (.ts, .md, .json)
      /\bline\s+\d+\b/i,                            // Line references
      /\btask\s+\w+-\w+\b/i,                        // Task IDs (word-pair format)
      /```[\s\S]*```/,                               // Code blocks (agent showed code)
      /\b(?:DONE|COMPLETE|BLOCKED|IN_PROGRESS)\b/,   // Status keywords
      /\bcc-cli\s+\w+/,                             // CLI commands executed
    ];

    const matchCount = productiveSignals.filter(re => re.test(response)).length;

    // 2+ productive signals → definitely productive
    if (matchCount >= 2) {
      return { type: 'productive', durationMs: 0, reason: `${matchCount} work signals detected` };
    }

    // 1 signal + long response → probably productive
    if (matchCount >= 1 && response.length > 200) {
      return { type: 'productive', durationMs: 0, reason: 'work signal + substantial response' };
    }

    // Long response but no clear work signals → mild productive (could be planning/thinking)
    if (response.length > 300) {
      return { type: 'productive', durationMs: 0, reason: 'long response (planning/thinking)' };
    }

    // Default: moderate-length response with no clear signals → idle
    return { type: 'idle', durationMs: 0, reason: 'no clear work signals' };
  }

  /**
   * Parse a sleep duration string into milliseconds.
   * Uses shared parseIntervalExpression for standard formats (5m, 30s, 2h, 1h30m).
   * Falls back to custom parsing for edge cases.
   */
  private parseSleepDuration(str: string): number {
    // Try shared parser first (handles "5m", "30s", "2h", "1h30m")
    const parsed = parseIntervalExpression(str);
    if (parsed !== null) {
      return Math.max(MIN_TICK_INTERVAL_MS, Math.min(MAX_TICK_INTERVAL_MS, parsed));
    }

    // Fallback: custom parsing for "5d" or other formats the shared parser doesn't handle
    let total = 0;
    const parts = str.match(/(\d+)([smhd])/gi) ?? [];
    for (const part of parts) {
      const match = part.match(/(\d+)([smhd])/i);
      if (!match) continue;
      const num = parseInt(match[1]!, 10);
      const unit = match[2]!.toLowerCase();
      switch (unit) {
        case 's': total += num * 1000; break;
        case 'm': total += num * 60 * 1000; break;
        case 'h': total += num * 60 * 60 * 1000; break;
        case 'd': total += num * 24 * 60 * 60 * 1000; break;
      }
    }
    return Math.max(MIN_TICK_INTERVAL_MS, Math.min(MAX_TICK_INTERVAL_MS, total || DEFAULT_TICK_INTERVAL_MS));
  }

  // ── Adaptive Interval ────────────────────────────────────────────

  /** Adapt the tick interval based on what the agent did. */
  private adaptInterval(agentId: string, result: 'productive' | 'idle' | 'error'): void {
    const agentState = this.state.agents[agentId];
    if (!agentState) return;

    switch (result) {
      case 'productive':
        // Agent did work — stay close, more work likely
        agentState.tickIntervalMs = PRODUCTIVE_INTERVAL_MS;
        agentState.consecutiveIdleTicks = 0;
        break;

      case 'idle':
        if (agentState.consecutiveIdleTicks >= AUTO_SLOW_THRESHOLD) {
          // 3+ idle ticks — auto-slow
          agentState.tickIntervalMs = AUTO_SLOW_INTERVAL_MS;
        } else {
          // Normal idle — moderate interval
          agentState.tickIntervalMs = IDLE_INTERVAL_MS;
        }
        break;

      case 'error':
        // Exponential backoff: double the interval on each error, up to max
        agentState.tickIntervalMs = Math.min(
          agentState.tickIntervalMs * 2,
          MAX_TICK_INTERVAL_MS,
        );
        break;
    }
  }

  // ── Context Helpers ──────────────────────────────────────────────

  /** Count pending tasks assigned to this agent (quick check). */
  private countAgentPendingTasks(agentId: string): number {
    try {
      const pending = listTasks(this.daemon.corpRoot, { assignedTo: agentId, status: 'pending' });
      const inProgress = listTasks(this.daemon.corpRoot, { assignedTo: agentId, status: 'in_progress' });
      return pending.length + inProgress.length;
    } catch { return 0; }
  }

  /** Count unread inbox items for this agent (quick stat check). */
  private countAgentUnreadInbox(agentId: string): number {
    try {
      const pending = this.daemon.inbox.peekNext(agentId);
      return pending ? 1 : 0; // Simplified — inbox is one-at-a-time
    } catch { return 0; }
  }

  /** Get the founder's current presence. Defaults to 'away'. */
  private getFounderPresence(): FounderPresence {
    // Will be wired to TUI connection tracking in commit 7.
    // For now, default to 'away' (most autonomous mode).
    return 'away';
  }

  // ── Telemetry ────────────────────────────────────────────────────

  /** Write a telemetry entry to autoemon-telemetry.jsonl (append-only). */
  private writeTelemetry(
    agentId: string,
    agentName: string,
    durationMs: number,
    action: 'productive' | 'idle' | 'sleep' | 'error',
    details: string,
  ): void {
    try {
      const entry = {
        timestamp: new Date().toISOString(),
        agentId,
        agentName,
        tickNumber: this.state.agents[agentId]?.tickCount ?? 0,
        durationMs,
        action,
        details: details.slice(0, 300),
        intervalMs: this.state.agents[agentId]?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
      };
      const filePath = join(this.daemon.corpRoot, TELEMETRY_FILE);
      appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Non-fatal — telemetry is best-effort
    }
  }

  // ── Tick State Updates ───────────────────────────────────────────

  /** Record a tick was fired for an agent. */
  recordTick(agentId: string, productive: boolean): void {
    const agentState = this.state.agents[agentId];
    if (!agentState) return;

    agentState.tickCount++;
    this.state.totalTicks++;

    if (productive) {
      agentState.productiveTickCount++;
      agentState.consecutiveIdleTicks = 0;
      agentState.consecutiveErrors = 0;
      this.state.totalProductiveTicks++;
    } else {
      agentState.consecutiveIdleTicks++;
    }

    // No persist here — too frequent. Persistence handled by periodic flush.
  }

  /** Record an error for an agent tick. */
  recordError(agentId: string): void {
    const agentState = this.state.agents[agentId];
    if (!agentState) return;

    agentState.consecutiveErrors++;
    agentState.consecutiveIdleTicks = 0;
  }

  /** Update an agent's next tick time. */
  setNextTick(agentId: string, nextTickAt: number): void {
    const agentState = this.state.agents[agentId];
    if (!agentState) return;

    agentState.nextTickAt = nextTickAt;
  }

  /** Update an agent's tick interval (adaptive). */
  setTickInterval(agentId: string, intervalMs: number): void {
    const agentState = this.state.agents[agentId];
    if (!agentState) return;

    // Clamp to min/max bounds
    agentState.tickIntervalMs = Math.max(MIN_TICK_INTERVAL_MS, Math.min(MAX_TICK_INTERVAL_MS, intervalMs));
  }

  /** Put an agent to sleep. */
  setSleeping(agentId: string, sleepUntil: number, reason: string): void {
    const agentState = this.state.agents[agentId];
    if (!agentState) return;

    agentState.state = 'sleeping';
    agentState.sleepUntil = sleepUntil;
    agentState.sleepReason = reason;
    agentState.nextTickAt = sleepUntil;
    log(`[autoemon] ${agentId} sleeping until ${new Date(sleepUntil).toLocaleTimeString()} — ${reason}`);
  }

  /** Wake an agent from sleep. */
  /** Wake reasons for telemetry and the sleep-wake tick message. */
  private pendingWakeReason = new Map<string, { reason: WakeReason; detail?: string }>();

  /** Wake an agent from sleep. Reason tracked for the next tick message. */
  wakeAgent(agentId: string, reason: WakeReason = 'timer', detail?: string): void {
    const agentState = this.state.agents[agentId];
    if (!agentState || agentState.state !== 'sleeping') return;

    const wasReason = agentState.sleepReason ?? 'unknown';
    const sleptMs = agentState.sleepUntil ? agentState.sleepUntil - (agentState.nextTickAt - agentState.tickIntervalMs) : 0;

    agentState.state = 'active';
    agentState.sleepUntil = null;
    agentState.sleepReason = null;
    agentState.nextTickAt = Date.now(); // Tick immediately on wake

    // Store wake reason for the next tick to include in the message
    this.pendingWakeReason.set(agentId, { reason, detail });

    log(`[autoemon] ${agentId} woke up (reason: ${reason}${detail ? ` — ${detail}` : ''}, was sleeping: "${wasReason}")`);

    // Broadcast for TUI
    this.daemon.events.broadcast({
      type: 'autoemon_state',
      state: 'wake',
      source: agentId,
      reason: `${reason}: ${detail ?? ''}`,
    });
  }

  /** Consume the pending wake reason for a given agent (called by dispatchTick). */
  consumeWakeReason(agentId: string): { reason: WakeReason; detail?: string } | null {
    const pending = this.pendingWakeReason.get(agentId);
    if (pending) {
      this.pendingWakeReason.delete(agentId);
      return pending;
    }
    return null;
  }

  /**
   * Check if the given agent is sleeping. Used by the router and API
   * to decide whether to wake the agent on incoming messages/tasks.
   */
  isSleeping(agentId: string): boolean {
    const agentState = this.state.agents[agentId];
    return agentState?.state === 'sleeping' || false;
  }

  /**
   * Get sleep info for display — remaining time, reason, etc.
   * Returns null if agent is not sleeping.
   */
  getSleepInfo(agentId: string): {
    sleepUntil: number;
    remainingMs: number;
    reason: string;
  } | null {
    const agentState = this.state.agents[agentId];
    if (!agentState || agentState.state !== 'sleeping' || !agentState.sleepUntil) return null;
    return {
      sleepUntil: agentState.sleepUntil,
      remainingMs: Math.max(0, agentState.sleepUntil - Date.now()),
      reason: agentState.sleepReason ?? 'unknown',
    };
  }

  // ── Persistence ──────────────────────────────────────────────────

  /** Save state to autoemon-state.json. */
  persist(): void {
    try {
      const filePath = join(this.daemon.corpRoot, STATE_FILE);
      writeFileSync(filePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      logError(`[autoemon] Failed to persist state: ${err}`);
    }
  }

  /** Load state from autoemon-state.json (or return defaults). */
  private loadState(): AutoemonPersistedState {
    try {
      const filePath = join(this.daemon.corpRoot, STATE_FILE);
      if (!existsSync(filePath)) return { ...DEFAULT_PERSISTED_STATE, agents: {} };
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as AutoemonPersistedState;
    } catch {
      return { ...DEFAULT_PERSISTED_STATE, agents: {} };
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /** Called on daemon shutdown. Persist final state + cancel timers. */
  stop(): void {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    this.persist();
    log(`[autoemon] Stopped. State: ${this.state.globalState}, enrolled: ${this.enrolled.size}`);
  }

  // ── SLUMBER Duration ─────────────────────────────────────────────

  /**
   * Start a timer that auto-wraps-up SLUMBER after the given duration.
   * Before deactivating, dispatches a wrap-up prompt to the CEO so
   * the CEO summarizes what happened — that IS the wake digest.
   */
  private startDurationTimer(durationMs: number): void {
    if (this.durationTimer) clearTimeout(this.durationTimer);

    this.durationTimer = setTimeout(async () => {
      log(`[autoemon] SLUMBER duration expired (${Math.round(durationMs / 60_000)}m) — wrapping up`);
      this.durationTimer = null;

      // Dispatch wrap-up to CEO before deactivating
      try {
        await this.dispatchWrapUp('timer');
      } catch (err) {
        logError(`[autoemon] Wrap-up dispatch failed: ${err}`);
      }

      // Deactivate after CEO has responded (or tried to)
      this.deactivate();
    }, durationMs);

    log(`[autoemon] Duration timer set: ${Math.round(durationMs / 60_000)}m`);
  }

  /**
   * Dispatch a wrap-up prompt to the CEO. The CEO's response IS the wake digest.
   * Called on: duration expiry, /wake command, manual deactivation.
   */
  async dispatchWrapUp(reason: 'timer' | 'wake_command' | 'manual'): Promise<string> {
    const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
    if (!ceo) return 'No CEO found.';

    const agentSlug = ceo.displayName.toLowerCase().replace(/\s+/g, '-');
    const elapsed = this.state.activatedAt ? Date.now() - this.state.activatedAt : 0;
    const elapsedLabel = elapsed > 3_600_000
      ? `${Math.round(elapsed / 3_600_000)}h ${Math.round((elapsed % 3_600_000) / 60_000)}m`
      : `${Math.round(elapsed / 60_000)}m`;

    const reasonLabel = {
      timer: 'SLUMBER duration has expired.',
      wake_command: 'The Founder typed /wake.',
      manual: 'SLUMBER was manually stopped.',
    }[reason];

    const prompt = [
      `SLUMBER is ending. ${reasonLabel}`,
      ``,
      `Session stats: ${elapsedLabel} elapsed, ${this.state.totalTicks} ticks fired, ${this.state.totalProductiveTicks} productive.`,
      `Enrolled agents: ${[...this.enrolled].join(', ') || 'none'}.`,
      ``,
      `Summarize everything that happened during this SLUMBER session:`,
      `- What tasks did you work on?`,
      `- What decisions did you make?`,
      `- What got completed?`,
      `- Anything that needs the Founder's attention?`,
      `- Any blockers or issues?`,
      ``,
      `Be concise but thorough. This is the Founder's wake-up briefing.`,
    ].join('\n');

    try {
      const resp = await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: agentSlug,
          message: prompt,
          sessionKey: `autoemon:${agentSlug}`,
        }),
        signal: AbortSignal.timeout(90_000),
      });

      const data = await resp.json() as Record<string, unknown>;
      const response = String(data.response ?? 'No response.');
      log(`[autoemon] CEO wrap-up: ${response.slice(0, 200)}`);
      return response;
    } catch (err) {
      const msg = `Wrap-up failed: ${err instanceof Error ? err.message : String(err)}`;
      logError(`[autoemon] ${msg}`);
      return msg;
    }
  }

  /**
   * Generate a brief system-level digest (fallback if CEO wrap-up fails).
   * Returns stats only — no CEO narration.
   */
  generateDigest(): string {
    const elapsed = this.state.activatedAt ? Date.now() - this.state.activatedAt : 0;
    const elapsedLabel = elapsed > 3_600_000
      ? `${Math.round(elapsed / 3_600_000)}h ${Math.round((elapsed % 3_600_000) / 60_000)}m`
      : `${Math.round(elapsed / 60_000)}m`;

    const lines: string[] = [
      `SLUMBER ended after ${elapsedLabel}.`,
      `Ticks: ${this.state.totalTicks} total, ${this.state.totalProductiveTicks} productive.`,
      `Enrolled: ${[...this.enrolled].join(', ') || 'none'}.`,
    ];

    // Per-agent summary
    for (const [agentId, agentState] of Object.entries(this.state.agents)) {
      const pct = agentState.tickCount > 0
        ? Math.round((agentState.productiveTickCount / agentState.tickCount) * 100)
        : 0;
      lines.push(`  ${agentId}: ${agentState.tickCount} ticks, ${pct}% productive`);
    }

    return lines.join('\n');
  }

  /** Get SLUMBER progress info for the moon phase status bar. */
  getProgress(): { elapsed: number; total: number | null; fraction: number; endsAt: number | null } {
    const now = Date.now();
    const elapsed = this.state.activatedAt ? now - this.state.activatedAt : 0;
    const total = this.state.durationMs;
    const fraction = total ? Math.min(1, elapsed / total) : 0;
    return { elapsed, total, fraction, endsAt: this.state.endsAt };
  }
}
