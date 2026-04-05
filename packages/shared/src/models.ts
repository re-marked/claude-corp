/**
 * Model resolution utilities — provider-agnostic.
 *
 * OpenClaw is fully provider-agnostic: Anthropic, OpenAI, Google, Mistral,
 * open-weight models, anything with an API. Claude Corp mirrors this —
 * any model string the user's gateway supports is valid.
 *
 * KNOWN_MODELS is a convenience list for UIs (hire wizard, /model picker).
 * It does NOT restrict what models can be used. Unknown model strings
 * are passed through as-is to OpenClaw.
 */

export interface ModelEntry {
  id: string;
  provider: string;
  alias: string;
  displayName: string;
}

export const KNOWN_MODELS: ModelEntry[] = [
  // ── Anthropic ────────────────────────────────────────────────
  { id: 'claude-opus-4-6', provider: 'anthropic', alias: 'opus', displayName: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', provider: 'anthropic', alias: 'sonnet', displayName: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', provider: 'anthropic', alias: 'haiku', displayName: 'Claude Haiku 4.5' },
  // ── OpenAI (direct API) ──────────────────────────────────────
  { id: 'openai/gpt-5.4', provider: 'openai', alias: 'gpt-5.4', displayName: 'GPT-5.4' },
  { id: 'openai/gpt-5.4-mini', provider: 'openai', alias: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini' },
  { id: 'openai/gpt-5.4-nano', provider: 'openai', alias: 'gpt-5.4-nano', displayName: 'GPT-5.4 Nano' },
  // ── OpenAI Codex (ChatGPT subscription) ──────────────────────
  { id: 'openai-codex/gpt-5.4', provider: 'openai-codex', alias: 'codex', displayName: 'GPT-5.4 (Codex)' },
  { id: 'openai-codex/gpt-5.3-codex', provider: 'openai-codex', alias: 'codex-5.3', displayName: 'GPT-5.3 Codex' },
  // ── Google ───────────────────────────────────────────────────
  { id: 'google/gemini-3.1-pro-preview', provider: 'google', alias: 'gemini-pro', displayName: 'Gemini 3.1 Pro' },
  { id: 'google/gemini-3.1-flash-lite-preview', provider: 'google', alias: 'gemini-flash', displayName: 'Gemini 3.1 Flash Lite' },
  // ── Meta (open-weight) ───────────────────────────────────────
  { id: 'meta/llama-4-maverick', provider: 'meta', alias: 'maverick', displayName: 'Llama 4 Maverick' },
  { id: 'meta/llama-4-scout', provider: 'meta', alias: 'scout', displayName: 'Llama 4 Scout' },
  // ── DeepSeek ─────────────────────────────────────────────────
  { id: 'deepseek/deepseek-chat', provider: 'deepseek', alias: 'deepseek', displayName: 'DeepSeek Chat' },
  { id: 'deepseek/deepseek-reasoner', provider: 'deepseek', alias: 'deepseek-r', displayName: 'DeepSeek Reasoner' },
  // ── xAI ──────────────────────────────────────────────────────
  { id: 'xai/grok-4.20-beta-0309-reasoning', provider: 'xai', alias: 'grok', displayName: 'Grok 4.20' },
];

/** Default fallback chain — empty means inherit from gateway config. */
export const DEFAULT_FALLBACK_CHAIN: string[] = [];

/**
 * Resolve a user-friendly alias to a canonical model ID.
 * Handles: aliases ("opus"), full IDs ("claude-opus-4-6"),
 * provider-prefixed ("openai/gpt-5.4"), and passthrough for unknown models.
 */
export function resolveModelAlias(input: string): string {
  const trimmed = input.trim();

  // If it contains a "/" it's already provider-prefixed — check known models first
  if (trimmed.includes('/')) {
    const direct = KNOWN_MODELS.find(m => m.id === trimmed);
    if (direct) return direct.id;
    // Unknown provider/model — pass through as-is (OpenClaw will handle it)
    return trimmed;
  }

  const lower = trimmed.toLowerCase();

  // Direct match on ID (e.g. "claude-opus-4-6")
  const direct = KNOWN_MODELS.find(m => m.id === lower || m.id.endsWith('/' + lower));
  if (direct) return direct.id;

  // Match on alias (e.g. "opus", "codex", "gemini-pro")
  const byAlias = KNOWN_MODELS.find(m => m.alias === lower);
  if (byAlias) return byAlias.id;

  // Partial match — "opus" matches "claude-opus-4-6", "gemini" matches "gemini-2.5-pro"
  const partial = KNOWN_MODELS.find(m =>
    m.id.includes(lower) || m.alias.includes(lower) || m.displayName.toLowerCase().includes(lower),
  );
  if (partial) return partial.id;

  // Unknown model — return as-is (user might know a model we don't)
  return trimmed;
}

/** Get a ModelEntry by ID. */
export function getModelEntry(id: string): ModelEntry | undefined {
  return KNOWN_MODELS.find(m => m.id === id);
}

/** Format "anthropic/claude-opus-4-6" from provider + model. */
export function formatProviderModel(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** Parse "openai-codex/gpt-5.4" → { provider, model }. Bare model names get empty provider. */
export function parseProviderModel(combined: string): { provider: string; model: string } {
  const slashIdx = combined.indexOf('/');
  if (slashIdx === -1) return { provider: '', model: combined };
  return {
    provider: combined.slice(0, slashIdx),
    model: combined.slice(slashIdx + 1),
  };
}

/** Get display-friendly name for a model ID. */
export function modelDisplayName(id: string): string {
  const entry = getModelEntry(id);
  return entry?.displayName ?? id;
}

/** Get short alias for a model ID. */
export function modelAlias(id: string): string {
  const entry = getModelEntry(id);
  return entry?.alias ?? id;
}
