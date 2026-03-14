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
    const oc = readConfig<{ gateway?: { port?: number; auth?: { token?: string } } }>(openclawConfigPath);
    const port = oc.gateway?.port;
    const token = oc.gateway?.auth?.token;
    if (port && token) {
      return { port, token };
    }
  } catch {
    // Malformed config — ignore
  }
  return undefined;
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
