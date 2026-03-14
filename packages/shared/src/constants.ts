import { join } from 'node:path';
import { homedir } from 'node:os';

export const AGENTCORP_HOME = join(homedir(), '.agentcorp');
export const OPENCLAW_HOME = join(homedir(), '.openclaw');
export const GLOBAL_CONFIG_PATH = join(AGENTCORP_HOME, 'global-config.json');
export const CORPS_INDEX_PATH = join(AGENTCORP_HOME, 'corps', 'index.json');
export const DAEMON_PID_PATH = join(AGENTCORP_HOME, '.daemon.pid');
export const DAEMON_PORT_PATH = join(AGENTCORP_HOME, '.daemon.port');
export const DAEMON_LOG_PATH = join(AGENTCORP_HOME, '.daemon.log');

export const DEFAULT_PORT_RANGE: [number, number] = [18800, 18999];
export const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_LOG_LEVEL = 'info' as const;

export const MAX_DEPTH = 5;
export const COOLDOWN_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export const CORP_JSON = 'corp.json';
export const MEMBERS_JSON = 'members.json';
export const CHANNELS_JSON = 'channels.json';
export const MESSAGES_JSONL = 'messages.jsonl';

export const SYSTEM_CHANNELS = ['general', 'system', 'heartbeat', 'tasks', 'errors'] as const;

export const GITIGNORE_CONTENT = `# Agent secrets (injected by daemon, never committed)
auth-profiles.json

# OS
.DS_Store
Thumbs.db

# Node
node_modules/
`;
