import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateId } from './id.js';
import { writeConfig } from './parsers/config.js';
import type { Member } from './types/member.js';
import type { Channel } from './types/channel.js';
import type { AgentConfig } from './types/agent-config.js';
import type { GlobalConfig } from './types/global-config.js';
import { CHANNELS_JSON, MEMBERS_JSON, MESSAGES_JSONL } from './constants.js';
import { readConfig } from './parsers/config.js';
import { syncSkillsToAgent } from './skills.js';

export interface AgentSetupOpts {
  corpRoot: string;
  agentName: string;
  displayName: string;
  rank: Member['rank'];
  scope: Member['scope'];
  scopeId: string;
  spawnedBy: string;
  model: string;
  provider: string;
  soulContent: string;
  agentsContent: string;
  heartbeatContent: string;
  identityContent?: string;
  userContent?: string;
  globalConfig: GlobalConfig;
  /** If true, skip creating .openclaw/ state dir (agent uses an external gateway) */
  remote?: boolean;
}

export interface AgentSetupResult {
  member: Member;
  agentDir: string;
  config: AgentConfig;
}

export function setupAgentWorkspace(opts: AgentSetupOpts): AgentSetupResult {
  const {
    corpRoot,
    agentName,
    displayName,
    rank,
    scope,
    scopeId,
    spawnedBy,
    model,
    provider,
    soulContent,
    agentsContent,
    heartbeatContent,
    identityContent,
    userContent,
    globalConfig,
    remote,
  } = opts;

  const agentRelDir = `agents/${agentName}/`;
  const agentAbsDir = join(corpRoot, agentRelDir);
  const memberId = generateId();
  const now = new Date().toISOString();

  // Create workspace directories
  mkdirSync(join(agentAbsDir, 'brain'), { recursive: true });
  mkdirSync(join(agentAbsDir, 'skills'), { recursive: true });

  // Sync corp-level skills to agent workspace
  try { syncSkillsToAgent(corpRoot, agentRelDir); } catch {}


  // Write workspace files
  writeFileSync(join(agentAbsDir, 'SOUL.md'), soulContent, 'utf-8');
  writeFileSync(join(agentAbsDir, 'AGENTS.md'), agentsContent, 'utf-8');
  writeFileSync(join(agentAbsDir, 'MEMORY.md'), '# Memory\n\nNo memories yet.\n', 'utf-8');
  writeFileSync(join(agentAbsDir, 'HEARTBEAT.md'), heartbeatContent, 'utf-8');
  if (identityContent) {
    writeFileSync(join(agentAbsDir, 'IDENTITY.md'), identityContent, 'utf-8');
  }
  if (userContent) {
    writeFileSync(join(agentAbsDir, 'USER.md'), userContent, 'utf-8');
  }

  // Agent config
  const agentConfig: AgentConfig = {
    memberId,
    displayName,
    model,
    provider,
    port: null,
    scope,
    scopeId,
  };
  writeConfig(join(agentAbsDir, 'config.json'), agentConfig);

  // OpenClaw state directory (only for locally-spawned agents, not remote)
  if (!remote) {
    const openclawStateDir = join(agentAbsDir, '.openclaw');
    mkdirSync(join(openclawStateDir, 'agents', 'main', 'agent'), { recursive: true });

    // Generate a unique gateway token for this agent
    const gatewayToken = generateId() + generateId();

    // openclaw.json
    const openclawConfig = {
      auth: {
        profiles: {
          [`${provider}:default`]: {
            provider,
            mode: 'token',
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: `${provider}/${model}` },
          workspace: agentAbsDir.replace(/\\/g, '/'),
          compaction: { mode: 'safeguard' },
          verboseDefault: 'full',
          blockStreamingDefault: 'off',
        },
      },
      gateway: {
        mode: 'local',
        bind: 'loopback',
        auth: { mode: 'token', token: gatewayToken },
        http: {
          endpoints: {
            chatCompletions: { enabled: true },
          },
        },
      },
    };
    writeConfig(join(openclawStateDir, 'openclaw.json'), openclawConfig);

    // auth-profiles.json — inject API key from global config
    const apiKey = globalConfig.apiKeys[provider as keyof typeof globalConfig.apiKeys];
    const authProfiles = {
      version: 1,
      profiles: {
        [`${provider}:default`]: {
          type: 'token',
          provider,
          token: apiKey ?? '',
        },
      },
    };
    writeConfig(
      join(openclawStateDir, 'agents', 'main', 'agent', 'auth-profiles.json'),
      authProfiles,
    );
  }

  // Member entry
  const member: Member = {
    id: memberId,
    displayName,
    rank,
    status: 'active',
    type: 'agent',
    scope,
    scopeId,
    agentDir: agentRelDir,
    port: null,
    spawnedBy,
    createdAt: now,
  };

  return { member, agentDir: agentRelDir, config: agentConfig };
}

export function createDmChannel(
  corpRoot: string,
  member1Id: string,
  member2Id: string,
  member1Name: string,
  member2Name: string,
): Channel {
  const names = [member1Name, member2Name].sort();
  const channelName = `dm-${names[0]}-${names[1]}`;
  const channelPath = `channels/${channelName}/`;
  const now = new Date().toISOString();

  // Create channel directory
  mkdirSync(join(corpRoot, channelPath), { recursive: true });
  writeFileSync(join(corpRoot, channelPath, MESSAGES_JSONL), '', 'utf-8');

  const channel: Channel = {
    id: generateId(),
    name: channelName,
    kind: 'direct',
    scope: 'corp',
    scopeId: '',
    teamId: null,
    memberIds: [member1Id, member2Id],
    createdBy: member1Id,
    path: channelPath,
    createdAt: now,
  };

  return channel;
}

export function addMemberToRegistry(corpRoot: string, member: Member): void {
  const membersPath = join(corpRoot, MEMBERS_JSON);
  const members = readConfig<Member[]>(membersPath);
  members.push(member);
  writeConfig(membersPath, members);
}

export function addChannelToRegistry(corpRoot: string, channel: Channel): void {
  const channelsPath = join(corpRoot, CHANNELS_JSON);
  const channels = readConfig<Channel[]>(channelsPath);
  channels.push(channel);
  writeConfig(channelsPath, channels);
}

export function addMemberToChannel(corpRoot: string, channelId: string, memberId: string): void {
  const channelsPath = join(corpRoot, CHANNELS_JSON);
  const channels = readConfig<Channel[]>(channelsPath);
  const ch = channels.find((c) => c.id === channelId);
  if (ch && !ch.memberIds.includes(memberId)) {
    ch.memberIds.push(memberId);
    writeConfig(channelsPath, channels);
  }
}
