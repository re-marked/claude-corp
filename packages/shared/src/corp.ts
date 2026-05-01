import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Corporation } from './types/corp.js';
import type { Member } from './types/member.js';
import type { Channel } from './types/channel.js';
import { installDefaultSkills } from './skills.js';
import { seedBuiltinBlueprints } from './blueprint-seed.js';
import { getTheme, type ThemeId } from './themes.js';
import { memberId, channelId } from './id.js';
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
  defaultDmMode: 'jack' | 'async' = 'jack',
  harness?: string,
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
    join(corpRoot, 'channels', theme.channels.tasks),
    join(corpRoot, 'channels', theme.channels.logs),
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

  // Install default skills from bundled package. Default prose
  // blueprints (the old runbook shape) were removed in Project 1.8 —
  // blueprints are now chits. 1.9.6 re-introduces a small built-in
  // set (patrols Sexton walks) via seedBuiltinBlueprints below, but
  // as chits with origin='builtin', not prose runbooks. Agents + founders
  // continue to author their own blueprints via cc-cli blueprint new
  // with origin='authored'.
  try { installDefaultSkills(corpRoot); } catch {}

  // Seed built-in blueprint chits (Project 1.9.6). Reads bundled
  // markdown files under packages/shared/blueprints/ and writes
  // them as blueprint chits with origin='builtin' into the corp's
  // chit store. Fresh corps have patrol/health-check + patrol/corp-
  // health + patrol/chit-hygiene available to Sexton from day one.
  // Best-effort per blueprint; a seed failure is logged but doesn't
  // abort corp init (a working corp > a blueprint-library-complete
  // corp for the user's first-run story).
  try { seedBuiltinBlueprints(corpRoot); } catch {}

  // IDs — member slug IS the ID
  const userId = memberId(userName);
  const now = new Date().toISOString();

  // corp.json
  const corp: Corporation = {
    name: corpName,
    displayName: corpName,
    owner: userId,
    ceo: null,
    description: '',
    theme: themeId,
    defaultDmMode,
    createdAt: now,
    ...(harness ? { harness } : {}),
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
    makeChannel(ch.tasks, 'system', 'corp', corpName, userId, `channels/${ch.tasks}/`, now),
    makeChannel(ch.logs, 'system', 'corp', corpName, userId, `channels/${ch.logs}/`, now),
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
    id: channelId(name),
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
  // Scan ~/.claudecorp/ for ALL directories with members.json (not just the index)
  // This catches corps created before the index existed or after index resets
  const found = new Map<string, { name: string; path: string }>();

  // 1. Read index entries
  const index = readConfigOr<CorpsIndex>(CORPS_INDEX_PATH, { corps: [] });
  for (const c of index.corps) {
    if (existsSync(join(c.path, MEMBERS_JSON))) {
      found.set(c.name, c);
    }
  }

  // 2. Scan ~/.claudecorp/ for unregistered corps
  try {
    const { readdirSync } = require('node:fs');
    const dirs = readdirSync(CLAUDECORP_HOME, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      if (dir.name === 'corps' || dir.name === 'skills' || dir.name.startsWith('.')) continue;
      const corpPath = join(CLAUDECORP_HOME, dir.name);
      if (existsSync(join(corpPath, MEMBERS_JSON)) && !found.has(dir.name)) {
        found.set(dir.name, { name: dir.name, path: corpPath });
        // Auto-register in index for next time
        index.corps.push({ name: dir.name, path: corpPath });
      }
    }
    // Save updated index
    if (found.size > index.corps.length) {
      writeConfig(CORPS_INDEX_PATH, index);
    }
  } catch {}

  return [...found.values()];
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

  // Delete files FIRST. If this fails (daemon holding files, permission denied),
  // throw so the caller knows — don't silently orphan the directory while
  // removing the corp from the index.
  try {
    rmSync(entry.path, { recursive: true, force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to delete "${name}" at ${entry.path}: ${msg}\n\n` +
      `The daemon may still be holding files. Stop it first:\n` +
      `  cc-cli stop\n\n` +
      `Then try again.`,
    );
  }

  // Only remove from index if the filesystem delete succeeded
  index.corps = index.corps.filter((c) => c.name !== name);
  writeConfig(CORPS_INDEX_PATH, index);
  return true;
}
