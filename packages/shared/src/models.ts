/**
 * Model resolution utilities — aliases, known models, fallback chain.
 */

export interface ModelEntry {
  id: string;
  provider: string;
  alias: string;
  displayName: string;
}

export const KNOWN_MODELS: ModelEntry[] = [
  { id: 'claude-opus-4-6', provider: 'anthropic', alias: 'opus', displayName: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', provider: 'anthropic', alias: 'sonnet', displayName: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', provider: 'anthropic', alias: 'haiku', displayName: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-4-5-20250929', provider: 'anthropic', alias: 'sonnet-4-5', displayName: 'Claude Sonnet 4.5' },
  { id: 'claude-3-5-haiku-20241022', provider: 'anthropic', alias: 'haiku-3-5', displayName: 'Claude Haiku 3.5' },
];

export const DEFAULT_FALLBACK_CHAIN = ['claude-sonnet-4-6', 'claude-haiku-4-5'];

/** Resolve a user-friendly alias to a canonical model ID. */
export function resolveModelAlias(input: string): string | null {
  const lower = input.toLowerCase().trim();

  // Direct match on ID
  const direct = KNOWN_MODELS.find(m => m.id === lower);
  if (direct) return direct.id;

  // Match on alias
  const byAlias = KNOWN_MODELS.find(m => m.alias === lower);
  if (byAlias) return byAlias.id;

  // Partial match — "opus" matches "claude-opus-4-6"
  const partial = KNOWN_MODELS.find(m =>
    m.id.includes(lower) || m.alias.includes(lower) || m.displayName.toLowerCase().includes(lower),
  );
  if (partial) return partial.id;

  // Unknown model — return as-is (user might know a model we don't)
  return input;
}

/** Get a ModelEntry by ID. */
export function getModelEntry(id: string): ModelEntry | undefined {
  return KNOWN_MODELS.find(m => m.id === id);
}

/** Format "anthropic/claude-opus-4-6" from provider + model. */
export function formatProviderModel(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** Parse "anthropic/claude-opus-4-6" → { provider, model }. */
export function parseProviderModel(combined: string): { provider: string; model: string } {
  const slashIdx = combined.indexOf('/');
  if (slashIdx === -1) return { provider: 'anthropic', model: combined };
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
