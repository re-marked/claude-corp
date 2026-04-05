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
 * - Uses the same jack:<slug> session as normal DM chat — full conversation memory
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
  CORP_JSON,
  type Corporation,
  parseIntervalExpression,
} from '@claudecorp/shared';
import { type SlumberProfile, getProfile } from './slumber-profiles.js';
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
export const SLEEP_PATTERN = /SLEEP\s+(\d+[smhd](?:\d+[smh])?)\s*(?:—\s*(.+))?/i;

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
  /** Active SLUMBER profile ID (null = no profile, default behavior) */
  activeProfileId: string | null;
  /** SLUMBER duration in ms (null = indefinite) */
  durationMs: number | null;
  /** When SLUMBER should auto-end (activatedAt + durationMs, null = indefinite) */
  endsAt: number | null;
  /** Budget: max ticks before auto-stop (null = unlimited) */
  budgetTicks: number | null;
  /** Per-agent state keyed by member ID */
  agents: Record<string, AgentTickState>;
  /** Total ticks across all agents (lifetime) */
  totalTicks: number;
  /** Total productive ticks (lifetime) */
  totalProductiveTicks: number;
  /** Scheduled SLUMBER window (from /slumber schedule <profile>) */
  schedule: {
    profileId: string;
    startHour: number;
    endHour: number;
    durationMs: number;
    weekdaysOnly: boolean;
    raw: string;
  } | null;
  /** Block reason if blocked */
  blockReason: string | null;
}

const DEFAULT_PERSISTED_STATE: AutoemonPersistedState = {
  globalState: 'inactive',
  activatedBy: null,
  activatedAt: null,
  activeProfileId: null,
  durationMs: null,
  endsAt: null,
  budgetTicks: null,
  schedule: null,
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
    activeProfileId: string | null;
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
      activeProfileId: this.state.activeProfileId,
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
  activate(source: ActivationSource, durationMs?: number, profileId?: string): void {
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
    this.state.activeProfileId = profileId ?? null;
    this.state.blockReason = null;

    // Apply profile settings (overrides manual durationMs if profile provides them)
    const profile = profileId ? getProfile(this.daemon.corpRoot, profileId) : null;
    const effectiveDuration = durationMs ?? profile?.durationMs ?? null;
    const effectiveBudget = profile?.budgetTicks ?? null;
    this.state.durationMs = effectiveDuration;
    this.state.endsAt = effectiveDuration ? now + effectiveDuration : null;
    this.state.budgetTicks = effectiveBudget;

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

    // Capture state BEFORE clearing — needed for post-SLUMBER actions
    const activatedAt = this.state.activatedAt;
    const agentIds = [...this.enrolled];

    // Discharge all agents
    for (const agentId of agentIds) {
      this.discharge(agentId);
    }

    this.state.globalState = 'inactive';
    this.state.activatedBy = null;
    this.state.activatedAt = null;
    this.state.activeProfileId = null;
    this.state.durationMs = null;
    this.state.endsAt = null;
    this.state.budgetTicks = null;
    this.state.blockReason = null;

    this.persist();
    log(`[autoemon] DEACTIVATED (prev: ${prev}, was enrolled: ${agentIds.length} agents)`);

    // Schedule post-SLUMBER dreams for agents that were active
    if (agentIds.length > 0) {
      this.daemon.dreams.schedulePostSlumberDreams(agentIds);
    }

    // Post morning standup to #general if SLUMBER was 4+ hours (overnight)
    if (activatedAt) {
      import('./morning-standup.js').then(({ postMorningStandup }) => {
        postMorningStandup({
          corpRoot: this.daemon.corpRoot,
          activatedAt,
          enrolledAgents: agentIds,
        }).catch(err => logError(`[autoemon] Morning standup failed: ${err}`));
      });
    }

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
    // Use profile tick interval if active, otherwise default
    const profile = this.state.activeProfileId ? getProfile(this.daemon.corpRoot, this.state.activeProfileId) : null;
    const interval = profile?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;

    this.state.agents[agentId] = {
      state: 'active',
      enrolledAt: Date.now(),
      tickIntervalMs: interval,
      nextTickAt: Date.now() + interval,
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

    // Get conscription strategy from active profile
    const profile = this.state.activeProfileId
      ? getProfile(this.daemon.corpRoot, this.state.activeProfileId)
      : null;
    const strategy = profile?.conscription ?? 'active-contracts';

    // 1. CEO always enrolls (entry point)
    const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
    if (ceo) this.enroll(ceo.id);

    // CEO-only strategy stops here (Guard Duty)
    if (strategy === 'ceo-only') {
      const newlyEnrolled = this.enrolled.size - beforeCount;
      if (newlyEnrolled > 0) log(`[autoemon] Conscription (${strategy}): ${newlyEnrolled} agent(s) enrolled`);
      return;
    }

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

    // 4. All-agents strategy: enroll every online agent (Sprint mode)
    if (strategy === 'all-agents') {
      for (const member of members) {
        if (member.type === 'agent' && member.status !== 'archived') {
          this.enroll(member.id);
        }
      }
    }

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

    // Don't fire ticks while founder is actively chatting — prevents
    // dual-dispatch (router handles manual messages, autoemon handles ticks).
    // Ticks resume when founder goes idle (10min) or away (TUI closed).
    const presence = this.getFounderPresence();
    if (presence === 'watching') return;

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

    // Budget check — auto-stop if tick budget exhausted
    if (this.state.budgetTicks && this.state.totalTicks >= this.state.budgetTicks) {
      log(`[autoemon] Budget exhausted (${this.state.totalTicks}/${this.state.budgetTicks} ticks) — wrapping up`);
      this.dispatchWrapUp('timer').catch(() => {}).finally(() => this.deactivate());
      return;
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

    // Build the tick context — brief snapshot + profile mood/focus
    const activeProfile = this.state.activeProfileId
      ? getProfile(this.daemon.corpRoot, this.state.activeProfileId)
      : null;

    const tickContext: TickContext = {
      pendingTasks: this.countAgentPendingTasks(agentId),
      unreadInbox: this.countAgentUnreadInbox(agentId),
      lastAction: undefined,
      mood: activeProfile?.mood,
      focus: activeProfile?.focus,
      profileLabel: activeProfile ? `${activeProfile.icon} ${activeProfile.name}` : undefined,
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
    const sessionKey = `jack:${agentSlug}`;
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

  /**
   * Get the founder's current presence based on TUI connection + activity.
   * - watching: TUI connected AND founder interacted within 10 minutes
   * - idle: TUI connected BUT no interaction for 10+ minutes
   * - away: TUI disconnected (no WebSocket clients)
   */
  private getFounderPresence(): FounderPresence {
    const IDLE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

    // Check if TUI is connected (any WebSocket clients on the EventBus)
    const tuiConnected = this.daemon.events.getClientCount() > 0;
    if (!tuiConnected) return 'away';

    // TUI is connected — check last interaction time
    const lastInteraction = this.daemon.lastFounderInteractionAt;
    const sinceLast = Date.now() - lastInteraction;

    if (lastInteraction === 0 || sinceLast > IDLE_THRESHOLD_MS) {
      return 'idle'; // TUI open but founder hasn't typed in 10+ min
    }

    return 'watching'; // TUI open and founder is active
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

  // ── Founder Away (Auto-AFK) ───────────────────────────────────────

  /** Idle threshold for auto-AFK: 30 minutes */
  private static AUTO_AFK_IDLE_MS = 30 * 60 * 1000;

  /**
   * Start the Founder Away checker — a clock that runs every 2 minutes
   * even when autoemon is inactive. Checks if auto-AFK should trigger.
   */
  startFounderAwayChecker(): void {
    // Check if auto-AFK flag is enabled OR a schedule is set
    const hasSchedule = !!this.state.schedule;
    let hasAutoAfk = false;
    try {
      const corp = readConfig<Corporation>(join(this.daemon.corpRoot, CORP_JSON));
      hasAutoAfk = !!corp.dangerouslyEnableAutoAfk;
    } catch {}

    if (!hasAutoAfk && !hasSchedule) return;

    this.daemon.clocks.register({
      id: 'founder-away-check',
      name: 'Founder Away',
      type: 'system',
      intervalMs: 2 * 60 * 1000, // Check every 2 minutes
      target: 'founder',
      description: 'Auto-activates SLUMBER (Guard Duty) when founder idle 30m+ (dangerously enabled)',
      callback: () => this.checkFounderAway(),
    });
    log(`[autoemon] Founder Away checker started (dangerouslyEnableAutoAfk is ON)`);
  }

  /**
   * Check if the founder has been idle long enough to auto-activate SLUMBER.
   * Only fires if: flag enabled + autoemon inactive + founder idle 30m+.
   */
  private async checkFounderAway(): Promise<void> {
    // Check scheduled SLUMBER activation (time-based, independent of idle)
    this.checkScheduledActivation();

    // Don't auto-activate if already active
    if (this.state.globalState !== 'inactive') return;

    // Re-check the flag (might have been disabled)
    try {
      const corp = readConfig<Corporation>(join(this.daemon.corpRoot, CORP_JSON));
      if (!corp.dangerouslyEnableAutoAfk) return;
    } catch { return; }

    // Check founder presence
    const presence = this.getFounderPresence();
    if (presence !== 'away') {
      // Also check idle duration explicitly (presence 'idle' = 10min, we need 30min)
      const idleMs = Date.now() - this.daemon.lastFounderInteractionAt;
      if (this.daemon.lastFounderInteractionAt === 0 || idleMs < AutoemonManager.AUTO_AFK_IDLE_MS) return;
    }

    // Auto-activate with Guard Duty profile (safest)
    log(`[autoemon] Founder idle 30m+ — auto-activating SLUMBER (Guard Duty)`);
    this.activate('afk', undefined, 'guard');
    this.conscript();
    this.startTickLoop();

    // Notify CEO via DM
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
      if (ceo) {
        const ceoSlug = ceo.displayName.toLowerCase().replace(/\s+/g, '-');
        const channels = readConfig<any[]>(join(this.daemon.corpRoot, 'channels.json'));
        const ceoDm = channels.find((c: any) => c.kind === 'direct' && c.name.includes('ceo'));

        await fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: ceoSlug,
            message: [
              '[AUTO-AFK] Founder has been idle for 30+ minutes.',
              'SLUMBER activated automatically with Guard Duty profile.',
              'You are in watchman mode — monitor for problems only.',
              'The Founder can type /wake to resume control at any time.',
            ].join('\n'),
            sessionKey: `jack:${ceoSlug}`,
            channelId: ceoDm?.id,
          }),
        });
        log(`[autoemon] CEO notified of auto-AFK activation`);
      }
    } catch (err) {
      logError(`[autoemon] Failed to notify CEO of auto-AFK: ${err}`);
    }
  }

  // ── SLUMBER Schedule ──────────────────────────────────────────────

  /**
   * Set a recurring SLUMBER schedule from a profile.
   * Stores in autoemon-state.json. The Founder Away checker
   * also checks this schedule on every 2-minute cycle.
   */
  setSchedule(profileId: string): { ok: boolean; error?: string; schedule?: string; durationLabel?: string; profileName?: string; icon?: string; profileId?: string } {
    const profile = getProfile(this.daemon.corpRoot, profileId);
    if (!profile) return { ok: false, error: `Profile "${profileId}" not found` };
    if (!profile.schedule) return { ok: false, error: `Profile "${profile.name}" has no schedule` };

    // Parse schedule "10pm-6am" or "8am-3pm weekdays"
    const match = profile.schedule.match(/(\d{1,2})(am|pm)-(\d{1,2})(am|pm)/i);
    if (!match) return { ok: false, error: `Cannot parse schedule "${profile.schedule}"` };

    let startHour = parseInt(match[1]!);
    if (match[2]!.toLowerCase() === 'pm' && startHour !== 12) startHour += 12;
    if (match[2]!.toLowerCase() === 'am' && startHour === 12) startHour = 0;

    let endHour = parseInt(match[3]!);
    if (match[4]!.toLowerCase() === 'pm' && endHour !== 12) endHour += 12;
    if (match[4]!.toLowerCase() === 'am' && endHour === 12) endHour = 0;

    let durationHours = endHour - startHour;
    if (durationHours <= 0) durationHours += 24;
    const weekdaysOnly = profile.schedule.toLowerCase().includes('weekday');

    // Store schedule in state
    this.state.schedule = {
      profileId,
      startHour,
      endHour,
      durationMs: durationHours * 3_600_000,
      weekdaysOnly,
      raw: profile.schedule,
    };
    this.persist();

    log(`[autoemon] Schedule set: ${profile.name} (${profile.schedule})`);
    return {
      ok: true,
      schedule: profile.schedule,
      durationLabel: `${durationHours}h`,
      profileName: profile.name,
      icon: profile.icon,
      profileId,
    };
  }

  /** Clear all SLUMBER schedules. */
  clearSchedule(): void {
    this.state.schedule = null;
    this.persist();
    log(`[autoemon] Schedule cleared`);
  }

  /**
   * Check if current time is within a scheduled SLUMBER window.
   * Called from the Founder Away checker every 2 minutes.
   */
  private checkScheduledActivation(): void {
    const schedule = this.state.schedule;
    if (!schedule) return;
    if (this.state.globalState !== 'inactive') return; // Already active

    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay(); // 0=Sun, 6=Sat

    // Weekday check
    if (schedule.weekdaysOnly && (currentDay === 0 || currentDay === 6)) return;

    // Window check — handle overnight wrap (22-6 means 22,23,0,1,2,3,4,5)
    let inWindow: boolean;
    if (schedule.startHour < schedule.endHour) {
      // Normal window: 8am-3pm
      inWindow = currentHour >= schedule.startHour && currentHour < schedule.endHour;
    } else {
      // Overnight: 10pm-6am
      inWindow = currentHour >= schedule.startHour || currentHour < schedule.endHour;
    }

    if (!inWindow) return;

    // In window — activate!
    log(`[autoemon] Scheduled activation: ${schedule.profileId} (${schedule.raw})`);
    this.activate('slumber', schedule.durationMs, schedule.profileId);
    this.conscript();
    this.startTickLoop();

    // Notify CEO
    const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    const ceo = members.find(m => m.rank === 'master' && m.type === 'agent');
    if (ceo) {
      const ceoSlug = ceo.displayName.toLowerCase().replace(/\s+/g, '-');
      fetch(`http://127.0.0.1:${this.daemon.getPort()}/cc/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: ceoSlug,
          message: `[SCHEDULED SLUMBER] Profile: ${schedule.profileId}. Window: ${schedule.raw}. You have autonomous control.`,
          sessionKey: `jack:${ceoSlug}`,
        }),
      }).catch(() => {});
    }
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
   * Rehydrate the duration timer after daemon restart.
   * Checks persisted endsAt — if still in the future, starts a timer
   * for the remaining time. If expired, triggers immediate wrap-up.
   */
  rehydrateDurationTimer(): void {
    if (!this.state.endsAt) return; // No duration set (indefinite SLUMBER)

    const now = Date.now();
    const remaining = this.state.endsAt - now;

    if (remaining <= 0) {
      // SLUMBER should have ended while daemon was down
      log(`[autoemon] SLUMBER expired while daemon was down — wrapping up now`);
      this.dispatchWrapUp('timer').catch(() => {}).finally(() => this.deactivate());
    } else {
      // Restart timer for remaining duration
      log(`[autoemon] Rehydrating duration timer: ${Math.round(remaining / 60_000)}m remaining`);
      this.startDurationTimer(remaining);
    }
  }

  /**
   * Dispatch a wrap-up prompt to the CEO. The CEO's response IS the wake digest.
   * Called on: duration expiry, /wake command, manual deactivation.
   */
  async dispatchWrapUp(reason: 'timer' | 'wake_command' | 'manual', channelId?: string): Promise<string> {
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

    // Build per-agent tick summaries from state
    const agentSummaries = Object.entries(this.state.agents).map(([id, s]) => {
      const pct = s.tickCount > 0 ? Math.round((s.productiveTickCount / s.tickCount) * 100) : 0;
      return `  ${id}: ${s.tickCount} ticks, ${s.productiveTickCount} productive (${pct}%), ${s.consecutiveIdleTicks} idle streak, ${s.consecutiveErrors} errors`;
    }).join('\n');

    // Read recent telemetry for concrete action details
    let recentActions = '';
    try {
      const telPath = join(this.daemon.corpRoot, TELEMETRY_FILE);
      if (existsSync(telPath)) {
        const lines = readFileSync(telPath, 'utf-8').trim().split('\n').filter(Boolean);
        // Get last 20 entries
        const recent = lines.slice(-20).map(l => {
          try {
            const e = JSON.parse(l);
            return `  ${e.timestamp?.slice(11, 19)} [${e.action}] ${(e.details ?? '').slice(0, 120)}`;
          } catch { return null; }
        }).filter(Boolean);
        if (recent.length > 0) recentActions = `\nRecent tick log:\n${recent.join('\n')}`;
      }
    } catch {}

    const prompt = [
      `SLUMBER is ending. ${reasonLabel}`,
      ``,
      `Session stats: ${elapsedLabel} elapsed, ${this.state.totalTicks} ticks fired, ${this.state.totalProductiveTicks} productive.`,
      `Enrolled agents: ${[...this.enrolled].join(', ') || 'none'}.`,
      ``,
      `Per-agent breakdown:`,
      agentSummaries,
      recentActions,
      ``,
      `Read your observation log (observations/) and WORKLOG.md for what you did.`,
      `Then summarize for the Founder:`,
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
          sessionKey: `jack:${agentSlug}`,
          channelId: channelId ?? undefined,
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

  /**
   * Get SLUMBER progress info for the moon phase status bar.
   * - Duration SLUMBER: fraction based on elapsed/total (0→1)
   * - Indefinite SLUMBER: fraction cycles based on tick count (one full cycle = 16 ticks)
   */
  getProgress(): { elapsed: number; total: number | null; fraction: number; endsAt: number | null; totalTicks: number } {
    const now = Date.now();
    const elapsed = this.state.activatedAt ? now - this.state.activatedAt : 0;
    const total = this.state.durationMs;

    let fraction: number;
    if (total) {
      // Duration mode: linear progress 0→1
      fraction = Math.min(1, elapsed / total);
    } else {
      // Indefinite mode: moon cycles every 16 ticks (one full lunar cycle)
      const cycleTicks = 16;
      fraction = (this.state.totalTicks % cycleTicks) / cycleTicks;
    }

    return { elapsed, total, fraction, endsAt: this.state.endsAt, totalTicks: this.state.totalTicks };
  }
}
