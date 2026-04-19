import { describe, it, expect } from 'vitest';
import { aggregateAmbient } from '../packages/tui/src/lib/ambient-stack.ts';
import type { ChannelMessage } from '@claudecorp/shared';

// The aggregator is the backbone of the collapsed-badge UX. Bugs here
// would either merge unrelated turns (fatal — agent's individual cron
// runs get silently collapsed) or fail to merge adjacent ambient runs
// of the same kind (defeats the purpose). Tests cover every transition.

let idCounter = 0;
function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `m-${++idCounter}`,
    channelId: 'c1',
    senderId: 's',
    threadId: null,
    content: 'hi',
    kind: 'text',
    mentions: [],
    metadata: null,
    depth: 0,
    originId: `m-${idCounter}`,
    timestamp: new Date(1700_000_000_000 + idCounter * 1000).toISOString(),
    ...overrides,
  };
}

function ambient(kind: string, summary: string, turnId: string): ChannelMessage {
  return msg({
    metadata: { turnId, ambient: { kind, summary } },
  });
}

function regular(turnId: string): ChannelMessage {
  return msg({ metadata: { turnId } });
}

describe('aggregateAmbient', () => {
  it('empty input → empty output', () => {
    expect(aggregateAmbient([])).toEqual([]);
  });

  it('single non-ambient message passes through as singleton', () => {
    const m = msg();
    const out = aggregateAmbient([m]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'message', id: m.id });
  });

  it('single ambient turn becomes a stack of 1', () => {
    const m = ambient('heartbeat', 'hb', 't-1');
    const out = aggregateAmbient([m]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('stack');
    if (out[0]!.kind === 'stack') {
      expect(out[0]!.ambientKind).toBe('heartbeat');
      expect(out[0]!.turns).toHaveLength(1);
      expect(out[0]!.turns[0]!.turnId).toBe('t-1');
    }
  });

  it('merges consecutive same-kind ambient turns into one stack', () => {
    const out = aggregateAmbient([
      ambient('cron', 'daily', 't-1'),
      ambient('cron', 'daily', 't-2'),
      ambient('cron', 'daily', 't-3'),
    ]);
    expect(out).toHaveLength(1);
    if (out[0]!.kind === 'stack') {
      expect(out[0]!.turns.map(t => t.turnId)).toEqual(['t-1', 't-2', 't-3']);
    }
  });

  it('different kinds → separate stacks', () => {
    const out = aggregateAmbient([
      ambient('cron', 'daily', 't-1'),
      ambient('heartbeat', 'hb', 't-2'),
      ambient('cron', 'hourly', 't-3'),
    ]);
    expect(out).toHaveLength(3);
    expect(out.every(e => e.kind === 'stack')).toBe(true);
  });

  it('non-ambient turn between two same-kind ambient runs splits them', () => {
    const out = aggregateAmbient([
      ambient('cron', 'daily', 't-1'),
      regular('t-2'),
      ambient('cron', 'daily', 't-3'),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]!.kind).toBe('stack');
    expect(out[1]!.kind).toBe('message');
    expect(out[2]!.kind).toBe('stack');
  });

  it('groups all messages with the same turnId into a single turn', () => {
    // Multi-block ambient turn: prompt + response + tool event all share turnId.
    const turnId = 't-1';
    const out = aggregateAmbient([
      ambient('dream', 'nightly', turnId),
      msg({ metadata: { turnId, ambient: { kind: 'dream', summary: 'nightly' } }, kind: 'tool_event' }),
      msg({ metadata: { turnId, ambient: { kind: 'dream', summary: 'nightly' } } }),
    ]);
    expect(out).toHaveLength(1);
    if (out[0]!.kind === 'stack') {
      expect(out[0]!.turns).toHaveLength(1);
      expect(out[0]!.turns[0]!.messages).toHaveLength(3);
    }
  });

  it('computes startMs and endMs from the turn edges', () => {
    const first = ambient('cron', 'x', 't-1');
    const mid = msg({ metadata: { turnId: 't-1', ambient: { kind: 'cron', summary: 'x' } } });
    const last = msg({ metadata: { turnId: 't-1', ambient: { kind: 'cron', summary: 'x' } } });
    const out = aggregateAmbient([first, mid, last]);
    if (out[0]!.kind === 'stack') {
      const turn = out[0]!.turns[0]!;
      expect(turn.startMs).toBe(new Date(first.timestamp).getTime());
      expect(turn.endMs).toBe(new Date(last.timestamp).getTime());
      expect(out[0]!.startMs).toBe(turn.startMs);
      expect(out[0]!.endMs).toBe(turn.endMs);
    }
  });

  it('ignores malformed ambient metadata gracefully', () => {
    const malformed = msg({
      metadata: { turnId: 't-1', ambient: { summary: 'no kind' } as unknown as { kind: string; summary: string } },
    });
    const out = aggregateAmbient([malformed]);
    // No valid ambient kind → treated as regular message.
    expect(out[0]!.kind).toBe('message');
  });

  it('preserves order across heterogeneous streams', () => {
    const out = aggregateAmbient([
      regular('t-1'),
      ambient('cron', 'x', 't-2'),
      ambient('cron', 'x', 't-3'),
      regular('t-4'),
      ambient('dream', 'nightly', 't-5'),
    ]);
    expect(out).toHaveLength(4);
    expect(out[0]!.kind).toBe('message');
    expect(out[1]!.kind).toBe('stack'); // merged cron
    if (out[1]!.kind === 'stack') {
      expect(out[1]!.turns).toHaveLength(2);
    }
    expect(out[2]!.kind).toBe('message');
    expect(out[3]!.kind).toBe('stack'); // dream
  });

  it('non-ambient messages without turnId stay separate (synthetic turnId)', () => {
    const m1 = msg({ metadata: null });
    const m2 = msg({ metadata: null });
    const out = aggregateAmbient([m1, m2]);
    expect(out).toHaveLength(2);
    expect(out.every(e => e.kind === 'message')).toBe(true);
  });

  it('stack id is stable + derives from kind + first turnId', () => {
    const out = aggregateAmbient([
      ambient('autoemon', 'tick', 't-42'),
      ambient('autoemon', 'tick', 't-43'),
    ]);
    if (out[0]!.kind === 'stack') {
      expect(out[0]!.id).toBe('autoemon:t-42');
    }
  });
});
