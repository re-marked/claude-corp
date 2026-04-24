/**
 * Stream-json parser for Claude Code's `--output-format stream-json` output.
 *
 * Claude Code emits a sequence of NDJSON lines covering session
 * initialization, rate-limit info, streaming token deltas, tool-use
 * blocks, and a final result envelope. This parser reads complete lines
 * one at a time and emits structured events the ClaudeCodeHarness can
 * translate into Claude Corp's DispatchCallbacks.
 *
 * Stateful: accumulates content-block payloads (tool-use input_json
 * deltas) by index so the harness can fire onToolStart/onToolEnd with
 * full args at content_block_stop boundaries.
 *
 * Caller is responsible for line buffering — feed only complete NDJSON
 * lines via parseLine. Partial-line handling lives in the harness's
 * subprocess pipe reader.
 *
 * Event shape was derived from an empirical capture during PR 1's
 * streaming test (see claude -p --output-format stream-json output).
 */

/**
 * Token usage snapshot emitted by the Anthropic streaming protocol.
 * Appears at `message_start` (early — input_tokens known, output_tokens
 * still zero) and `message_delta` (final — output_tokens populated by
 * message_stop). Fields mirror the raw API shape so downstream callers
 * don't have to know the over-the-wire JSON.
 *
 * For compaction-threshold reasoning (Project 1.7), `inputTokens` on
 * the LATEST message_delta approximates "size of the context the model
 * is operating on" — a cheap proxy for what `tokenCountWithEstimation`
 * would return over the full message list. Good enough for deciding
 * whether the agent is in the pre-compact signal window.
 */
export interface ClaudeCodeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Source event: 'message_start' (early snapshot) or 'message_delta' (final). */
  source: 'message_start' | 'message_delta';
}

/** Discriminated union of every event the harness reacts to. */
export type ClaudeCodeEvent =
  | { type: 'init'; sessionId: string; model: string; tools: string[]; apiKeySource?: string }
  | { type: 'token'; text: string; accumulated: string }
  | { type: 'text_block_complete'; text: string; blockIndex: number }
  | { type: 'tool_call'; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: 'lifecycle'; phase: 'message_start' | 'message_stop' | 'content_block_start' | 'content_block_stop' | 'message_delta' }
  | { type: 'usage'; usage: ClaudeCodeUsage }
  | { type: 'rate_limit'; info: Record<string, unknown> }
  | { type: 'assistant_message'; content: string }
  | { type: 'result_success'; content: string; sessionId: string; durationMs: number; cost?: number }
  | { type: 'result_error'; message: string; sessionId?: string; isOverloaded?: boolean }
  | { type: 'malformed'; raw: string; reason: string };

export type ClaudeCodeEventListener = (event: ClaudeCodeEvent) => void;

interface BlockState {
  type: 'text' | 'tool_use' | 'unknown';
  name?: string;
  toolUseId?: string;
  jsonBuffer: string;
  /** Per-text-block accumulator. Used by text_block_complete events. */
  textBuffer: string;
}

export class ClaudeCodeStreamParser {
  private blocks = new Map<number, BlockState>();
  /**
   * Cross-block running concatenation of every text delta. Drives the
   * `accumulated` field on `token` events (kept cross-block for
   * backwards-compat with callers like router.ts that use offset
   * tracking to slice out new content). Per-block boundaries are
   * surfaced separately via `text_block_complete` events.
   */
  private accumulated = '';
  private finished = false;
  /**
   * Latest usage snapshot observed in the stream. Populated on
   * message_start (early) and overwritten on message_delta (final).
   * null until the first message event arrives. Consumers polling
   * for compaction-threshold decisions read this between dispatches.
   */
  private lastUsage: ClaudeCodeUsage | null = null;

  /**
   * Concatenation of every text block observed so far. Used as the
   * defensive fallback for `result_success.content` so cross-block
   * total is preserved even when claude's `result` envelope only
   * carries the final block.
   */
  getAccumulatedText(): string {
    return this.accumulated;
  }

  /** Whether a result_success or result_error has been observed. */
  isFinished(): boolean {
    return this.finished;
  }

  /**
   * Latest usage snapshot or null when no message_start/delta has
   * been parsed yet. Caller pattern: harness polls this after a
   * dispatch completes to record the turn's context size for the
   * next dispatch's pre-compact signal decision.
   */
  getLastUsage(): ClaudeCodeUsage | null {
    return this.lastUsage;
  }

  /**
   * Reset internal state. Useful between dispatches if a single parser
   * instance is reused (the harness creates a fresh parser per dispatch
   * by default, so this is mostly here for tests).
   */
  reset(): void {
    this.blocks.clear();
    this.lastUsage = null;
    this.accumulated = '';
    this.finished = false;
  }

  /**
   * Parse a single complete NDJSON line and emit zero or more events.
   * Empty / whitespace-only lines are silently dropped. Malformed JSON
   * surfaces as a `malformed` event so the harness can log + continue
   * rather than crashing.
   */
  parseLine(line: string, listener: ClaudeCodeEventListener): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      listener({
        type: 'malformed',
        raw: trimmed,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    switch (parsed.type) {
      case 'system':
        if ((parsed as any).subtype === 'init') {
          const p = parsed as any;
          listener({
            type: 'init',
            sessionId: typeof p.session_id === 'string' ? p.session_id : '',
            model: typeof p.model === 'string' ? p.model : 'unknown',
            tools: Array.isArray(p.tools) ? p.tools : [],
            apiKeySource: typeof p.apiKeySource === 'string' ? p.apiKeySource : undefined,
          });
        }
        break;

      case 'rate_limit_event': {
        const info = (parsed as any).rate_limit_info ?? {};
        listener({ type: 'rate_limit', info });
        break;
      }

      case 'stream_event': {
        const ev = (parsed as any).event;
        if (ev && typeof ev === 'object') {
          this.handleStreamEvent(ev, listener);
        }
        break;
      }

      case 'assistant': {
        const content = extractText((parsed as any).message);
        listener({ type: 'assistant_message', content });
        break;
      }

      case 'user':
        // Tool result turns surface as user messages in transcript form;
        // we don't emit them as discrete events because the harness
        // already fired tool_call when the model requested the tool, and
        // the next assistant message reflects the outcome via further
        // text/tool deltas.
        break;

      case 'result': {
        this.finished = true;
        const p = parsed as any;
        if (p.subtype === 'success' || p.is_error === false) {
          // Prefer the cross-block accumulation over claude's `result`
          // field — `result` only carries the LAST text block, so a
          // multi-block response (text → tool → text) would lose the
          // earlier text if we trusted `result` alone. Per-block
          // persistence via `text_block_complete` is the primary
          // mechanism for preserving each block; this is a defensive
          // fallback for callers that only consult result_success.
          const fallbackContent = this.accumulated || (typeof p.result === 'string' ? p.result : '');
          listener({
            type: 'result_success',
            content: fallbackContent,
            sessionId: typeof p.session_id === 'string' ? p.session_id : '',
            durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : 0,
            cost: typeof p.total_cost_usd === 'number' ? p.total_cost_usd : undefined,
          });
        } else {
          listener({
            type: 'result_error',
            message: pickErrorMessage(p),
            sessionId: typeof p.session_id === 'string' ? p.session_id : undefined,
            isOverloaded: detectOverloaded(p),
          });
        }
        break;
      }

      // Unknown top-level types: ignored intentionally so future Claude Code
      // event additions don't crash older harness versions.
      default:
        break;
    }
  }

  private handleStreamEvent(ev: Record<string, unknown>, listener: ClaudeCodeEventListener): void {
    switch (ev.type) {
      case 'message_start': {
        listener({ type: 'lifecycle', phase: 'message_start' });
        // Early usage snapshot — input_tokens populated; output_tokens
        // zero until the turn runs. Capturing both edges (start +
        // delta) lets downstream reason about "what the model saw on
        // input" even if the turn aborts before message_delta fires.
        const msg = ev.message as Record<string, unknown> | undefined;
        const usage = msg ? extractUsage(msg.usage, 'message_start') : null;
        if (usage) this.lastUsage = usage;
        if (usage) listener({ type: 'usage', usage });
        break;
      }

      case 'content_block_start': {
        const idx = typeof ev.index === 'number' ? ev.index : 0;
        const block = (ev.content_block ?? {}) as Record<string, unknown>;
        const blockType = block.type === 'tool_use'
          ? 'tool_use'
          : block.type === 'text' ? 'text' : 'unknown';
        this.blocks.set(idx, {
          type: blockType,
          name: typeof block.name === 'string' ? block.name : undefined,
          toolUseId: typeof block.id === 'string' ? block.id : undefined,
          jsonBuffer: '',
          textBuffer: '',
        });
        listener({ type: 'lifecycle', phase: 'content_block_start' });
        break;
      }

      case 'content_block_delta': {
        const idx = typeof ev.index === 'number' ? ev.index : 0;
        const delta = (ev.delta ?? {}) as Record<string, unknown>;

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          this.accumulated += delta.text;
          const block = this.blocks.get(idx);
          if (block && block.type === 'text') block.textBuffer += delta.text;
          // accumulated stays cross-block — `text_block_complete`
          // surfaces per-block boundaries separately. Existing callers
          // (router) use cross-block + offset tracking; new callers
          // (api /cc/say) can use either.
          listener({ type: 'token', text: delta.text, accumulated: this.accumulated });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const block = this.blocks.get(idx);
          if (block) block.jsonBuffer += delta.partial_json;
        }
        break;
      }

      case 'content_block_stop': {
        const idx = typeof ev.index === 'number' ? ev.index : 0;
        const block = this.blocks.get(idx);
        if (block && block.type === 'tool_use') {
          let args: Record<string, unknown> = {};
          if (block.jsonBuffer) {
            try {
              const parsed = JSON.parse(block.jsonBuffer);
              if (parsed && typeof parsed === 'object') args = parsed;
            } catch {
              args = { _raw: block.jsonBuffer };
            }
          }
          listener({
            type: 'tool_call',
            toolCallId: block.toolUseId ?? `unknown-${idx}`,
            name: block.name ?? 'unknown',
            args,
          });
        } else if (block && block.type === 'text' && block.textBuffer.length > 0) {
          // Emit the whole text block as a single completion event so
          // downstream can persist it before the next tool call /
          // text block arrives. Without this the only chance to
          // capture intermediate text was the final result envelope,
          // which only carries the LAST block — earlier text was lost.
          listener({
            type: 'text_block_complete',
            text: block.textBuffer,
            blockIndex: idx,
          });
        }
        this.blocks.delete(idx);
        listener({ type: 'lifecycle', phase: 'content_block_stop' });
        break;
      }

      case 'message_delta': {
        listener({ type: 'lifecycle', phase: 'message_delta' });
        // Final-of-turn usage update. Anthropic emits the finalized
        // output_tokens here; input_tokens on message_delta matches
        // message_start's (the input was fixed before the turn ran).
        // Emit the usage event so downstream (harness / compaction
        // threshold watchers) reads the authoritative count.
        const usage = extractUsage(ev.usage, 'message_delta');
        if (usage) this.lastUsage = usage;
        if (usage) listener({ type: 'usage', usage });
        break;
      }

      case 'message_stop':
        listener({ type: 'lifecycle', phase: 'message_stop' });
        break;

      // Unknown stream-event types intentionally ignored — same forward-
      // compat reasoning as the top-level switch.
      default:
        break;
    }
  }
}

function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as any).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('');
}

function pickErrorMessage(p: any): string {
  // Claude's error envelope shape varies by failure mode. Most single-
  // reason failures populate p.error or p.message. Session-not-found
  // and similar runtime errors populate p.errors[] (an array of
  // strings) — observed from `claude --resume <unknown-uuid>` which
  // emits `{type:"result", is_error:true, errors:["No conversation
  // found with session ID: ..."]}`. Without the array fallback the
  // user would see the unhelpful default "Claude Code returned an
  // error result" instead of the specific cause.
  if (Array.isArray(p.errors) && p.errors.length > 0) {
    const first = p.errors.find((e: unknown) => typeof e === 'string' && e.length > 0);
    if (typeof first === 'string') return first;
  }
  return (
    (typeof p.error === 'string' && p.error) ||
    (typeof p.message === 'string' && p.message) ||
    (typeof p.result === 'string' && p.result) ||
    'Claude Code returned an error result'
  );
}

function detectOverloaded(p: any): boolean {
  const text = JSON.stringify(p).toLowerCase();
  return /overload|529/.test(text);
}

/**
 * Parse an Anthropic streaming-protocol usage payload into a typed
 * ClaudeCodeUsage. Returns null when the input isn't a plausible
 * usage object — defensive for forward-compat (new fields land) and
 * for partial events where usage is absent (content-only deltas).
 *
 * The API shape uses snake_case (input_tokens / cache_read_input_tokens);
 * we rename to camelCase at the harness boundary since everything
 * downstream is TS-native. Missing numeric fields default to 0 so
 * consumers can sum safely without null-checks.
 */
function extractUsage(
  raw: unknown,
  source: 'message_start' | 'message_delta',
): ClaudeCodeUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const readNum = (k: string): number => {
    const v = u[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  // Require at least one recognizable field to confirm this is a
  // usage object (not some other payload we got fed by accident).
  if (
    u.input_tokens === undefined &&
    u.output_tokens === undefined &&
    u.cache_read_input_tokens === undefined &&
    u.cache_creation_input_tokens === undefined
  ) {
    return null;
  }
  return {
    inputTokens: readNum('input_tokens'),
    outputTokens: readNum('output_tokens'),
    cacheReadInputTokens: readNum('cache_read_input_tokens'),
    cacheCreationInputTokens: readNum('cache_creation_input_tokens'),
    source,
  };
}
