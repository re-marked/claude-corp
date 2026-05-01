import { describe, it, expect } from 'vitest';
import {
  ClaudeCodeStreamParser,
  type ClaudeCodeEvent,
} from '../packages/daemon/src/harness/claude-code-stream.js';

/**
 * Project 1.7 coverage for the streaming parser's usage extraction.
 * We care about: (a) message_start emits an early snapshot, (b)
 * message_delta overwrites with final output_tokens, (c) lastUsage
 * getter survives across reset, (d) defensive parsing drops non-usage
 * payloads rather than emitting bogus events.
 */

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function collect(): { events: ClaudeCodeEvent[]; listener: (e: ClaudeCodeEvent) => void } {
  const events: ClaudeCodeEvent[] = [];
  return { events, listener: (e) => events.push(e) };
}

describe('ClaudeCodeStreamParser — usage events', () => {
  it('extracts input_tokens on message_start with source=message_start', () => {
    const p = new ClaudeCodeStreamParser();
    const { events, listener } = collect();
    p.parseLine(
      line({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 12_345,
              output_tokens: 0,
              cache_read_input_tokens: 9_000,
              cache_creation_input_tokens: 100,
            },
          },
        },
      }),
      listener,
    );
    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    const u = usageEvents[0] as Extract<ClaudeCodeEvent, { type: 'usage' }>;
    expect(u.usage.inputTokens).toBe(12_345);
    expect(u.usage.outputTokens).toBe(0);
    expect(u.usage.cacheReadInputTokens).toBe(9_000);
    expect(u.usage.cacheCreationInputTokens).toBe(100);
    expect(u.usage.source).toBe('message_start');
  });

  it('message_delta emits final usage with source=message_delta + overwrites lastUsage', () => {
    const p = new ClaudeCodeStreamParser();
    const { listener } = collect();

    p.parseLine(
      line({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 50_000, output_tokens: 0 } },
        },
      }),
      listener,
    );
    expect(p.getLastUsage()?.source).toBe('message_start');

    p.parseLine(
      line({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { input_tokens: 50_000, output_tokens: 2_500 },
        },
      }),
      listener,
    );
    const last = p.getLastUsage();
    expect(last?.source).toBe('message_delta');
    expect(last?.outputTokens).toBe(2_500);
    expect(last?.inputTokens).toBe(50_000);
  });

  it('non-usage payloads on message_start do not emit usage event', () => {
    const p = new ClaudeCodeStreamParser();
    const { events, listener } = collect();
    p.parseLine(
      line({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_1' } }, // no usage
      }),
      listener,
    );
    expect(events.some((e) => e.type === 'usage')).toBe(false);
    expect(p.getLastUsage()).toBeNull();
  });

  it('missing numeric fields default to 0 — no NaN leaks', () => {
    const p = new ClaudeCodeStreamParser();
    const { events, listener } = collect();
    p.parseLine(
      line({
        type: 'stream_event',
        event: {
          type: 'message_start',
          // Only input_tokens present — others must default to 0.
          message: { usage: { input_tokens: 42 } },
        },
      }),
      listener,
    );
    const u = events.find((e) => e.type === 'usage') as Extract<ClaudeCodeEvent, { type: 'usage' }>;
    expect(u.usage.inputTokens).toBe(42);
    expect(u.usage.outputTokens).toBe(0);
    expect(u.usage.cacheReadInputTokens).toBe(0);
    expect(u.usage.cacheCreationInputTokens).toBe(0);
  });

  it('reset() clears lastUsage', () => {
    const p = new ClaudeCodeStreamParser();
    const { listener } = collect();
    p.parseLine(
      line({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 1_000, output_tokens: 0 } },
        },
      }),
      listener,
    );
    expect(p.getLastUsage()).not.toBeNull();
    p.reset();
    expect(p.getLastUsage()).toBeNull();
  });
});
