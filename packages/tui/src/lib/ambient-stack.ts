/**
 * Ambient stack aggregator — groups consecutive same-kind ambient
 * turns into virtual "stacks" for collapsed badge rendering.
 *
 * One brain per agent (PR 2a) means every reasoning dispatch lands
 * in the main conversation, including scheduled/system work (crons,
 * heartbeats, dreams, autoemon ticks). To keep the main chat readable,
 * PR 2b collapses consecutive ambient turns of the same kind into a
 * single clickable stack badge:
 *
 *     ⏱ 5 heartbeats · ▃▅▇▅▃ · 12m
 *
 * Click → expand to a list of each turn. Click a turn → expand full
 * content. Wheel over stack → optional navigation (TBD in chat.tsx).
 *
 * This module is the pure grouping primitive. Takes an ordered message
 * list (oldest first), returns an ordered sequence of entries where
 * each entry is either a single regular message OR a virtual stack
 * wrapping N consecutive same-kind ambient turns.
 *
 * A "turn" is a group of messages sharing `metadata.turnId` (assistant
 * text blocks + their interleaved tool events). Every turn either is
 * or isn't ambient — all messages in the same turn inherit the same
 * `metadata.ambient` tag because api.ts stamps it uniformly across
 * the whole dispatch. Two consecutive ambient turns of the SAME kind
 * merge into one stack; a different kind (or a non-ambient turn) ends
 * the stack and starts a new entry.
 */

import type { ChannelMessage, AmbientKind } from '@claudecorp/shared';

// ── Types ───────────────────────────────────────────────────────────

export interface AmbientTurn {
  /** Shared turnId for every message in this turn. Synthetic if absent. */
  turnId: string;
  /** Oldest message in the turn (prompt / first assistant block). */
  firstMsg: ChannelMessage;
  /** Every message belonging to the turn, in order. */
  messages: ChannelMessage[];
  /** The turn's summary, copied from metadata.ambient.summary. */
  summary: string;
  /** ms since epoch of the FIRST message. */
  startMs: number;
  /** ms since epoch of the LAST message. */
  endMs: number;
}

export interface AmbientStack {
  kind: 'stack';
  /** Stable id: `<kind>:<firstTurnId>`. Safe React key. */
  id: string;
  ambientKind: AmbientKind;
  turns: AmbientTurn[];
  startMs: number;
  endMs: number;
}

export interface SingleMessage {
  kind: 'message';
  id: string;
  message: ChannelMessage;
}

export type AmbientEntry = AmbientStack | SingleMessage;

// ── Helpers ─────────────────────────────────────────────────────────

interface AmbientInfo {
  kind: AmbientKind;
  summary: string;
}

function readAmbient(msg: ChannelMessage): AmbientInfo | null {
  const meta = msg.metadata as Record<string, unknown> | null;
  if (!meta) return null;
  const raw = meta.ambient;
  if (!raw || typeof raw !== 'object') return null;
  const ambient = raw as { kind?: unknown; summary?: unknown };
  if (typeof ambient.kind !== 'string') return null;
  return {
    kind: ambient.kind as AmbientKind,
    summary: typeof ambient.summary === 'string' ? ambient.summary : String(ambient.kind),
  };
}

function readTurnId(msg: ChannelMessage): string {
  const meta = msg.metadata as Record<string, unknown> | null;
  const tid = meta?.turnId;
  return typeof tid === 'string' && tid.length > 0 ? tid : `solo:${msg.id}`;
}

// ── Aggregator ──────────────────────────────────────────────────────

/**
 * Walk the messages in order. For each turn (group sharing turnId),
 * decide: ambient (same kind as the open stack) → extend; ambient
 * (different kind) → flush stack, start new; non-ambient → flush and
 * emit as single messages.
 */
export function aggregateAmbient(messages: ReadonlyArray<ChannelMessage>): AmbientEntry[] {
  const entries: AmbientEntry[] = [];

  // Work list: first pass groups by turnId into per-turn buckets
  // preserving order. Non-ambient messages pass through as singletons.
  interface Bucket {
    turnId: string;
    msgs: ChannelMessage[];
    ambient: AmbientInfo | null;
  }
  const buckets: Bucket[] = [];
  let current: Bucket | null = null;
  for (const msg of messages) {
    const tid = readTurnId(msg);
    const amb = readAmbient(msg);
    if (current && current.turnId === tid) {
      current.msgs.push(msg);
      // First ambient wins for the turn; later messages just inherit.
      if (!current.ambient && amb) current.ambient = amb;
    } else {
      current = { turnId: tid, msgs: [msg], ambient: amb };
      buckets.push(current);
    }
  }

  // Second pass: merge consecutive same-kind ambient turns into stacks.
  let openStack: AmbientStack | null = null;

  const flushStack = () => {
    if (openStack) {
      entries.push(openStack);
      openStack = null;
    }
  };

  for (const b of buckets) {
    if (!b.ambient) {
      flushStack();
      // Non-ambient turns expand fully — each message is its own entry
      // (chat.tsx already handles tool_event grouping at render time).
      for (const m of b.msgs) {
        entries.push({ kind: 'message', id: m.id, message: m });
      }
      continue;
    }

    const turn: AmbientTurn = {
      turnId: b.turnId,
      firstMsg: b.msgs[0]!,
      messages: b.msgs,
      summary: b.ambient.summary,
      startMs: new Date(b.msgs[0]!.timestamp).getTime(),
      endMs: new Date(b.msgs[b.msgs.length - 1]!.timestamp).getTime(),
    };

    if (openStack && openStack.ambientKind === b.ambient.kind) {
      // Extend open stack.
      openStack.turns.push(turn);
      openStack.endMs = turn.endMs;
    } else {
      // Flush whatever was open, start fresh.
      flushStack();
      openStack = {
        kind: 'stack',
        id: `${b.ambient.kind}:${b.turnId}`,
        ambientKind: b.ambient.kind,
        turns: [turn],
        startMs: turn.startMs,
        endMs: turn.endMs,
      };
    }
  }
  flushStack();

  return entries;
}
