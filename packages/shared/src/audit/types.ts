/**
 * Types for the 0.7.3 Audit Gate. These are the contracts the pure
 * audit-engine function speaks in; the cc-cli audit command builds
 * values of these shapes from I/O at the boundary.
 *
 * HookInput mirrors what Claude Code passes to a Stop / PreCompact
 * hook on stdin. The fields we lock down here are the documented ones
 * from https://code.claude.com/docs/en/hooks.md as of 2026-04-22.
 * The probe at `scripts/audit-gate-probe/` captures the real shape
 * per-invocation in `.probe-stdin.jsonl` — when a future Claude Code
 * version adds or renames fields, the probe's diagnostic log makes
 * the drift visible before it breaks production.
 *
 * AuditDecision is what the audit engine returns; `cc-cli audit`
 * serializes it to stdout as the JSON Claude Code's hook protocol
 * consumes. `{decision: "approve"}` lets the stop proceed;
 * `{decision: "block", reason: "..."}` keeps the session alive and
 * surfaces the reason as `Stop hook error: <reason>` in the agent's
 * next turn (verified live in PR #159 probe run).
 */

import type { Chit } from '../types/chit.js';

/**
 * Claude Code hook event names the audit gate participates in. Stop
 * fires at the end of every assistant turn; PreCompact fires before a
 * Partner's `/compact` summarization. Same audit logic runs for both
 * with one cosmetic branch — the audit prompt's "exit primitive" line
 * says "run `cc-cli done`" for Stop+Employee, "/compact"
 * for PreCompact+Partner, etc.
 *
 * `unknown` lets the engine accept future event names without crashing
 * — pragmatic forwards-compat. An unknown event is treated as Stop
 * semantics with a warning logged to audit errors.
 */
export type HookEventName =
  | 'Stop'
  | 'PreCompact'
  | 'SessionStart'
  | 'UserPromptSubmit';

/**
 * Hook input shape Claude Code writes to stdin at hook invocation.
 * Documented fields locked down as required; unknown future fields
 * are ignored (engine looks up by name, doesn't iterate).
 */
export interface HookInput {
  /** Current working directory at hook invocation (workspace root). */
  cwd?: string;
  /**
   * Unique session id for the claude-code conversation. Stable across
   * a single session; changes on fresh session boot. Audit logs key
   * off this for per-session dedup + observability.
   */
  session_id?: string;
  /**
   * Absolute path to the session's JSONL transcript — the append-only
   * log Claude Code writes every user message, assistant turn, and
   * tool-use-pair to. The audit's evidence scanner reads this to see
   * what the agent actually did since the last user prompt.
   */
  transcript_path?: string;
  /** The hook event that triggered this invocation. */
  hook_event_name?: HookEventName | string;
  /**
   * Anti-loop flag. Set to `true` when a previous Stop hook has
   * already blocked in this stop cycle — the audit MUST approve when
   * this is true, otherwise every turn-end re-audits and eventually
   * re-blocks, creating an infinite loop Claude Code's contract
   * intentionally prevents. Observed live in PR #159 probe.
   */
  stop_hook_active?: boolean;
  /**
   * PreCompact-only discriminator. `"manual"` means the user typed
   * `/compact`; `"auto"` means Claude Code auto-compacted due to
   * context pressure. The audit can choose to be more permissive on
   * auto-compact (the alternative is crashing the session on context
   * overflow), but v1 treats both the same.
   */
  trigger?: 'manual' | 'auto';
  /**
   * Allow unknown fields through without type errors. Claude Code
   * may add more context in future versions; we capture it all in
   * the probe's .probe-stdin.jsonl for future reference.
   */
  [key: string]: unknown;
}

/**
 * The audit engine's verdict. Shape matches Claude Code's expected
 * hook-return JSON exactly — `cc-cli audit` does a bare
 * `JSON.stringify(decision) + "\n"` to stdout with exit 0.
 */
export interface AuditDecision {
  decision: 'approve' | 'block';
  /**
   * Required when decision === 'block'; ignored on approve. Surfaces
   * to the agent as "Stop hook error: <reason>" — write it as
   * actionable guidance, not an opaque error message.
   */
  reason?: string;
}

/**
 * Canonicalized "what happened in the last stretch of the session"
 * structure the evidence scanner operates on. cc-cli audit builds
 * this at the boundary from either the Claude Code session transcript
 * (Partners; transcript_path-sourced) or the Employee's WORKLOG.md
 * (Employees; file-sourced). The engine doesn't care which source —
 * same shape in both cases.
 */
export interface RecentActivity {
  /** Tool calls made since the last user message / session reset. */
  toolCalls: ToolCall[];
  /**
   * Files the agent read, wrote, or edited — de-duplicated from the
   * tool call stream. Exposed separately because the file-read-back
   * check is a common evidence pattern ("did you re-read the file you
   * claimed to write?").
   */
  touchedFiles: TouchedFile[];
  /**
   * Recent free-text content the assistant generated. Not load-bearing
   * for evidence checks (we key off tool calls, not prose), but
   * available for heuristics that want to detect completion claims.
   */
  assistantText?: string[];
}

export interface ToolCall {
  /** Canonical tool name (Bash, Edit, Write, Read, Grep, Glob, etc.). */
  name: string;
  /**
   * Arguments the agent passed. Types vary by tool; audit scanners
   * cast to the tool's specific shape when they need to. Common
   * patterns: Bash has `command`, Edit/Write/Read have `file_path`.
   */
  input: Record<string, unknown>;
  /**
   * Truncated tool result content. Kept for "was the build PASS or
   * FAIL" style evidence checks, but capped to keep audit memory
   * bounded. Full result lives in the transcript for callers who
   * need it.
   */
  output?: string;
  /** True if the tool reported failure (tool-use `is_error: true`). */
  isError?: boolean;
}

export interface TouchedFile {
  path: string;
  /** Which tools interacted with it, in order. */
  via: Array<'Read' | 'Write' | 'Edit' | 'MultiEdit' | 'NotebookEdit'>;
}

/**
 * Full input to `runAudit(...)`. Everything the pure decision function
 * needs — no I/O inside the engine, all sourcing happens at the
 * cc-cli audit boundary.
 */
export interface AuditInput {
  /** Anti-loop flag from hook input. Short-circuits to approve. */
  stopHookActive: boolean;
  /**
   * The agent's current Task chit — null when Casket is idle (nothing
   * to audit) or undefined when Casket doesn't exist (substrate gap,
   * fail-open). Engine distinguishes the two: idle → approve cleanly,
   * substrate-gap → approve with a log.
   */
  currentTask: Chit<'task'> | null | undefined;
  /** Open Tier-3 inbox items scoped to this agent. Hard-gate on presence. */
  openTier3Inbox: Chit<'inbox-item'>[];
  /** Recent session activity — what the agent did in the last stretch. */
  recent: RecentActivity;
  /** Which hook triggered this — shapes the prompt's exit-primitive line. */
  event: HookEventName;
  /** Agent kind — Partners compact; Employees hand-complete. */
  kind: 'partner' | 'employee';
  /** Agent display name — for readability of the audit prompt header. */
  agentDisplayName: string;
}
