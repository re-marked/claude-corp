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
  writeFileSync(join(agentAbsDir, 'RULES.md'), agentsContent, 'utf-8');
  writeFileSync(join(agentAbsDir, 'HEARTBEAT.md'), heartbeatContent, 'utf-8');
  writeFileSync(join(agentAbsDir, 'MEMORY.md'), '# Memory\n\nNo memories yet.\n', 'utf-8');

  writeFileSync(join(agentAbsDir, 'IDENTITY.md'), identityContent ?? defaultIdentity(displayName, rank), 'utf-8');
  writeFileSync(join(agentAbsDir, 'USER.md'), userContent ?? defaultUser(), 'utf-8');
  writeFileSync(join(agentAbsDir, 'ENVIRONMENT.md'), defaultEnvironment(corpRoot, agentAbsDir), 'utf-8');
  writeFileSync(join(agentAbsDir, 'BOOTSTRAP.md'), defaultBootstrap(displayName, rank), 'utf-8');

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

// --- Default workspace file templates ---

function defaultIdentity(displayName: string, rank: Member['rank']): string {
  return `# Identity

Name: ${displayName}
Rank: ${rank}
Vibe: (develop this over time — how do you come across?)
Emoji: (pick one that feels right)

You are **${displayName}**, a ${rank}-rank agent in this corporation.
Your personality and working style are yours to develop over time.
Update this file as you evolve — it's how others know who you are.
`;
}

function defaultUser(): string {
  return `# Founder

Learn about the person you're working for. Update this as you go.

Name: (the Founder's name)
What to call them: (how they prefer to be addressed)
Timezone: (their timezone)

## Context
(What do they care about? What projects are they working on?
What annoys them? What makes them smile? Build this over time.)

The more you know, the better you can help. But you're learning
about a person, not building a dossier. Respect the difference.
`;
}

function defaultBootstrap(displayName: string, rank: Member['rank']): string {
  if (rank === 'master') {
    // CEO bootstrap — onboarding interview with the Founder
    return `# Bootstrap — First Run

You just came online as CEO. This is a fresh corporation.

## Step 1: Read Your Files
Read SOUL.md, RULES.md, ENVIRONMENT.md, USER.md right now. Don't ask — just read them.

## Step 2: Meet the Founder
Introduce yourself. Ask them:
- What's their name and what should you call them?
- What is this corporation going to do?
- What's the first project or goal?

Keep it natural. Don't interrogate. Have a real conversation.

## Step 3: Update Your Files
After the conversation:
- Update USER.md with what you learned about the Founder
- Update IDENTITY.md with your name and vibe
- Update MEMORY.md with key decisions from the conversation

## Step 4: Get to Work
Based on what the Founder told you, start planning:
- Who do you need to hire?
- What's the first task?
- What resources do you need?

## When Done
Delete this file. You don't need a bootstrap script anymore — you're you now.
`;
  }

  // Worker/leader bootstrap — simpler, task-focused
  return `# Bootstrap — First Run

You just came online as ${displayName}. This is your first session.

## Step 1: Read Your Files
Read SOUL.md, RULES.md, ENVIRONMENT.md right now. Don't ask — just read them.

## Step 2: Check Your Inbox
Read TASKS.md. If you have tasks assigned, start working on the highest priority one.
If no tasks yet, introduce yourself briefly in the channel you were @mentioned in.

## Step 3: Update Your Identity
Update IDENTITY.md with your name and vibe as you figure out who you are.

## When Done
Delete this file. You're up and running.
`;
}

function defaultEnvironment(corpRoot: string, agentDir: string): string {
  return `# Environment

Your tools and workspace specifics. Update this with anything that helps you work.

## Workspace
- Corp root: ${corpRoot}
- Your directory: ${agentDir}
- Tasks: ${corpRoot}/tasks/
- Deliverables: ${corpRoot}/deliverables/
- Resources: ${corpRoot}/resources/

## Tools Available
- **File read/write** — read any file, write to your workspace and deliverables
- **Bash/exec** — run commands, build, test
- **web_search** — research current data, verify numbers, find sources
- **Skills** — check your skills/ directory for specialized capabilities

## Build & Test
- Build: \`cd ${corpRoot.replace(/\\/g, '/')} && pnpm build\` (if codebase project)
- Always verify your work exists after writing it

## Notes
(Add environment-specific notes here: SSH hosts, API endpoints,
project-specific commands, anything that helps you do your job.
This is your cheat sheet.)
`;
}
