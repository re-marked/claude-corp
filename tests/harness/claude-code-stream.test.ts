import { describe, it, expect, beforeEach } from 'vitest';
import {
  ClaudeCodeStreamParser,
  type ClaudeCodeEvent,
} from '../../packages/daemon/src/harness/claude-code-stream.js';

/**
 * Event shapes used here mirror what was captured empirically from
 * `claude -p --output-format stream-json --include-partial-messages`
 * during PR 1's streaming verification test. If Claude Code's wire
 * format changes upstream, these tests catch it.
 */

function collect(parser: ClaudeCodeStreamParser, lines: string[]): ClaudeCodeEvent[] {
  const events: ClaudeCodeEvent[] = [];
  for (const line of lines) parser.parseLine(line, (e) => events.push(e));
  return events;
}

const init = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: '080fd6fa-e0a4-4ba9-80ba-fa8181386174',
  model: 'claude-opus-4-6',
  tools: ['Read', 'Write', 'Bash'],
  apiKeySource: 'none',
});

const messageStart = JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'message_start',
    message: { id: 'msg_01', role: 'assistant', content: [] },
  },
});

const blockStart = (index: number, type = 'text') =>
  JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index,
      content_block: type === 'text'
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: 'tool_abc', name: 'Read', input: {} },
    },
  });

const textDelta = (index: number, text: string) =>
  JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    },
  });

const inputDelta = (index: number, partial: string) =>
  JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: partial },
    },
  });

const blockStop = (index: number) =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_stop', index },
  });

const messageStop = JSON.stringify({
  type: 'stream_event',
  event: { type: 'message_stop' },
});

const resultSuccess = (content = 'final answer') =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1234,
    result: content,
    session_id: '080fd6fa-e0a4-4ba9-80ba-fa8181386174',
    total_cost_usd: 0.01,
  });

describe('ClaudeCodeStreamParser', () => {
  let parser: ClaudeCodeStreamParser;

  beforeEach(() => {
    parser = new ClaudeCodeStreamParser();
  });

  describe('init event', () => {
    it('parses system/init into init event with session, model, tools', () => {
      const events = collect(parser, [init]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'init',
        sessionId: '080fd6fa-e0a4-4ba9-80ba-fa8181386174',
        model: 'claude-opus-4-6',
        tools: ['Read', 'Write', 'Bash'],
        apiKeySource: 'none',
      });
    });

    it('ignores other system subtypes', () => {
      const other = JSON.stringify({ type: 'system', subtype: 'other' });
      const events = collect(parser, [other]);
      expect(events).toHaveLength(0);
    });

    it('handles missing fields gracefully', () => {
      const partial = JSON.stringify({ type: 'system', subtype: 'init' });
      const events = collect(parser, [partial]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'init', sessionId: '', model: 'unknown', tools: [] });
    });
  });

  describe('text streaming', () => {
    it('emits token events with running accumulated text', () => {
      const events = collect(parser, [
        messageStart,
        blockStart(0, 'text'),
        textDelta(0, 'Hello'),
        textDelta(0, ', '),
        textDelta(0, 'world'),
        textDelta(0, '!'),
        blockStop(0),
        messageStop,
      ]);
      const tokens = events.filter((e) => e.type === 'token');
      expect(tokens).toHaveLength(4);
      expect(tokens.map((t: any) => t.text)).toEqual(['Hello', ', ', 'world', '!']);
      expect(tokens.map((t: any) => t.accumulated)).toEqual([
        'Hello',
        'Hello, ',
        'Hello, world',
        'Hello, world!',
      ]);
    });

    it('getAccumulatedText reflects the running concatenation', () => {
      collect(parser, [
        messageStart,
        blockStart(0, 'text'),
        textDelta(0, 'foo'),
        textDelta(0, 'bar'),
      ]);
      expect(parser.getAccumulatedText()).toBe('foobar');
    });
  });

  describe('tool calls', () => {
    it('fires a single tool_call event at content_block_stop with full args', () => {
      const events = collect(parser, [
        messageStart,
        blockStart(0, 'tool'),
        inputDelta(0, '{"path":'),
        inputDelta(0, '"/etc/hosts"}'),
        blockStop(0),
        messageStop,
      ]);
      const toolCalls = events.filter((e) => e.type === 'tool_call');
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        type: 'tool_call',
        toolCallId: 'tool_abc',
        name: 'Read',
        args: { path: '/etc/hosts' },
      });
    });

    it('preserves raw json when args are not parseable', () => {
      const events = collect(parser, [
        messageStart,
        blockStart(0, 'tool'),
        inputDelta(0, '{invalid'),
        blockStop(0),
      ]);
      const toolCalls = events.filter((e) => e.type === 'tool_call') as Array<Extract<ClaudeCodeEvent, { type: 'tool_call' }>>;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.args).toEqual({ _raw: '{invalid' });
    });

    it('handles tool blocks with empty args', () => {
      const events = collect(parser, [
        messageStart,
        blockStart(0, 'tool'),
        blockStop(0),
      ]);
      const toolCalls = events.filter((e) => e.type === 'tool_call') as Array<Extract<ClaudeCodeEvent, { type: 'tool_call' }>>;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.args).toEqual({});
    });

    it('does not fire tool_call for text blocks', () => {
      const events = collect(parser, [
        messageStart,
        blockStart(0, 'text'),
        textDelta(0, 'hi'),
        blockStop(0),
      ]);
      const toolCalls = events.filter((e) => e.type === 'tool_call');
      expect(toolCalls).toHaveLength(0);
    });

    it('handles interleaved text and tool blocks at different indices', () => {
      const events = collect(parser, [
        messageStart,
        blockStart(0, 'text'),
        textDelta(0, 'reading file'),
        blockStop(0),
        blockStart(1, 'tool'),
        inputDelta(1, '{"path":"/tmp/x"}'),
        blockStop(1),
        messageStop,
      ]);
      const tokens = events.filter((e) => e.type === 'token');
      const tools = events.filter((e) => e.type === 'tool_call');
      expect(tokens).toHaveLength(1);
      expect(tools).toHaveLength(1);
    });
  });

  describe('lifecycle events', () => {
    it('fires lifecycle for message_start, content_block_start/stop, message_stop, message_delta', () => {
      const messageDelta = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 10 },
        },
      });
      const events = collect(parser, [
        messageStart,
        blockStart(0, 'text'),
        blockStop(0),
        messageDelta,
        messageStop,
      ]);
      const phases = events
        .filter((e) => e.type === 'lifecycle')
        .map((e: any) => e.phase);
      expect(phases).toEqual([
        'message_start',
        'content_block_start',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
    });
  });

  describe('rate_limit events', () => {
    it('emits rate_limit with the raw info payload', () => {
      const rl = JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', resetsAt: 1776171600, rateLimitType: 'five_hour' },
      });
      const events = collect(parser, [rl]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'rate_limit',
        info: { status: 'allowed', resetsAt: 1776171600, rateLimitType: 'five_hour' },
      });
    });

    it('handles missing rate_limit_info gracefully', () => {
      const rl = JSON.stringify({ type: 'rate_limit_event' });
      const events = collect(parser, [rl]);
      expect(events).toHaveLength(1);
      expect((events[0] as any).info).toEqual({});
    });
  });

  describe('result envelope', () => {
    it('emits result_success with content + sessionId + duration + cost', () => {
      const events = collect(parser, [resultSuccess('the answer')]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'result_success',
        content: 'the answer',
        sessionId: '080fd6fa-e0a4-4ba9-80ba-fa8181386174',
        durationMs: 1234,
        cost: 0.01,
      });
      expect(parser.isFinished()).toBe(true);
    });

    it('falls back to accumulated text when result.result is missing', () => {
      collect(parser, [
        blockStart(0, 'text'),
        textDelta(0, 'fallback'),
      ]);
      const events = collect(parser, [
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, session_id: 'abc' }),
      ]);
      expect((events[0] as any).content).toBe('fallback');
    });

    it('emits result_error when subtype is error or is_error is true', () => {
      const events = collect(parser, [
        JSON.stringify({ type: 'result', subtype: 'error', is_error: true, error: 'boom', session_id: 'abc' }),
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'result_error',
        message: 'boom',
        sessionId: 'abc',
      });
    });

    it('flags overloaded errors via isOverloaded', () => {
      const events = collect(parser, [
        JSON.stringify({ type: 'result', subtype: 'error', is_error: true, error: 'Status 529: overloaded' }),
      ]);
      expect((events[0] as any).isOverloaded).toBe(true);
    });

    it('picks the first string from p.errors[] when error/message/result are empty', () => {
      // Claude's "session not found" failure (and similar runtime
      // errors) populate an `errors` array, NOT `error`/`message`. The
      // previous pickErrorMessage only checked scalar fields and
      // defaulted to the unhelpful "Claude Code returned an error
      // result". Regression test pins the array fallback.
      const events = collect(parser, [
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'abc',
          errors: ['No conversation found with session ID: 108e2b08-14ff-58bf-8342-a391290d5fac'],
        }),
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'result_error',
        message: 'No conversation found with session ID: 108e2b08-14ff-58bf-8342-a391290d5fac',
      });
    });

    it('skips empty strings in p.errors[] when picking a message', () => {
      const events = collect(parser, [
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['', 'second error', 'third'],
        }),
      ]);
      expect((events[0] as any).message).toBe('second error');
    });

    it('falls back to the generic message when errors[] is empty or missing strings', () => {
      const events = collect(parser, [
        JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] }),
      ]);
      expect((events[0] as any).message).toBe('Claude Code returned an error result');
    });
  });

  describe('assistant_message', () => {
    it('emits assistant_message with extracted text from content blocks', () => {
      const assistantMessage = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Part A' },
            { type: 'text', text: ' Part B' },
            { type: 'tool_use', name: 'Read' },
          ],
        },
      });
      const events = collect(parser, [assistantMessage]);
      const msg = events.find((e) => e.type === 'assistant_message') as any;
      expect(msg).toBeDefined();
      expect(msg.content).toBe('Part A Part B');
    });

    it('handles malformed assistant messages without throwing', () => {
      const events = collect(parser, [
        JSON.stringify({ type: 'assistant', message: null }),
      ]);
      const msg = events.find((e) => e.type === 'assistant_message') as any;
      expect(msg).toBeDefined();
      expect(msg.content).toBe('');
    });
  });

  describe('malformed input', () => {
    it('emits malformed event for non-JSON lines', () => {
      const events = collect(parser, ['this is not json {{{']);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'malformed' });
      expect((events[0] as any).raw).toBe('this is not json {{{');
    });

    it('skips empty / whitespace-only lines silently', () => {
      const events = collect(parser, ['', '   ', '\t']);
      expect(events).toHaveLength(0);
    });

    it('keeps parsing after a malformed line (does not throw)', () => {
      const events = collect(parser, ['garbage', init, 'more garbage', resultSuccess()]);
      expect(events.filter((e) => e.type === 'malformed')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'init')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'result_success')).toHaveLength(1);
    });
  });

  describe('forward compatibility', () => {
    it('ignores unknown top-level event types without throwing', () => {
      const events = collect(parser, [
        JSON.stringify({ type: 'future_event_type', payload: 'whatever' }),
      ]);
      expect(events).toHaveLength(0);
    });

    it('ignores unknown stream_event subtypes without throwing', () => {
      const events = collect(parser, [
        JSON.stringify({ type: 'stream_event', event: { type: 'future_subtype' } }),
      ]);
      expect(events).toHaveLength(0);
    });

    it('ignores user (tool_result) messages — surfaced via next assistant turn', () => {
      const events = collect(parser, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file contents' }] } }),
      ]);
      expect(events).toHaveLength(0);
    });
  });

  describe('reset', () => {
    it('clears accumulated text and finished flag', () => {
      collect(parser, [blockStart(0, 'text'), textDelta(0, 'hi'), resultSuccess()]);
      expect(parser.getAccumulatedText()).toBe('hi');
      expect(parser.isFinished()).toBe(true);
      parser.reset();
      expect(parser.getAccumulatedText()).toBe('');
      expect(parser.isFinished()).toBe(false);
    });
  });
});
