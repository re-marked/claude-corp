import { describe, it, expect } from 'vitest';
import type { ChannelMessage } from '@claudecorp/shared';
import { getTurnId, isTurnContinuation } from '../packages/tui/src/components/message-list.js';

/**
 * Regression for v2.1.13: v2.1.10 added turn-grouping logic to
 * `MessageList` in message-list.tsx, but `MessageList` was a dead
 * component — nothing imported it. The actual chat render loop lives
 * in `views/chat.tsx:renderMsg` and was rendering every segment as
 * its own bubble with its own header + timestamp.
 *
 * v2.1.13 moved the grouping helpers out of the dead component,
 * exported them, and wired them into chat.tsx. These tests pin the
 * core predicate so a future refactor of the render loop can't
 * silently revert the grouping without failing.
 */

function msg(overrides: Partial<ChannelMessage> & { id: string; senderId: string }): ChannelMessage {
  return {
    id: overrides.id,
    senderId: overrides.senderId,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    content: overrides.content ?? '',
    kind: overrides.kind ?? 'text',
    metadata: overrides.metadata ?? null,
  } as ChannelMessage;
}

describe('getTurnId', () => {
  it('returns the turnId from metadata when present', () => {
    expect(getTurnId(msg({ id: 'a', senderId: 'ceo', metadata: { turnId: 't-1' } }))).toBe('t-1');
  });

  it('returns null when metadata is missing, empty, or lacks turnId', () => {
    expect(getTurnId(msg({ id: 'a', senderId: 'ceo', metadata: null }))).toBeNull();
    expect(getTurnId(msg({ id: 'a', senderId: 'ceo', metadata: {} }))).toBeNull();
    expect(getTurnId(msg({ id: 'a', senderId: 'ceo', metadata: { turnId: '' } }))).toBeNull();
  });
});

describe('isTurnContinuation', () => {
  it('true when same sender + same turnId', () => {
    const prev = msg({ id: 'a', senderId: 'ceo', metadata: { turnId: 't-1' } });
    const curr = msg({ id: 'b', senderId: 'ceo', kind: 'tool_event', metadata: { turnId: 't-1' } });
    expect(isTurnContinuation(curr, prev)).toBe(true);
  });

  it('false when prev is null (first message)', () => {
    const curr = msg({ id: 'a', senderId: 'ceo', metadata: { turnId: 't-1' } });
    expect(isTurnContinuation(curr, null)).toBe(false);
  });

  it('false when sender differs (interposed user message breaks the group)', () => {
    const prev = msg({ id: 'a', senderId: 'mark', metadata: { turnId: 't-1' } });
    const curr = msg({ id: 'b', senderId: 'ceo', metadata: { turnId: 't-1' } });
    expect(isTurnContinuation(curr, prev)).toBe(false);
  });

  it('false when turnId differs (new dispatch = new bubble)', () => {
    const prev = msg({ id: 'a', senderId: 'ceo', metadata: { turnId: 't-1' } });
    const curr = msg({ id: 'b', senderId: 'ceo', metadata: { turnId: 't-2' } });
    expect(isTurnContinuation(curr, prev)).toBe(false);
  });

  it('false when current message has no turnId (legacy/openclaw message)', () => {
    const prev = msg({ id: 'a', senderId: 'ceo', metadata: { turnId: 't-1' } });
    const curr = msg({ id: 'b', senderId: 'ceo', metadata: null });
    expect(isTurnContinuation(curr, prev)).toBe(false);
  });

  it('groups text→tool→tool→text all sharing one turnId', () => {
    const t = { turnId: 't-1' };
    const m1 = msg({ id: '1', senderId: 'ceo', kind: 'text', metadata: t });
    const m2 = msg({ id: '2', senderId: 'ceo', kind: 'tool_event', metadata: t });
    const m3 = msg({ id: '3', senderId: 'ceo', kind: 'tool_event', metadata: t });
    const m4 = msg({ id: '4', senderId: 'ceo', kind: 'text', metadata: t });

    // First message in a group isn't a continuation (gets the header)
    expect(isTurnContinuation(m1, null)).toBe(false);
    // All subsequent segments ARE continuations (header suppressed)
    expect(isTurnContinuation(m2, m1)).toBe(true);
    expect(isTurnContinuation(m3, m2)).toBe(true);
    expect(isTurnContinuation(m4, m3)).toBe(true);
  });
});
