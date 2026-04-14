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

/** Discriminated union of every event the harness reacts to. */
export type ClaudeCodeEvent =
  | { type: 'init'; sessionId: string; model: string; tools: string[]; apiKeySource?: string }
  | { type: 'token'; text: string; accumulated: string }
  | { type: 'text_block_complete'; text: string; blockIndex: number }
  | { type: 'tool_call'; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: 'lifecycle'; phase: 'message_start' | 'message_stop' | 'content_block_start' | 'content_block_stop' | 'message_delta' }
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
  /** Per-text-block accumulator. Resets between blocks. */
  textBuffer: string;
}

export class ClaudeCodeStreamParser {
  private blocks = new Map<number, BlockState>();
  /**
   * Per-block running text. `currentBlockText` is what's actively
   * streaming RIGHT NOW (resets when a text block ends so the next
   * block streams fresh). `allText` is the running concatenation of
   * every text block ever seen — kept for backwards-compat with
   * callers that want the full content as one string.
   */
  private currentBlockText = '';
  private allText = '';
  private finished = false;

  /**
   * Concatenation of every text block observed so far, across all
   * blocks in the message. Use this for "give me the whole response
   * as one string" needs (defensive fallback when a result envelope
   * is missing).
   */
  getAccumulatedText(): string {
    return this.allText;
  }

  /** Whether a result_success or result_error has been observed. */
  isFinished(): boolean {
    return this.finished;
  }

  /**
   * Reset internal state. Useful between dispatches if a single parser
   * instance is reused (the harness creates a fresh parser per dispatch
   * by default, so this is mostly here for tests).
   */
  reset(): void {
    this.blocks.clear();
    this.currentBlockText = '';
    this.allText = '';
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
          const fallbackContent = this.allText || (typeof p.result === 'string' ? p.result : '');
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
      case 'message_start':
        listener({ type: 'lifecycle', phase: 'message_start' });
        break;

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
        // A new text block resets the per-block streaming accumulator
        // so onToken emits fresh deltas for THIS block (not stale from
        // the previous one). Cross-block totals stay in `allText`.
        if (blockType === 'text') {
          this.currentBlockText = '';
        }
        listener({ type: 'lifecycle', phase: 'content_block_start' });
        break;
      }

      case 'content_block_delta': {
        const idx = typeof ev.index === 'number' ? ev.index : 0;
        const delta = (ev.delta ?? {}) as Record<string, unknown>;

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          this.allText += delta.text;
          this.currentBlockText += delta.text;
          const block = this.blocks.get(idx);
          if (block && block.type === 'text') block.textBuffer += delta.text;
          // accumulated reflects the CURRENT block only — that's what
          // the streaming overlay shows. Cross-block totals live in
          // `getAccumulatedText()` for callers that want everything.
          listener({ type: 'token', text: delta.text, accumulated: this.currentBlockText });
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

      case 'message_delta':
        listener({ type: 'lifecycle', phase: 'message_delta' });
        break;

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
