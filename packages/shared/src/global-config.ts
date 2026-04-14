import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GlobalConfig } from './types/index.js';
import { readConfig, readConfigOr, writeConfig } from './parsers/config.js';
import { parseProviderModel } from './models.js';
import {
  CLAUDECORP_HOME,
  GLOBAL_CONFIG_PATH,
  CORPS_INDEX_PATH,
  OPENCLAW_HOME,
  DEFAULT_PORT_RANGE,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_LOG_LEVEL,
} from './constants.js';

const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  apiKeys: {},
  daemon: {
    portRange: DEFAULT_PORT_RANGE,
    logLevel: DEFAULT_LOG_LEVEL,
  },
  defaults: {
    model: DEFAULT_MODEL,
    provider: DEFAULT_PROVIDER,
  },
};

export function ensureClaudeCorpHome(): void {
  mkdirSync(CLAUDECORP_HOME, { recursive: true });
  mkdirSync(dirname(CORPS_INDEX_PATH), { recursive: true });
}

export function ensureGlobalConfig(): GlobalConfig {
  ensureClaudeCorpHome();

  let config: GlobalConfig;
  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    writeConfig(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG);
    config = { ...DEFAULT_GLOBAL_CONFIG };
  } else {
    config = readConfig<GlobalConfig>(GLOBAL_CONFIG_PATH);
  }

  // Inherit gateway + default model from user's OpenClaw install (single source of truth).
  // OpenClaw's openclaw.json is authoritative — the claude-corp global-config.json defaults
  // are only a bootstrap fallback when OpenClaw hasn't been configured yet.
  const inherited = readOpenClawInheritance();
  if (inherited) {
    if (inherited.gateway && !config.userGateway) {
      config.userGateway = inherited.gateway;
    }
    if (inherited.defaultModel) {
      config.defaults.model = inherited.defaultModel.model;
      config.defaults.provider = inherited.defaultModel.provider;
    }
  }

  return config;
}

interface OpenClawInheritance {
  gateway?: { port: number; token: string };
  defaultModel?: { provider: string; model: string };
}

/** Read user's OpenClaw config once; extract gateway + default model. */
function readOpenClawInheritance(): OpenClawInheritance | undefined {
  const openclawConfigPath = join(OPENCLAW_HOME, 'openclaw.json');
  if (!existsSync(openclawConfigPath)) return undefined;

  try {
    const oc = readConfig<Record<string, unknown>>(openclawConfigPath);

    // Gateway (port + auth token)
    const gw = oc.gateway as Record<string, unknown> | undefined;
    const port = gw?.port as number | undefined;
    const auth = gw?.auth as Record<string, unknown> | undefined;
    const token = auth?.token as string | undefined;
    const gateway = port && token ? { port, token } : undefined;

    // Default model (agents.defaults.model.primary → "provider/model")
    const agents = oc.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const modelObj = defaults?.model as Record<string, unknown> | undefined;
    const primary = modelObj?.primary as string | undefined;
    let defaultModel: { provider: string; model: string } | undefined;
    if (primary) {
      const parsed = parseProviderModel(primary);
      if (parsed.provider && parsed.model) defaultModel = parsed;
    }

    // Only patch verbose settings if gateway is usable (avoids spurious writes)
    if (gateway) patchOpenClawVerbose(openclawConfigPath, oc);

    if (!gateway && !defaultModel) return undefined;
    return { gateway, defaultModel };
  } catch {
    // Malformed config — ignore
    return undefined;
  }
}

/** Ensure user's OpenClaw has verbose full + streaming off for Claude Corp. */
function patchOpenClawVerbose(configPath: string, oc: Record<string, unknown>): void {
  try {
    const agents = (oc.agents ?? {}) as Record<string, unknown>;
    const defaults = (agents.defaults ?? {}) as Record<string, unknown>;

    let changed = false;
    if (defaults.verboseDefault !== 'full') {
      defaults.verboseDefault = 'full';
      changed = true;
    }
    if (defaults.blockStreamingDefault !== 'off') {
      defaults.blockStreamingDefault = 'off';
      changed = true;
    }

    if (changed) {
      agents.defaults = defaults;
      oc.agents = agents;
      writeConfig(configPath, oc);
    }
  } catch {
    // Non-fatal — don't break startup if we can't patch
  }
}

export function readGlobalConfig(): GlobalConfig {
  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    return { ...DEFAULT_GLOBAL_CONFIG };
  }
  return readConfig<GlobalConfig>(GLOBAL_CONFIG_PATH);
}

export function writeGlobalConfig(config: GlobalConfig): void {
  ensureClaudeCorpHome();
  writeConfig(GLOBAL_CONFIG_PATH, config);
}
