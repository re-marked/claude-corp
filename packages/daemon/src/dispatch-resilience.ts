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
