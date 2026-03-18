import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GlobalConfig } from './types/index.js';
import { readConfig, readConfigOr, writeConfig } from './parsers/config.js';
import {
  AGENTCORP_HOME,
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

export function ensureAgentCorpHome(): void {
  mkdirSync(AGENTCORP_HOME, { recursive: true });
  mkdirSync(dirname(CORPS_INDEX_PATH), { recursive: true });
}

export function ensureGlobalConfig(): GlobalConfig {
  ensureAgentCorpHome();

  let config: GlobalConfig;
  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    writeConfig(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG);
    config = { ...DEFAULT_GLOBAL_CONFIG };
  } else {
    config = readConfig<GlobalConfig>(GLOBAL_CONFIG_PATH);
  }

  // Auto-detect user's OpenClaw gateway (in-memory only, not persisted)
  if (!config.userGateway) {
    config.userGateway = detectUserGateway();
  }

  return config;
}

/** Read the user's OpenClaw config to find their running gateway */
function detectUserGateway(): GlobalConfig['userGateway'] {
  const openclawConfigPath = join(OPENCLAW_HOME, 'openclaw.json');
  if (!existsSync(openclawConfigPath)) return undefined;

  try {
    const oc = readConfig<Record<string, unknown>>(openclawConfigPath);
    const gw = oc.gateway as Record<string, unknown> | undefined;
    const port = gw?.port as number | undefined;
    const auth = gw?.auth as Record<string, unknown> | undefined;
    const token = auth?.token as string | undefined;

    if (port && token) {
      // Patch verbose + streaming settings for AgentCorp
      patchOpenClawVerbose(openclawConfigPath, oc);
      return { port, token };
    }
  } catch {
    // Malformed config — ignore
  }
  return undefined;
}

/** Ensure user's OpenClaw has verbose full + streaming off for AgentCorp. */
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
  ensureAgentCorpHome();
  writeConfig(GLOBAL_CONFIG_PATH, config);
}
