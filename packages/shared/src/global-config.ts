import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GlobalConfig } from './types/index.js';
import { readConfig, writeConfig } from './parsers/config.js';
import {
  AGENTCORP_HOME,
  GLOBAL_CONFIG_PATH,
  CORPS_INDEX_PATH,
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

  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    writeConfig(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG);
    return { ...DEFAULT_GLOBAL_CONFIG };
  }

  return readConfig<GlobalConfig>(GLOBAL_CONFIG_PATH);
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
