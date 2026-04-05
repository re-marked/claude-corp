/**
 * Post — the unified message persistence primitive.
 *
 * Every message written to a channel JSONL goes through post().
 * It enforces:
 *   1. Mandatory senderId (no guessing, no defaults)
 *   2. Mandatory source tag (who initiated the write)
 *   3. Automatic field generation (id, originId, timestamp, depth)
 *   4. Deduplication (same sender + content within 5s → skip)
 *   5. Consistent metadata structure
 *
 * This replaces direct appendMessage() calls for channel writes.
 * appendMessage() still exists for non-channel writes (inbox.jsonl, etc).
 */

import { appendMessage } from './parsers/jsonl.js';
import { generateId } from './id.js';
import type { ChannelMessage } from './types/message.js';

// ── Types ──────────────────────────────────────────────────────────

export type PostSource =
  | 'router'    // Router dispatch (agent responding to @mention or DM)
  | 'jack'      // Jack/say endpoint (persistent session dispatch)
  | 'user'      // Founder typing in TUI or cc-cli send
  | 'system'    // System-generated (onboarding, status, errors)
  | 'cron'      // Cron job output
  | 'loop'      // Loop output
  | 'standup'   // Morning standup
  | 'task'      // Task events (assignments, completions)
  | 'hire'      // Agent hiring announcements
  | 'warden';   // Warden review results

export type PostKind = 'text' | 'system' | 'tool_event' | 'task_event';

export interface PostOpts {
  /** Who sent this message — MANDATORY, never optional */
  senderId: string;
  /** Message content */
  content: string;
  /** Who initiated this write */
  source: PostSource;
  /** Message kind (default: 'text') */
  kind?: PostKind;
  /** Thread ID (for threaded replies) */
  threadId?: string | null;
  /** Reply depth (default: 0) */
  depth?: number;
  /** Origin message ID (for threading, default: self) */
  originId?: string;
  /** @mentioned member IDs */
  mentions?: string[];
  /** Additional metadata (merged with source) */
  metadata?: Record<string, unknown>;
  /** Whether SLUMBER is active (auto-tagged if true) */
  slumber?: boolean;
}

// ── Dedup ──────────────────────────────────────────────────────────

/** Rolling dedup window: sender+contentHash → timestamp */
const recentPosts = new Map<string, number>();
const DEDUP_WINDOW_MS = 5_000; // 5 seconds

/** Clean stale dedup entries (called periodically). */
function cleanDedup(): void {
  const cutoff = Date.now() - DEDUP_WINDOW_MS * 2;
  for (const [key, ts] of recentPosts) {
    if (ts < cutoff) recentPosts.delete(key);
  }
}

/** Simple hash for dedup key. */
function dedupKey(senderId: string, content: string): string {
  // Use first 100 chars of content to avoid hashing huge messages
  return `${senderId}:${content.slice(0, 100)}`;
}

// Clean dedup every 30 seconds
setInterval(cleanDedup, 30_000);

// ── Post ───────────────────────────────────────────────────────────

/**
 * Post a message to a channel JSONL file.
 *
 * Returns the written message, or null if deduped (skipped).
 * Throws if senderId is missing.
 */
export function post(
  channelId: string,
  msgPath: string,
  opts: PostOpts,
): ChannelMessage | null {
  // Validate mandatory fields
  if (!opts.senderId) {
    throw new Error(`[post] senderId is MANDATORY. Source: ${opts.source}, content: "${opts.content.slice(0, 60)}"`);
  }
  if (!opts.content && opts.kind !== 'system') {
    throw new Error(`[post] content is empty. Source: ${opts.source}, sender: ${opts.senderId}`);
  }

  // Dedup check — same sender + same content within 5s → skip
  const key = dedupKey(opts.senderId, opts.content);
  const lastPost = recentPosts.get(key);
  if (lastPost && (Date.now() - lastPost) < DEDUP_WINDOW_MS) {
    return null; // Silently deduped
  }

  // Build the message
  const id = generateId();
  const msg: ChannelMessage = {
    id,
    channelId,
    senderId: opts.senderId,
    threadId: opts.threadId ?? null,
    content: opts.content,
    kind: opts.kind ?? 'text',
    mentions: opts.mentions ?? [],
    metadata: {
      source: opts.source,
      ...(opts.slumber ? { slumber: true } : {}),
      ...opts.metadata,
    },
    depth: opts.depth ?? 0,
    originId: opts.originId ?? id,
    timestamp: new Date().toISOString(),
  };

  // Write to JSONL
  appendMessage(msgPath, msg);

  // Record for dedup
  recentPosts.set(key, Date.now());

  return msg;
}
