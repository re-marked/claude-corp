/**
 * Lightweight detection for which harnesses are usable on this machine.
 * Rendered by the onboarding + hire wizards + /harness modal so the user
 * sees available options at a glance without consulting docs.
 *
 * Detection is best-effort:
 *  - Claude Code: `claude` binary exists + responds to `--version` within
 *    a short timeout. We do NOT attempt to verify OAuth state — the claude
 *    CLI surfaces auth errors clearly if the subscription is logged out,
 *    and "installed but logged out" is rare enough that a fast detection
 *    path matters more than bulletproof verification.
 *  - OpenClaw: an Anthropic API key is present in the global config. We
 *    treat presence of any provider key as "OpenClaw is usable" since it
 *    dispatches through a provider-agnostic gateway.
 *
 * When detection is ambiguous (binary present, auth unknown) we still
 * mark the option available but include an honest subtitle so the user
 * can pick with eyes open.
 */

import { spawnSync } from 'node:child_process';
import type { GlobalConfig } from '@claudecorp/shared';

export type HarnessId = 'claude-code' | 'openclaw';

export interface HarnessOption {
  id: HarnessId;
  /** Short display name shown as the primary label. */
  displayName: string;
  /** One-line explanation of what this harness is. Shown below the name. */
  tagline: string;
  /** Whether this harness looks usable right now. Selectable either way. */
  available: boolean;
  /** Short detection note shown in dim color — "✓ Detected" / "⚠ ...". */
  note: string;
}

export function detectAvailableHarnesses(globalConfig: GlobalConfig): HarnessOption[] {
  const claudeCode = detectClaudeCode();
  const openclaw = detectOpenClaw(globalConfig);
  return [claudeCode, openclaw];
}

function detectClaudeCode(): HarnessOption {
  const base: Omit<HarnessOption, 'available' | 'note'> = {
    id: 'claude-code',
    displayName: 'Claude Code',
    tagline: 'Uses your Claude subscription via OAuth. Zero API token cost.',
  };

  try {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
      // Swallow stderr — we only care about whether it produced a version.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim().length > 0) {
      const version = result.stdout.trim().split(/\s+/)[0] ?? '';
      return { ...base, available: true, note: `✓ Detected (claude ${version})` };
    }
    return { ...base, available: false, note: '✗ `claude` binary not found on PATH' };
  } catch {
    return { ...base, available: false, note: '✗ `claude` binary not found on PATH' };
  }
}

function detectOpenClaw(globalConfig: GlobalConfig): HarnessOption {
  const base: Omit<HarnessOption, 'available' | 'note'> = {
    id: 'openclaw',
    displayName: 'OpenClaw',
    tagline: 'Uses an API key. Any provider — Anthropic, OpenAI, Google, Ollama.',
  };

  const keys = globalConfig.apiKeys ?? {};
  const anyKey =
    (keys.anthropic && keys.anthropic.trim().length > 0) ||
    (keys.openai && keys.openai.trim().length > 0) ||
    (keys.google && keys.google.trim().length > 0);

  if (anyKey) {
    const providers = [
      keys.anthropic ? 'anthropic' : null,
      keys.openai ? 'openai' : null,
      keys.google ? 'google' : null,
    ].filter(Boolean);
    return { ...base, available: true, note: `✓ API key set (${providers.join(', ')})` };
  }
  return { ...base, available: false, note: '⚠ No API key configured yet' };
}

/**
 * Pick the sensible default for a fresh corp: the first available harness,
 * with Claude Code preferred when both work (subscription auth is friendlier
 * than key management for a first-time user).
 */
export function defaultHarness(options: HarnessOption[]): HarnessId {
  const cc = options.find(o => o.id === 'claude-code' && o.available);
  if (cc) return 'claude-code';
  const oc = options.find(o => o.id === 'openclaw' && o.available);
  if (oc) return 'openclaw';
  // Nothing detected: still default to claude-code. It's what v2.0.0 was
  // built for, and the user will be told to install/auth if they pick it
  // and it fails.
  return 'claude-code';
}
