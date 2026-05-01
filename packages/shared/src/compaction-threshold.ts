/**
 * Pure threshold math for Project 1.7's pre-compact signal. Mirrors
 * Claude Code's autocompact formula so our signal fires predictably
 * relative to their trigger.
 *
 * ### Source of truth (leak-verified, March 2026)
 *
 * From `services/compact/autoCompact.ts`:
 *
 *   AUTOCOMPACT_BUFFER_TOKENS = 13_000
 *     Claude Code's autocompact fires when tokenUsage >=
 *     (effectiveWindow - 13k). This is "time to summarize — not
 *     enough room left for one more heavy turn."
 *
 *   MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
 *     Reserved from the context window for the summary response.
 *     p99.99 of actual summary outputs lands at ~17k tokens; 20k is
 *     the safety ceiling. `effectiveWindow = contextWindow - 20k` is
 *     what the model actually has for dialogue.
 *
 * ### Claude Corp addition
 *
 *   PRE_COMPACT_SIGNAL_BUFFER_TOKENS = 30_000
 *     OUR pre-compact signal fires when tokenUsage >=
 *     (effectiveWindow - 30k). That's 17k earlier than Claude Code's
 *     own warning (which fires at 20k-remaining). The extra runway
 *     gives the Partner time to `cc-cli observe`, update BRAIN/, and
 *     stamp `output` on their current task before compression —
 *     soul material that lives outside the raw context gets
 *     preserved deliberately, not scraped together by the
 *     summarization model's best guess.
 *
 * Pure module — no I/O, no stateful singletons. `calculateCompaction
 * Threshold(tokens, model)` returns a frozen result; callers cache
 * as they wish.
 */

/** Claude Code's autocompact fires at (effectiveWindow - this). */
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/** Reserved output budget for the summarization response. */
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;

/** Claude Corp's pre-compact signal fires at (effectiveWindow - this). */
const PRE_COMPACT_SIGNAL_BUFFER_TOKENS = 30_000;

/**
 * Per-model context window in tokens. Values come from public model
 * cards — conservative defaults for unknown model ids land on the
 * 200k standard so the threshold math still produces sane numbers
 * (better to trigger signal slightly early on an unknown model than
 * to skip it entirely).
 *
 * Kept internal — callers pass the model id, we resolve here. When
 * Claude Corp's KNOWN_MODELS registry grows a contextWindow field,
 * this can delegate to it.
 */
function getContextWindowForModel(model: string): number {
  const m = model.toLowerCase();
  // Opus 4.7 ships with 1M context as the default.
  if (m.includes('opus-4-7')) return 1_000_000;
  // Opus 4.x with explicit 1M tag in the id.
  if (m.includes('opus-4') && (m.includes('1m') || m.includes('[1m]'))) return 1_000_000;
  // Sonnet 4.6 1M context.
  if (m.includes('sonnet-4-6') && m.includes('1m')) return 1_000_000;
  // Everything else — standard 200k Claude context window.
  return 200_000;
}

export interface CompactionThresholdState {
  /** Current session token usage — typically latest `inputTokens` from a usage event. */
  readonly tokens: number;
  /** Model id the calculation was keyed on (for logging / display). */
  readonly model: string;
  /** Nominal context window per the model card. */
  readonly contextWindow: number;
  /** Context window minus the summary-output reservation. */
  readonly effectiveWindow: number;
  /** Token count at which Claude Code's autocompact fires. */
  readonly autoCompactAt: number;
  /** Token count at which our pre-compact signal should fire. */
  readonly ourSignalAt: number;
  /**
   * True when tokens is in `[ourSignalAt, autoCompactAt)` — time to
   * emit the agent-facing "crystallize your memories" fragment. The
   * fragment reads this flag and renders accordingly.
   */
  readonly inSignalWindow: boolean;
  /**
   * True when tokens is past autoCompactAt — autocompact either just
   * fired or is about to. Signal is moot; we missed the window.
   * Callers log this for "signal came too late" diagnostics.
   */
  readonly pastAutoCompact: boolean;
  /** Tokens remaining before autocompact would fire. 0 when past. */
  readonly tokensUntilAutoCompact: number;
  /**
   * Fraction of effective window currently used (0..1, can exceed 1
   * when past auto-compact). Useful for rendering "X% full" in the
   * agent-facing signal text without exposing raw numbers.
   */
  readonly fractionFull: number;
}

/**
 * Compute the compaction-threshold state for a given token count +
 * model. Pure, deterministic, no I/O. Returns a frozen result — no
 * caller can mutate the shared state into an inconsistent shape.
 */
export function calculateCompactionThreshold(
  tokens: number,
  model: string,
): CompactionThresholdState {
  const contextWindow = getContextWindowForModel(model);
  const effectiveWindow = contextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY;
  const autoCompactAt = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
  const ourSignalAt = effectiveWindow - PRE_COMPACT_SIGNAL_BUFFER_TOKENS;
  const pastAutoCompact = tokens >= autoCompactAt;
  const inSignalWindow = tokens >= ourSignalAt && !pastAutoCompact;
  const tokensUntilAutoCompact = Math.max(0, autoCompactAt - tokens);
  const fractionFull = effectiveWindow > 0 ? tokens / effectiveWindow : 0;

  return Object.freeze({
    tokens,
    model,
    contextWindow,
    effectiveWindow,
    autoCompactAt,
    ourSignalAt,
    inSignalWindow,
    pastAutoCompact,
    tokensUntilAutoCompact,
    fractionFull,
  });
}

/**
 * Short human-readable summary — useful for log lines and the agent-
 * facing fragment's header. Format matches Claude Code's native
 * "X% context remaining" style so agents can cross-reference.
 *
 * Example output: "47k / 180k tokens (26% full, 63k until autocompact)"
 */
export function formatThresholdSummary(state: CompactionThresholdState): string {
  const thousands = (n: number): string => `${Math.round(n / 1_000)}k`;
  const pct = Math.round(state.fractionFull * 100);
  return (
    `${thousands(state.tokens)} / ${thousands(state.effectiveWindow)} tokens ` +
    `(${pct}% full, ${thousands(state.tokensUntilAutoCompact)} until autocompact)`
  );
}
