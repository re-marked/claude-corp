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
