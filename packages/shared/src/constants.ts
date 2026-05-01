import { join } from 'node:path';
import { homedir } from 'node:os';

export const CLAUDECORP_HOME = join(homedir(), '.claudecorp');
export const OPENCLAW_HOME = join(homedir(), '.openclaw');
export const GLOBAL_CONFIG_PATH = join(CLAUDECORP_HOME, 'global-config.json');
export const CORPS_INDEX_PATH = join(CLAUDECORP_HOME, 'corps', 'index.json');
export const DAEMON_PID_PATH = join(CLAUDECORP_HOME, '.daemon.pid');
export const DAEMON_PORT_PATH = join(CLAUDECORP_HOME, '.daemon.port');

/**
 * Per-corp daemon log path. Each corp writes to its OWN
 * `<corpRoot>/.daemon.log`, so test fixture daemons (running
 * out of `C:\tmp\test-corp` etc.) never collide with a real
 * corp's log file. The TUI's log viewer + `cc-cli logs` resolve
 * the active corp's root and read from there.
 *
 * The previous global `DAEMON_LOG_PATH` (~/.claudecorp/.daemon.log)
 * was a single file every daemon instance — production AND test —
 * appended to, which polluted production logs with hundreds of
 * fixture lines whenever `pnpm test` ran. Per-corp scoping is the
 * proper fix: corp's log lives with the corp.
 */
export function getDaemonLogPath(corpRoot: string): string {
  return join(corpRoot, '.daemon.log');
}

export const DEFAULT_PORT_RANGE: [number, number] = [18800, 18999];
/**
 * Fallback model when no gateway config exists.
 * In practice, the corp gateway inherits from ~/.openclaw/openclaw.json,
 * so this is only used during first-run scaffolding.
 */
export const DEFAULT_MODEL = 'gpt-5.4';
export const DEFAULT_PROVIDER = 'openai-codex';
export const DEFAULT_LOG_LEVEL = 'info' as const;

export const MAX_DEPTH = 0; // 0 = unlimited agent-to-agent depth
export const COOLDOWN_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export const CORP_JSON = 'corp.json';
export const MEMBERS_JSON = 'members.json';
export const CHANNELS_JSON = 'channels.json';
export const MESSAGES_JSONL = 'messages.jsonl';

/**
 * Bacteria-events log (Project 1.10.4) — append-only stream at the
 * corp root. One JSON object per line, written by the daemon's
 * bacteria executor on every mitose/apoptose. Read by status command,
 * lineage view, Sexton's wake summaries, TUI sidebar aggregation.
 */
export const BACTERIA_EVENTS_JSONL = 'bacteria-events.jsonl';

/**
 * Bacteria pause registry — corp-scope set of role ids the bacteria
 * decision module skips entirely (no mitose, no apoptose). Founder-
 * controlled via `cc-cli bacteria pause/resume`. Shape:
 * `{ paused: string[] }`.
 */
export const BACTERIA_PAUSED_JSON = 'bacteria-paused.json';

/**
 * Project 1.12: Clearinghouse lock state. Singleton corp-scope JSON
 * tracking which Pressman currently holds the merge lane. Tiny JSON
 * (single object) instead of a chit type — same reasoning as bacteria-
 * paused: it's runtime daemon state, not a work record. Audit trail
 * comes from logs + step-log chits referencing the lock.
 *
 * Shape: `{ heldBy: string | null, claimedAt: string | null,
 * submissionId: string | null }`.
 */
export const CLEARINGHOUSE_LOCK_JSON = 'clearinghouse-lock.json';

export const SYSTEM_CHANNELS = ['general', 'tasks', 'logs'] as const;

export const GITIGNORE_CONTENT = `# Agent secrets (injected by daemon, never committed)
auth-profiles.json

# Corp gateway runtime state (OpenClaw workspaces, sessions, configs)
.gateway/

# Agent git worktrees
wt/

# Runtime state (daemon, not version-controlled)
inbox-state.json
analytics.json

# OS
.DS_Store
Thumbs.db

# Node
node_modules/
`;
