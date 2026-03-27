import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Corporation } from './types/corp.js';
import type { Member } from './types/member.js';
import type { Channel } from './types/channel.js';
import { installDefaultSkills } from './skills.js';
import { getTheme, type ThemeId } from './themes.js';
import { generateId } from './id.js';
import { writeConfig } from './parsers/config.js';
import { corpGit } from './git.js';
import {
  CLAUDECORP_HOME,
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
  themeId: ThemeId = 'corporate',
): Promise<string> {
  const corpRoot = join(CLAUDECORP_HOME, corpName);

  // If directory exists but is broken (no members.json), clean it up
  if (existsSync(corpRoot)) {
    if (!existsSync(join(corpRoot, MEMBERS_JSON))) {
      // Stale remnant — nuke and recreate
      const { rmSync } = await import('node:fs');
      rmSync(corpRoot, { recursive: true, force: true });
    } else {
      throw new Error(`Corporation "${corpName}" already exists at ${corpRoot}`);
    }
  }

  const theme = getTheme(themeId);

  // Create directory structure with themed channel names
  const dirs = [
    corpRoot,
    join(corpRoot, 'agents'),
    join(corpRoot, 'channels', theme.channels.general),
    join(corpRoot, 'channels', theme.channels.system),
    join(corpRoot, 'channels', theme.channels.heartbeat),
    join(corpRoot, 'channels', theme.channels.tasks),
    join(corpRoot, 'channels', theme.channels.errors),
    join(corpRoot, 'tasks'),
    join(corpRoot, 'projects'),
    join(corpRoot, 'resources'),
    join(corpRoot, 'deliverables'),
    join(corpRoot, 'hiring'),
    join(corpRoot, 'skills'),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Install default skills from bundled package
  try { installDefaultSkills(corpRoot); } catch {}

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
    theme: themeId,
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

  // channels.json — initial channels with themed names
  const ch = theme.channels;
  const channels: Channel[] = [
    makeChannel(ch.general, 'broadcast', 'corp', corpName, userId, `channels/${ch.general}/`, now),
    makeChannel(ch.system, 'system', 'corp', corpName, userId, `channels/${ch.system}/`, now),
    makeChannel(ch.heartbeat, 'system', 'corp', corpName, userId, `channels/${ch.heartbeat}/`, now),
    makeChannel(ch.tasks, 'system', 'corp', corpName, userId, `channels/${ch.tasks}/`, now),
    makeChannel(ch.errors, 'system', 'corp', corpName, userId, `channels/${ch.errors}/`, now),
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
  mkdirSync(join(CLAUDECORP_HOME, 'corps'), { recursive: true });

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
  return index.corps.filter((c) => existsSync(join(c.path, MEMBERS_JSON)));
}

export function findCorp(name: string): string | null {
  const corps = listCorps();
  const found = corps.find((c) => c.name === name);
  return found?.path ?? null;
}

export function deleteCorp(name: string): boolean {
  const index = readConfigOr<CorpsIndex>(CORPS_INDEX_PATH, { corps: [] });
  const entry = index.corps.find((c) => c.name === name);
  if (!entry) return false;

  try { rmSync(entry.path, { recursive: true, force: true }); } catch {}

  // Remove from index
  index.corps = index.corps.filter((c) => c.name !== name);
  writeConfig(CORPS_INDEX_PATH, index);
  return true;
}
