import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Corporation } from './types/corp.js';
import type { Member } from './types/member.js';
import type { Channel } from './types/channel.js';
import { generateId } from './id.js';
import { writeConfig } from './parsers/config.js';
import { corpGit } from './git.js';
import {
  AGENTCORP_HOME,
  CORPS_INDEX_PATH,
  CORP_JSON,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
  GITIGNORE_CONTENT,
} from './constants.js';
import { readConfigOr } from './parsers/config.js';

interface CorpsIndex {
  corps: { name: string; path: string }[];
}

export async function scaffoldCorp(
  corpName: string,
  userName: string,
): Promise<string> {
  const corpRoot = join(AGENTCORP_HOME, corpName);

  if (existsSync(corpRoot)) {
    throw new Error(`Corporation "${corpName}" already exists at ${corpRoot}`);
  }

  // Create directory structure
  const dirs = [
    corpRoot,
    join(corpRoot, 'agents'),
    join(corpRoot, 'channels', 'general'),
    join(corpRoot, 'channels', 'system'),
    join(corpRoot, 'channels', 'heartbeat'),
    join(corpRoot, 'channels', 'tasks'),
    join(corpRoot, 'channels', 'errors'),
    join(corpRoot, 'tasks'),
    join(corpRoot, 'projects'),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // IDs
  const userId = generateId();
  const now = new Date().toISOString();

  // corp.json
  const corp: Corporation = {
    name: corpName,
    displayName: corpName,
    owner: userId,
    ceo: null,
    description: '',
    createdAt: now,
  };
  writeConfig(join(corpRoot, CORP_JSON), corp);

  // members.json — just the founder for now
  const founder: Member = {
    id: userId,
    displayName: userName,
    rank: 'owner',
    status: 'active',
    type: 'user',
    scope: 'corp',
    scopeId: corpName,
    agentDir: null,
    port: null,
    spawnedBy: null,
    createdAt: now,
  };
  writeConfig(join(corpRoot, MEMBERS_JSON), [founder]);

  // channels.json — initial channels
  const channels: Channel[] = [
    makeChannel('general', 'broadcast', 'corp', corpName, userId, 'channels/general/', now),
    makeChannel('system', 'system', 'corp', corpName, userId, 'channels/system/', now),
    makeChannel('heartbeat', 'system', 'corp', corpName, userId, 'channels/heartbeat/', now),
    makeChannel('tasks', 'system', 'corp', corpName, userId, 'channels/tasks/', now),
    makeChannel('errors', 'system', 'corp', corpName, userId, 'channels/errors/', now),
  ];

  // Founder is auto-added to general
  channels[0]!.memberIds = [userId];

  writeConfig(join(corpRoot, CHANNELS_JSON), channels);

  // Create empty messages.jsonl in each channel
  for (const ch of channels) {
    writeFileSync(join(corpRoot, ch.path, MESSAGES_JSONL), '', 'utf-8');
  }

  // .gitignore
  writeFileSync(join(corpRoot, '.gitignore'), GITIGNORE_CONTENT, 'utf-8');

  // Initialize git and make first commit
  const git = corpGit(corpRoot);
  await git.init();
  await git.commitAll(`init: create corporation "${corpName}"`);

  // Register in corps index
  registerCorp(corpName, corpRoot);

  return corpRoot;
}

function makeChannel(
  name: string,
  kind: Channel['kind'],
  scope: Channel['scope'],
  scopeId: string,
  createdBy: string,
  path: string,
  createdAt: string,
): Channel {
  return {
    id: generateId(),
    name,
    kind,
    scope,
    scopeId,
    teamId: null,
    memberIds: [],
    createdBy,
    path,
    createdAt,
  };
}

function registerCorp(name: string, path: string): void {
  mkdirSync(join(AGENTCORP_HOME, 'corps'), { recursive: true });

  const index = readConfigOr<CorpsIndex>(CORPS_INDEX_PATH, { corps: [] });

  // Don't duplicate
  if (!index.corps.some((c) => c.name === name)) {
    index.corps.push({ name, path });
    writeConfig(CORPS_INDEX_PATH, index);
  }
}

export function listCorps(): { name: string; path: string }[] {
  const index = readConfigOr<CorpsIndex>(CORPS_INDEX_PATH, { corps: [] });
  // Filter out entries where the directory was deleted
  return index.corps.filter((c) => existsSync(c.path));
}

export function findCorp(name: string): string | null {
  const corps = listCorps();
  const found = corps.find((c) => c.name === name);
  return found?.path ?? null;
}
