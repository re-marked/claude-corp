/**
 * Claude Code session transcript parser — reads the JSONL file at
 * `transcript_path` (passed to the Stop / PreCompact hook in stdin)
 * and extracts the RecentActivity the audit engine needs.
 *
 * "Recent" is scoped to "since the last user message." The semantic:
 * audit checks what the agent did in response to the founder's most
 * recent prompt — not arbitrary older history, which isn't being
 * evaluated. Walks the file backwards from the end, parsing lines
 * until it hits a user turn, then returns the activity forward from
 * there.
 *
 * Claude Code's JSONL transcript format isn't formally documented.
 * The parser is defensive — tries multiple known envelope shapes and
 * extracts what it can. The audit-gate probe's `.probe-stdin.jsonl`
 * at `scripts/audit-gate-probe/` captures real invocations so we can
 * tighten the parser when we observe a shape that doesn't match.
 *
 * Fail-open philosophy: if the transcript is missing, unreadable, or
 * malformed, the parser returns an empty RecentActivity. That
 * cascades into the audit engine's approve-when-no-evidence path —
 * better to let the agent through than to block on a broken
 * transcript we can't even read.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { RecentActivity, ToolCall, TouchedFile } from './types.js';

/** Tool names the read-back gate tracks for `TouchedFile.via`. */
const TOUCH_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * Parse the transcript at `transcriptPath`, returning the agent's
 * activity since the last user message. Returns empty activity on
 * any I/O or parse failure. Caller decides how to handle that —
 * for audit, empty means "no evidence found," which triggers the
 * soft block.
 */
export function parseTranscript(transcriptPath: string): RecentActivity {
  const empty: RecentActivity = { toolCalls: [], touchedFiles: [], assistantText: [] };

  if (!transcriptPath || !existsSync(transcriptPath)) return empty;

  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return empty;
  }

  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return empty;

  // Walk backwards until we hit a user turn. Everything after that
  // (exclusive) is "recent." We reverse again at the end so tool
  // calls come out in chronological order — scanner heuristics read
  // more naturally that way.
  const recent: Array<Record<string, unknown>> = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParseLine(lines[i]!);
    if (!parsed) continue;
    if (isUserTurn(parsed)) break;
    recent.push(parsed);
  }
  recent.reverse();

  // Extract tool calls and touched-file events.
  const toolCalls: ToolCall[] = [];
  const touched = new Map<string, Set<TouchedFile['via'][number]>>();
  const assistantText: string[] = [];
  // Track pending tool_use → tool_result pairs so we can attach the
  // output + is_error flag back to the original call.
  const pending = new Map<string, ToolCall>();

  for (const entry of recent) {
    for (const block of iterateContentBlocks(entry)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        assistantText.push(block.text);
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const call: ToolCall = {
          name: block.name,
          input: (block.input as Record<string, unknown>) ?? {},
        };
        toolCalls.push(call);
        if (typeof block.id === 'string') pending.set(block.id, call);

        // Record touched file if this tool operates on one.
        const filePath = extractFilePathFromInput(block.name, call.input);
        if (filePath && TOUCH_TOOLS.has(block.name)) {
          if (!touched.has(filePath)) touched.set(filePath, new Set());
          touched.get(filePath)!.add(
            block.name as TouchedFile['via'][number],
          );
        }
      } else if (block.type === 'tool_result') {
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
        const call = id ? pending.get(id) : undefined;
        if (call) {
          call.output = truncate(stringifyContent(block.content));
          if (block.is_error === true) call.isError = true;
          if (id) pending.delete(id);
        }
      }
    }
  }

  const touchedFiles: TouchedFile[] = [];
  for (const [path, viaSet] of touched) {
    touchedFiles.push({ path, via: [...viaSet] });
  }

  return { toolCalls, touchedFiles, assistantText };
}

/**
 * PreCompact-manual-trigger variant of parseTranscript.
 *
 * When a Partner types `/compact` the transcript's final user turn IS
 * the `/compact` command — meaning plain `parseTranscript()` returns
 * activity between `/compact` and the hook invocation, which is
 * usually empty. The auto-checkpoint then loses the "what was the
 * agent JUST doing" context exactly when we most want to preserve it
 * (Codex P2 reviewer catch, PR #170).
 *
 * This variant walks backward through user turns, skipping any that
 * look like a `/compact` invocation, and returns activity since the
 * first REAL user turn — i.e. the work-in-progress right before the
 * founder interrupted with `/compact`. Fail-open identical to
 * parseTranscript (empty RecentActivity on any I/O / parse error).
 *
 * For auto-compact (threshold-triggered, no user turn), the terminal
 * user turn is already a real one; behavior is identical to
 * parseTranscript.
 */
export function parseTranscriptBeforeCompact(transcriptPath: string): RecentActivity {
  const empty: RecentActivity = { toolCalls: [], touchedFiles: [], assistantText: [] };

  if (!transcriptPath || !existsSync(transcriptPath)) return empty;

  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return empty;
  }

  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return empty;

  // Two-phase walk:
  //   Phase A: backward from EOF to the nearest user turn. If it's a
  //   `/compact` invocation, mark its index and keep walking; otherwise
  //   we use that turn as the boundary (same semantics as parseTranscript).
  //
  //   Phase B: collect entries AFTER the chosen boundary, up to (but
  //   not including) the `/compact` turn if one was found in Phase A —
  //   i.e. the activity between the real user turn and the founder's
  //   /compact interrupt.
  let compactTurnIdx: number | null = null;
  let boundaryIdx: number | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParseLine(lines[i]!);
    if (!parsed) continue;
    if (!isUserTurn(parsed)) continue;

    if (isCompactInvocation(parsed)) {
      // First /compact turn encountered; remember its index so Phase B
      // can stop the slice before it.
      if (compactTurnIdx === null) compactTurnIdx = i;
      // Keep walking — we need a pre-compact user turn as the boundary.
      continue;
    }
    // First non-/compact user turn — this is the real boundary.
    boundaryIdx = i;
    break;
  }

  if (boundaryIdx === null && compactTurnIdx === null) {
    // No user turn at all (transcript open before any user input) — same
    // behavior as parseTranscript returning an empty slice.
    return empty;
  }

  // If we saw only /compact turns and never reached a real user turn,
  // fall back to slicing after the latest /compact — better to surface
  // whatever minimal activity exists than return truly empty. This is
  // rare (would require a fresh session where the very first user input
  // was /compact) but the fallback is more useful than a dead empty.
  const sliceStart = (boundaryIdx ?? compactTurnIdx!) + 1;
  const sliceEnd = compactTurnIdx ?? lines.length;

  const recent: Array<Record<string, unknown>> = [];
  for (let i = sliceStart; i < sliceEnd; i++) {
    const parsed = tryParseLine(lines[i]!);
    if (parsed) recent.push(parsed);
  }

  // Reuse the same extraction pipeline as parseTranscript so both paths
  // produce identical RecentActivity shapes.
  return extractActivityFromEntries(recent);
}

/**
 * Detect a `/compact` user-turn envelope. Heuristic: any user-turn
 * whose text content (top-level string or text-block content) starts
 * with `/compact` (with or without an argument). Handles both shapes
 * observed in the wild — `{message: {content: "..."}}` and
 * `{message: {content: [{type: "text", text: "..."}]}}`.
 */
function isCompactInvocation(entry: Record<string, unknown>): boolean {
  for (const block of iterateContentBlocks(entry)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      if (/^\s*\/compact(\s|$)/.test(block.text)) return true;
    }
  }
  // Handle the shape where content is directly a string (no blocks).
  const msg = entry.message as Record<string, unknown> | undefined;
  const stringContent =
    typeof entry.content === 'string'
      ? entry.content
      : msg && typeof msg.content === 'string'
        ? msg.content
        : null;
  if (stringContent !== null && /^\s*\/compact(\s|$)/.test(stringContent)) {
    return true;
  }
  return false;
}

/**
 * Extract RecentActivity from an already-sliced list of transcript
 * entries. Factored out of parseTranscript so both the default path
 * and the before-compact variant share the same block-handling logic.
 */
function extractActivityFromEntries(
  recent: Array<Record<string, unknown>>,
): RecentActivity {
  const toolCalls: ToolCall[] = [];
  const touched = new Map<string, Set<TouchedFile['via'][number]>>();
  const assistantText: string[] = [];
  const pending = new Map<string, ToolCall>();

  for (const entry of recent) {
    for (const block of iterateContentBlocks(entry)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        assistantText.push(block.text);
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const call: ToolCall = {
          name: block.name,
          input: (block.input as Record<string, unknown>) ?? {},
        };
        toolCalls.push(call);
        if (typeof block.id === 'string') pending.set(block.id, call);
        const filePath = extractFilePathFromInput(block.name, call.input);
        if (filePath && TOUCH_TOOLS.has(block.name)) {
          if (!touched.has(filePath)) touched.set(filePath, new Set());
          touched.get(filePath)!.add(block.name as TouchedFile['via'][number]);
        }
      } else if (block.type === 'tool_result') {
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
        const call = id ? pending.get(id) : undefined;
        if (call) {
          call.output = truncate(stringifyContent(block.content));
          if (block.is_error === true) call.isError = true;
          if (id) pending.delete(id);
        }
      }
    }
  }

  const touchedFiles: TouchedFile[] = [];
  for (const [path, viaSet] of touched) {
    touchedFiles.push({ path, via: [...viaSet] });
  }

  return { toolCalls, touchedFiles, assistantText };
}

// ─── Token usage extraction (Project 1.7 round 3) ──────────────────

/**
 * Snapshot of token usage observed in the transcript. Mirrors the
 * camelCase shape from the Claude Code streaming parser (daemon/harness)
 * so consumers can treat both sources symmetrically.
 */
export interface TranscriptUsageSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

/**
 * Walk the transcript backwards and return the most recent usage block
 * from a `message_start` or `message_delta` event. Returns null when
 * the file is missing, malformed, or carries no usage events (e.g. an
 * OpenClaw-era transcript that doesn't emit stream events at all).
 *
 * The builder layer (buildCheckpointObservation) consumes this to
 * render "at ~152k tokens when compact fired" in the auto-checkpoint
 * body — durable context for the Partner's post-compact self beyond
 * what Claude Code's summarizer will preserve.
 *
 * Fail-soft: any I/O or parse error falls through to null. The
 * checkpoint write still proceeds without the token line; the
 * mechanism doesn't break because one optional enrichment failed.
 */
export function extractLatestUsageFromTranscript(
  transcriptPath: string,
): TranscriptUsageSnapshot | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  // Walk backwards — the latest usage block is the most informative.
  // message_delta carries final output_tokens; message_start carries
  // the early snapshot with output_tokens=0. Either is useful; the
  // most recent one wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.trim().length === 0) continue;
    const parsed = tryParseLine(line);
    if (!parsed) continue;
    const usage = extractUsageFromEntry(parsed);
    if (usage) return usage;
  }
  return null;
}

/**
 * Pull a TranscriptUsageSnapshot out of a single JSONL entry if it
 * carries a `message_start` or `message_delta` stream_event. Returns
 * null for every other entry shape.
 */
function extractUsageFromEntry(entry: Record<string, unknown>): TranscriptUsageSnapshot | null {
  // Shape: {type: 'stream_event', event: {type: 'message_start', message: {usage: {...}}}}
  // or     {type: 'stream_event', event: {type: 'message_delta', usage: {...}}}
  // Claude Code forwards the Anthropic streaming protocol verbatim
  // into the JSONL transcript; daemon/harness/claude-code-stream.ts
  // already handles these shapes for live parsing.
  const event = entry.event;
  if (!event || typeof event !== 'object') return null;
  const evt = event as Record<string, unknown>;
  const eventType = evt.type;

  let rawUsage: unknown = null;
  if (eventType === 'message_start') {
    const message = evt.message;
    if (message && typeof message === 'object') {
      rawUsage = (message as Record<string, unknown>).usage;
    }
  } else if (eventType === 'message_delta') {
    rawUsage = evt.usage;
  }
  if (!rawUsage || typeof rawUsage !== 'object') return null;

  const u = rawUsage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const cacheReadInputTokens = num(u.cache_read_input_tokens);
  const cacheCreationInputTokens = num(u.cache_creation_input_tokens);

  // Drop the entry if no usage fields were present — prevents a
  // zero-everywhere snapshot from hiding a real next-match lower down
  // the file.
  if (
    u.input_tokens === undefined &&
    u.output_tokens === undefined &&
    u.cache_read_input_tokens === undefined &&
    u.cache_creation_input_tokens === undefined
  ) {
    return null;
  }

  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens };
}

// ─── Helpers ────────────────────────────────────────────────────────

function tryParseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Is this JSONL entry a user turn? Tries several known shapes:
 *   {type: 'user', ...}
 *   {role: 'user', ...}
 *   {message: {role: 'user'}, ...}
 * Excludes tool-result-only user messages (those aren't a fresh
 * prompt — they're Claude Code's internal plumbing between tool use
 * and tool result).
 */
function isUserTurn(entry: Record<string, unknown>): boolean {
  // Direct top-level type / role
  if (entry.type === 'user' || entry.role === 'user') {
    return !isToolResultEnvelope(entry);
  }
  // Nested message.role
  const msg = entry.message;
  if (msg && typeof msg === 'object' && (msg as Record<string, unknown>).role === 'user') {
    return !isToolResultEnvelope(msg as Record<string, unknown>);
  }
  return false;
}

/**
 * A "user" envelope whose content is entirely tool_result blocks is
 * not a fresh user prompt — it's Claude Code plumbing the tool result
 * back to Claude. We DON'T want to treat it as the scan boundary,
 * because then the agent's post-tool-result reasoning wouldn't count
 * as recent activity.
 */
function isToolResultEnvelope(entry: Record<string, unknown>): boolean {
  const blocks = [...iterateContentBlocks(entry)];
  if (blocks.length === 0) return false;
  return blocks.every((b) => b.type === 'tool_result');
}

/**
 * Yield content blocks from any of the known entry shapes. Handles:
 *   {content: [...]}
 *   {message: {content: [...]}}
 *   {message: {content: 'string'}} → yields {type: 'text', text: ...}
 */
function* iterateContentBlocks(entry: Record<string, unknown>): Generator<Record<string, unknown>> {
  const message = entry.message;
  const content =
    Array.isArray(entry.content) ? entry.content :
    message && typeof message === 'object' && Array.isArray((message as Record<string, unknown>).content) ?
      ((message as Record<string, unknown>).content as unknown[]) :
    null;

  if (!content) {
    // String content at message.content is a plain-text shape.
    const str =
      typeof entry.content === 'string' ? entry.content :
      message && typeof message === 'object' && typeof (message as Record<string, unknown>).content === 'string' ?
        ((message as Record<string, unknown>).content as string) :
      null;
    if (str) yield { type: 'text', text: str };
    return;
  }

  for (const block of content) {
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      yield block as Record<string, unknown>;
    }
  }
}

/**
 * Extract a file path from a tool-use input if the tool operates on
 * files. Normalizes `file_path` and `path` keys (both appear in
 * Claude Code tool specs).
 */
function extractFilePathFromInput(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (!TOUCH_TOOLS.has(toolName)) return null;
  const p = input.file_path ?? input.path ?? input.notebook_path;
  return typeof p === 'string' ? p : null;
}

/**
 * Stringify tool_result content for storage on the ToolCall. Claude
 * Code sometimes ships content as a string, sometimes as an array of
 * text blocks. Collapse to a single string for scanner heuristics
 * that look for "PASS" / "FAIL" / error markers.
 */
function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && 'text' in b) {
          return String((b as Record<string, unknown>).text);
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

/** Cap tool-result content to keep audit memory bounded. */
function truncate(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[… truncated ${s.length - max} chars]`;
}
