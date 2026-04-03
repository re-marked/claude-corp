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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

// ── Constants ──────────────────────────────────────────────────────

const STATE_FILE = 'autoemon-state.json';

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
  activate(source: ActivationSource): void {
    const prev = this.state.globalState;
    if (prev === 'active') {
      log(`[autoemon] Already active (activated by ${this.state.activatedBy})`);
      return;
    }

    if (prev !== 'inactive' && prev !== 'paused') {
      logError(`[autoemon] Cannot activate from state '${prev}'`);
      return;
    }

    this.state.globalState = 'active';
    this.state.activatedBy = source;
    this.state.activatedAt = Date.now();
    this.state.blockReason = null;

    this.persist();
    log(`[autoemon] ACTIVATED (source: ${source}, prev: ${prev})`);

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

    // Discharge all agents
    const agentIds = [...this.enrolled];
    for (const agentId of agentIds) {
      this.discharge(agentId);
    }

    this.state.globalState = 'inactive';
    this.state.activatedBy = null;
    this.state.activatedAt = null;
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

  // ── Tick State Updates (called by tick loop in future commits) ───

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
  wakeAgent(agentId: string): void {
    const agentState = this.state.agents[agentId];
    if (!agentState || agentState.state !== 'sleeping') return;

    agentState.state = 'active';
    agentState.sleepUntil = null;
    agentState.sleepReason = null;
    agentState.nextTickAt = Date.now(); // Tick immediately on wake
    log(`[autoemon] ${agentId} woke up`);
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

  /** Called on daemon shutdown. Persist final state. */
  stop(): void {
    this.persist();
    log(`[autoemon] Stopped. State: ${this.state.globalState}, enrolled: ${this.enrolled.size}`);
  }
}
