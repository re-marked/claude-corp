/**
 * Dispatch Resilience — error categorization, exponential backoff,
 * context blocking, and per-agent health scoring.
 *
 * Borrowed from Claude Code's error handling patterns:
 * - REPL.tsx:2634-2639 — context blocking on API errors
 * - BashTool.tsx:973-983 — blocking budget
 * - General error recovery patterns across the codebase
 *
 * This module wraps the raw dispatch functions with resilience logic.
 * The daemon integrates this into its dispatch pipeline.
 */

import { log, logError } from './logger.js';

// ── Error Categories ───────────────────────────────────────────────

/**
 * Error categories with specific recovery strategies.
 * Each category maps to a different response: retry, backoff, block, fallback.
 */
export type ErrorCategory =
  | 'rate_limit'       // 429 — exponential backoff, will recover
  | 'auth'             // 401/403 — block all dispatches, needs human intervention
  | 'timeout'          // Request timed out — retry once with longer timeout
  | 'context_overflow' // Context too long — trigger compaction, retry
  | 'model_unavailable'// Model not accessible — try fallback model
  | 'overloaded'       // 529/503 — server busy, backoff
  | 'network'          // Connection refused/reset — gateway might be down
  | 'unknown';         // Uncategorized — log and retry once

/**
 * Classify a dispatch error into a category for targeted recovery.
 * Uses error message, HTTP status, and known patterns.
 */
export function categorizeError(error: unknown): ErrorCategory {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  // Rate limit patterns
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) {
    return 'rate_limit';
  }

  // Auth patterns
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return 'auth';
  }

  // Timeout patterns
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
    return 'timeout';
  }

  // Context overflow
  if (msg.includes('context') && (msg.includes('too long') || msg.includes('overflow') || msg.includes('exceeded'))) {
    return 'context_overflow';
  }

  // Model unavailable
  if (msg.includes('model') && (msg.includes('unavailable') || msg.includes('not found') || msg.includes('not accessible'))) {
    return 'model_unavailable';
  }

  // Overloaded / server busy
  if (msg.includes('overloaded') || msg.includes('529') || msg.includes('503') || msg.includes('service unavailable')) {
    return 'overloaded';
  }

  // Network errors
  if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('fetch failed') || msg.includes('unreachable')) {
    return 'network';
  }

  return 'unknown';
}

/** Human-readable description for each error category. */
export function categoryDescription(cat: ErrorCategory): string {
  switch (cat) {
    case 'rate_limit': return 'API rate limit hit — backing off';
    case 'auth': return 'Authentication failed — check API key';
    case 'timeout': return 'Request timed out — will retry';
    case 'context_overflow': return 'Context too long — needs compaction';
    case 'model_unavailable': return 'Model not accessible — trying fallback';
    case 'overloaded': return 'Server overloaded — backing off';
    case 'network': return 'Network error — gateway may be down';
    case 'unknown': return 'Unknown error — will retry';
  }
}

// ── Exponential Backoff ────────────────────────────────────────────

/** Backoff configuration per error category. */
const BACKOFF_CONFIG: Record<ErrorCategory, { baseMs: number; maxMs: number; factor: number }> = {
  rate_limit:       { baseMs: 5_000,  maxMs: 300_000, factor: 3 },   // 5s → 15s → 45s → 2m → 5m max
  auth:             { baseMs: 0,      maxMs: 0,       factor: 0 },   // No retry — block
  timeout:          { baseMs: 3_000,  maxMs: 30_000,  factor: 2 },   // 3s → 6s → 12s → 24s → 30s max
  context_overflow: { baseMs: 1_000,  maxMs: 10_000,  factor: 2 },   // 1s → 2s → 4s → 8s → 10s max
  model_unavailable:{ baseMs: 5_000,  maxMs: 60_000,  factor: 2 },   // 5s → 10s → 20s → 40s → 60s max
  overloaded:       { baseMs: 10_000, maxMs: 300_000, factor: 3 },   // 10s → 30s → 90s → 5m max
  network:          { baseMs: 2_000,  maxMs: 60_000,  factor: 2 },   // 2s → 4s → 8s → 16s → 32s → 60s max
  unknown:          { baseMs: 3_000,  maxMs: 30_000,  factor: 2 },   // 3s → 6s → 12s → 24s → 30s max
};

/** Calculate the backoff delay for a given error category and attempt number. */
export function getBackoffMs(category: ErrorCategory, attempt: number): number {
  const config = BACKOFF_CONFIG[category];
  if (config.maxMs === 0) return 0; // No retry (auth)
  const delay = config.baseMs * Math.pow(config.factor, attempt);
  return Math.min(delay, config.maxMs);
}

/** Check if an error category allows retries. */
export function isRetryable(category: ErrorCategory): boolean {
  return BACKOFF_CONFIG[category].maxMs > 0;
}

/** Get the max number of useful retries for a category (before hitting maxMs ceiling). */
export function maxRetries(category: ErrorCategory): number {
  const config = BACKOFF_CONFIG[category];
  if (config.maxMs === 0) return 0;
  // How many attempts before we hit maxMs
  let attempts = 0;
  let delay = config.baseMs;
  while (delay < config.maxMs && attempts < 10) {
    delay *= config.factor;
    attempts++;
  }
  return attempts;
}

// ── Context Blocking ───────────────────────────────────────────────

/**
 * Context blocking state machine.
 * When blocked, all dispatches are paused. Prevents error → dispatch → error loops.
 *
 * Adapted from Claude Code's REPL.tsx:2634-2639:
 *   API error → setContextBlocked(true) → stop all ticks
 *   Successful response → setContextBlocked(false) → resume
 */
export class ContextBlocker {
  private blocked = false;
  private blockReason: ErrorCategory | null = null;
  private blockedAt: number | null = null;
  private blockCount = 0;
  /** Categories that auto-block all dispatches (not just the failing agent). */
  private static BLOCKING_CATEGORIES: Set<ErrorCategory> = new Set(['auth', 'rate_limit', 'overloaded']);

  /** Should this error category trigger a global context block? */
  static shouldBlock(category: ErrorCategory): boolean {
    return ContextBlocker.BLOCKING_CATEGORIES.has(category);
  }

  /** Is the context currently blocked? */
  isBlocked(): boolean {
    return this.blocked;
  }

  /** Get the reason for the current block. */
  getBlockReason(): ErrorCategory | null {
    return this.blockReason;
  }

  /** How long has the context been blocked (ms)? 0 if not blocked. */
  getBlockDuration(): number {
    if (!this.blockedAt) return 0;
    return Date.now() - this.blockedAt;
  }

  /** Get blocking status info for display. */
  getStatus(): { blocked: boolean; reason: ErrorCategory | null; blockedAt: number | null; blockCount: number; durationMs: number } {
    return {
      blocked: this.blocked,
      reason: this.blockReason,
      blockedAt: this.blockedAt,
      blockCount: this.blockCount,
      durationMs: this.getBlockDuration(),
    };
  }

  /**
   * Block the context — all dispatches should pause.
   * Called when a dispatch returns a blocking error (auth, rate limit).
   */
  block(reason: ErrorCategory): void {
    if (this.blocked && this.blockReason === reason) return; // Already blocked for same reason
    this.blocked = true;
    this.blockReason = reason;
    this.blockedAt = Date.now();
    this.blockCount++;
    log(`[resilience] Context BLOCKED (${reason}): ${categoryDescription(reason)}. Block #${this.blockCount}`);
  }

  /**
   * Unblock the context — dispatches can resume.
   * Called on: successful dispatch, compaction boundary, manual /clear.
   */
  unblock(): void {
    if (!this.blocked) return;
    const duration = this.blockedAt ? Math.round((Date.now() - this.blockedAt) / 1000) : 0;
    log(`[resilience] Context UNBLOCKED after ${duration}s (was: ${this.blockReason})`);
    this.blocked = false;
    this.blockReason = null;
    this.blockedAt = null;
  }

  /** Reset on manual clear or daemon restart. */
  reset(): void {
    this.blocked = false;
    this.blockReason = null;
    this.blockedAt = null;
  }
}

// ── Dispatch Health Score ──────────────────────────────────────────

/**
 * Per-agent rolling health score.
 * Tracks the last N dispatch results (success/failure) and computes a health ratio.
 *
 * Score interpretation:
 *   1.0 = all recent dispatches succeeded (perfect health)
 *   0.5 = half succeeded (degraded — logged as warning)
 *   0.0 = all failed (critical — agent should be paused)
 *
 * The rolling window means old failures "fall off" as new successes come in.
 * An agent that had 5 failures but then 10 successes recovers naturally.
 */
export class DispatchHealthTracker {
  /** Rolling window of recent dispatch results per agent (true = success) */
  private windows = new Map<string, boolean[]>();
  /** Timestamp of last failure per agent (for "last failed X ago" display) */
  private lastFailureAt = new Map<string, number>();
  /** Last error category per agent */
  private lastErrorCategory = new Map<string, ErrorCategory>();
  /** Window size — how many recent dispatches to track */
  private windowSize: number;
  /** Score below which an agent is "degraded" */
  private degradedThreshold: number;
  /** Score below which an agent is "critical" and gets auto-paused */
  private criticalThreshold: number;

  constructor(opts?: {
    windowSize?: number;
    degradedThreshold?: number;
    criticalThreshold?: number;
  }) {
    this.windowSize = opts?.windowSize ?? 10;
    this.degradedThreshold = opts?.degradedThreshold ?? 0.5;
    this.criticalThreshold = opts?.criticalThreshold ?? 0.2;
  }

  /** Record a successful dispatch. */
  recordSuccess(agentId: string): void {
    this.push(agentId, true);
  }

  /** Record a failed dispatch with error context. */
  recordFailure(agentId: string, error: unknown): void {
    this.push(agentId, false);
    const cat = categorizeError(error);
    this.lastFailureAt.set(agentId, Date.now());
    this.lastErrorCategory.set(agentId, cat);

    const score = this.getScore(agentId);
    if (score <= this.criticalThreshold) {
      logError(`[health] ${agentId} CRITICAL (${(score * 100).toFixed(0)}%) — ${categoryDescription(cat)}`);
    } else if (score <= this.degradedThreshold) {
      log(`[health] ${agentId} DEGRADED (${(score * 100).toFixed(0)}%) — ${categoryDescription(cat)}`);
    }
  }

  /** Get the health score for an agent (0.0 to 1.0). */
  getScore(agentId: string): number {
    const window = this.windows.get(agentId);
    if (!window || window.length === 0) return 1.0; // No data = healthy
    const successes = window.filter(Boolean).length;
    return successes / window.length;
  }

  /** Get health status label for display. */
  getStatus(agentId: string): 'healthy' | 'degraded' | 'critical' {
    const score = this.getScore(agentId);
    if (score <= this.criticalThreshold) return 'critical';
    if (score <= this.degradedThreshold) return 'degraded';
    return 'healthy';
  }

  /** Is this agent healthy enough to receive dispatches? */
  isHealthy(agentId: string): boolean {
    return this.getScore(agentId) > this.criticalThreshold;
  }

  /** Get detailed health info for a specific agent. */
  getAgentHealth(agentId: string): {
    score: number;
    status: 'healthy' | 'degraded' | 'critical';
    recentResults: boolean[];
    lastFailureAt: number | null;
    lastErrorCategory: ErrorCategory | null;
  } {
    return {
      score: this.getScore(agentId),
      status: this.getStatus(agentId),
      recentResults: [...(this.windows.get(agentId) ?? [])],
      lastFailureAt: this.lastFailureAt.get(agentId) ?? null,
      lastErrorCategory: this.lastErrorCategory.get(agentId) ?? null,
    };
  }

  /** Get all agents and their health scores (for dashboard). */
  getAllScores(): Map<string, { score: number; status: 'healthy' | 'degraded' | 'critical' }> {
    const result = new Map<string, { score: number; status: 'healthy' | 'degraded' | 'critical' }>();
    for (const [agentId] of this.windows) {
      result.set(agentId, {
        score: this.getScore(agentId),
        status: this.getStatus(agentId),
      });
    }
    return result;
  }

  /** Reset health tracking for an agent (on restart, re-hire, etc). */
  resetAgent(agentId: string): void {
    this.windows.delete(agentId);
    this.lastFailureAt.delete(agentId);
    this.lastErrorCategory.delete(agentId);
  }

  private push(agentId: string, success: boolean): void {
    let window = this.windows.get(agentId);
    if (!window) {
      window = [];
      this.windows.set(agentId, window);
    }
    window.push(success);
    if (window.length > this.windowSize) {
      window.shift();
    }
  }
}

// ── Graduated Unblocking ───────────────────────────────────────────

/**
 * After context is unblocked, dispatches run at reduced frequency
 * for a grace period. Prevents immediately re-hitting the rate limit.
 *
 * The first N dispatches after unblock fire at 2x normal interval.
 * Once all N succeed, full speed is restored.
 * If any fail during grace → re-block.
 *
 * Adapted from Claude Code's cautious resume pattern.
 */
export class GraduatedUnblocker {
  /** Timestamp when unblocking happened */
  private unblockedAt: number | null = null;
  /** Number of successful dispatches since unblock */
  private successesSinceUnblock = 0;
  /** How many successful dispatches before returning to full speed */
  private graceDispatches: number;

  constructor(graceDispatches = 3) {
    this.graceDispatches = graceDispatches;
  }

  /** Call when context is unblocked — start the grace period. */
  startGrace(): void {
    this.unblockedAt = Date.now();
    this.successesSinceUnblock = 0;
    log(`[resilience] Graduated unblock — next ${this.graceDispatches} dispatches at 2x interval`);
  }

  /** Record a successful dispatch during grace period. */
  recordSuccess(): void {
    if (this.unblockedAt === null) return;
    this.successesSinceUnblock++;
    if (this.successesSinceUnblock >= this.graceDispatches) {
      const duration = Math.round((Date.now() - this.unblockedAt) / 1000);
      log(`[resilience] Grace period complete (${duration}s) — full speed restored`);
      this.unblockedAt = null;
    }
  }

  /** Record a failure during grace — should re-block. Returns true if grace was active. */
  recordFailure(): boolean {
    if (this.unblockedAt === null) return false;
    log(`[resilience] Failure during grace period — should re-block`);
    this.unblockedAt = null;
    this.successesSinceUnblock = 0;
    return true; // Caller should re-block context
  }

  /** Is the graduated unblock grace period active? */
  isInGracePeriod(): boolean {
    return this.unblockedAt !== null;
  }

  /** Get the throttle multiplier (2x during grace, 1x normal). */
  getThrottleMultiplier(): number {
    return this.isInGracePeriod() ? 2 : 1;
  }

  /** Get grace period progress for display. */
  getProgress(): { active: boolean; completed: number; required: number } {
    return {
      active: this.isInGracePeriod(),
      completed: this.successesSinceUnblock,
      required: this.graceDispatches,
    };
  }

  /** Reset (on daemon restart). */
  reset(): void {
    this.unblockedAt = null;
    this.successesSinceUnblock = 0;
  }
}
