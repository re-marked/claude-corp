import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

const ANALYTICS_FILE = 'analytics.json';
const PERSIST_INTERVAL_MS = 60_000; // Persist every 60 seconds

export interface CorpAnalytics {
  /** When analytics tracking started */
  startedAt: number;
  /** Total tasks created since tracking began */
  tasksCreated: number;
  /** Total tasks completed */
  tasksCompleted: number;
  /** Total tasks failed */
  tasksFailed: number;
  /** Total messages across all channels */
  messagesTotal: number;
  /** Total dispatches (agent invocations) */
  dispatchesTotal: number;
  /** Total errors (dispatch failures, clock errors) */
  errorsTotal: number;
  /** Per-agent metrics */
  agents: Record<string, AgentMetrics>;
  /** Last persisted timestamp */
  savedAt: number;
}

export interface AgentMetrics {
  name: string;
  tasksCompleted: number;
  tasksFailed: number;
  dispatchCount: number;
  errorCount: number;
  /** Total ms spent busy (cumulative across all sessions) */
  busyTimeMs: number;
  /** Total ms spent idle */
  idleTimeMs: number;
  /** Timestamp when current status started */
  statusSince: number;
  /** Current consecutive successful dispatches */
  streak: number;
  /** Best streak ever */
  bestStreak: number;
}

/**
 * Corp Analytics Engine — continuous metrics tracking.
 * Tracks task throughput, agent utilization, dispatch counts,
 * error rates, and streaks. Persists to analytics.json.
 */
export class AnalyticsEngine {
  private data: CorpAnalytics;
  private daemon: Daemon;
  private persistInterval: ReturnType<typeof setInterval> | null = null;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
    this.data = this.loadOrCreate();
  }

  /** Start periodic persistence. */
  start(): void {
    this.persistInterval = setInterval(() => this.persist(), PERSIST_INTERVAL_MS);
    log(`[analytics] Started (persisting every ${PERSIST_INTERVAL_MS / 1000}s)`);
  }

  /** Stop persistence + flush. */
  stop(): void {
    if (this.persistInterval) clearInterval(this.persistInterval);
    this.persist();
  }

  // --- Event Tracking ---

  trackTaskCreated(): void {
    this.data.tasksCreated++;
  }

  trackTaskCompleted(agentId: string): void {
    this.data.tasksCompleted++;
    const agent = this.ensureAgent(agentId);
    agent.tasksCompleted++;
    agent.streak++;
    if (agent.streak > agent.bestStreak) agent.bestStreak = agent.streak;
  }

  trackTaskFailed(agentId: string): void {
    this.data.tasksFailed++;
    const agent = this.ensureAgent(agentId);
    agent.tasksFailed++;
    agent.streak = 0; // Reset streak on failure
  }

  trackDispatch(agentId: string): void {
    this.data.dispatchesTotal++;
    const agent = this.ensureAgent(agentId);
    agent.dispatchCount++;
  }

  trackError(agentId?: string): void {
    this.data.errorsTotal++;
    if (agentId) {
      const agent = this.ensureAgent(agentId);
      agent.errorCount++;
      agent.streak = 0;
    }
  }

  trackMessage(): void {
    this.data.messagesTotal++;
  }

  trackStatusChange(agentId: string, agentName: string, newStatus: string): void {
    const agent = this.ensureAgent(agentId, agentName);
    const now = Date.now();
    const elapsed = now - agent.statusSince;

    // Accumulate time in previous status
    if (elapsed > 0 && agent.statusSince > 0) {
      // We track what status they WERE in based on whether we're transitioning to/from busy
      if (newStatus === 'busy') {
        agent.idleTimeMs += elapsed; // Was idle, now busy
      } else if (newStatus === 'idle') {
        agent.busyTimeMs += elapsed; // Was busy, now idle
      }
    }

    agent.statusSince = now;
  }

  // --- Queries ---

  /** Get full analytics snapshot. */
  getSnapshot(): CorpAnalytics {
    return { ...this.data, savedAt: Date.now() };
  }

  /** Get agent utilization (busy time ratio). */
  getUtilization(agentId: string): number {
    const agent = this.data.agents[agentId];
    if (!agent) return 0;
    const total = agent.busyTimeMs + agent.idleTimeMs;
    if (total === 0) return 0;
    return agent.busyTimeMs / total;
  }

  /** Get corp-wide stats for cc-cli stats. */
  getCorpStats(): {
    uptime: number;
    tasksCreated: number;
    tasksCompleted: number;
    tasksFailed: number;
    messagesTotal: number;
    dispatchesTotal: number;
    errorsTotal: number;
    agentCount: number;
    topAgent: { name: string; completed: number; streak: number } | null;
  } {
    const agents = Object.values(this.data.agents);
    const topAgent = agents.length > 0
      ? agents.reduce((best, a) => a.tasksCompleted > best.tasksCompleted ? a : best)
      : null;

    return {
      uptime: Date.now() - this.data.startedAt,
      tasksCreated: this.data.tasksCreated,
      tasksCompleted: this.data.tasksCompleted,
      tasksFailed: this.data.tasksFailed,
      messagesTotal: this.data.messagesTotal,
      dispatchesTotal: this.data.dispatchesTotal,
      errorsTotal: this.data.errorsTotal,
      agentCount: agents.length,
      topAgent: topAgent ? { name: topAgent.name, completed: topAgent.tasksCompleted, streak: topAgent.bestStreak } : null,
    };
  }

  // --- Persistence ---

  private loadOrCreate(): CorpAnalytics {
    const filePath = join(this.daemon.corpRoot, ANALYTICS_FILE);
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
        log(`[analytics] Restored from ${ANALYTICS_FILE}`);
        return raw as CorpAnalytics;
      } catch {}
    }

    return {
      startedAt: Date.now(),
      tasksCreated: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      messagesTotal: 0,
      dispatchesTotal: 0,
      errorsTotal: 0,
      agents: {},
      savedAt: Date.now(),
    };
  }

  private persist(): void {
    try {
      this.data.savedAt = Date.now();
      writeFileSync(
        join(this.daemon.corpRoot, ANALYTICS_FILE),
        JSON.stringify(this.data, null, 2),
        'utf-8',
      );
    } catch (err) {
      logError(`[analytics] Persist failed: ${err}`);
    }
  }

  private ensureAgent(agentId: string, name?: string): AgentMetrics {
    if (!this.data.agents[agentId]) {
      this.data.agents[agentId] = {
        name: name ?? agentId,
        tasksCompleted: 0,
        tasksFailed: 0,
        dispatchCount: 0,
        errorCount: 0,
        busyTimeMs: 0,
        idleTimeMs: 0,
        statusSince: Date.now(),
        streak: 0,
        bestStreak: 0,
      };
    }
    return this.data.agents[agentId]!;
  }
}
