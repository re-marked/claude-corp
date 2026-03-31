import { join } from 'node:path';
import {
  type Member,
  type Channel,
  readConfig,
  readConfigOr,
  listCorps,
  findCorp,
  MEMBERS_JSON,
  CHANNELS_JSON,
} from '@claudecorp/shared';
import { isDaemonRunning, DaemonClient } from '@claudecorp/daemon';

/** Get a connected DaemonClient or exit with error. Shows which corp is active. */
export function getClient(silent = false): DaemonClient {
  const { running, port } = isDaemonRunning();
  if (!running || !port) {
    console.error('Daemon is not running. Restart the TUI or run:');
    console.error('  npx tsx packages/tui/src/index.tsx');
    process.exit(1);
  }
  return new DaemonClient(port);
}

/** Verify the daemon is serving the expected corp. Warn if --corp doesn't match. */
export async function verifyCorpMatch(client: DaemonClient, requestedCorp?: string): Promise<string> {
  const status = await client.status();
  const activeCorp = status.corpRoot;
  const corpName = activeCorp.split(/[/\\]/).pop() ?? activeCorp;

  if (requestedCorp && !activeCorp.includes(requestedCorp)) {
    console.error(`Warning: --corp "${requestedCorp}" specified but daemon is serving "${corpName}" (${activeCorp})`);
    console.error(`Stop the daemon and restart with: cc-cli stop && cc-cli start --corp ${requestedCorp}`);
    process.exit(1);
  }

  return activeCorp;
}

/** Resolve the active corp root path — prefers the running daemon's corp. */
export async function getCorpRoot(corpName?: string): Promise<string> {
  if (corpName) {
    const path = findCorp(corpName);
    if (!path) {
      console.error(`Corp "${corpName}" not found.`);
      const corps = listCorps();
      if (corps.length > 0) {
        console.error('Available corps:');
        for (const c of corps) console.error(`  ${c.name}`);
      }
      process.exit(1);
    }
    return path;
  }
  // Ask the running daemon which corp it's serving
  const { running, port } = isDaemonRunning();
  if (running && port) {
    try {
      const client = new DaemonClient(port);
      const status = await client.status();
      if (status.corpRoot) return status.corpRoot;
    } catch {}
  }
  // Multiple corps with no daemon — can't silently pick one
  const corps = listCorps();
  if (corps.length === 0) {
    console.error('No corporations found. Create one with: cc-cli init');
    process.exit(1);
  }
  if (corps.length > 1) {
    console.error('Multiple corporations found. Specify which one with --corp:');
    for (const c of corps) console.error(`  ${c.name.padEnd(20)} ${c.path}`);
    console.error('\nOr start a daemon first: cc-cli start --corp <name>');
    process.exit(1);
  }
  return corps[0]!.path;
}

/** Resolve a channel by name within a corp. */
export function resolveChannel(corpRoot: string, channelName: string): Channel {
  const channels = readConfigOr<Channel[]>(join(corpRoot, CHANNELS_JSON), []);
  // Try exact match first, then partial/contains
  const ch = channels.find((c) => c.name === channelName)
    ?? channels.find((c) => c.name.includes(channelName));
  if (!ch) {
    console.error(`Channel "${channelName}" not found. Available: ${channels.map((c) => c.name).join(', ')}`);
    process.exit(1);
  }
  return ch;
}

/** Get all members from corp. */
export function getMembers(corpRoot: string): Member[] {
  return readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);
}

/** Get the founder member. */
export function getFounder(corpRoot: string): Member {
  const members = getMembers(corpRoot);
  const founder = members.find((m) => m.rank === 'owner');
  if (!founder) {
    console.error('No founder found in members.json');
    process.exit(1);
  }
  return founder;
}

/** Get the CEO member. */
export function getCeo(corpRoot: string): Member | undefined {
  return getMembers(corpRoot).find((m) => m.rank === 'master');
}
