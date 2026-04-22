import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberId as makeMemberId, channelId as makeChannelId, gatewayToken as makeGatewayToken } from './id.js';
import { writeConfig } from './parsers/config.js';
import type { Member } from './types/member.js';
import type { Channel } from './types/channel.js';
import type { AgentConfig } from './types/agent-config.js';
import type { GlobalConfig } from './types/global-config.js';
import { CHANNELS_JSON, MEMBERS_JSON, MESSAGES_JSONL } from './constants.js';
import { readConfig } from './parsers/config.js';
import { syncSkillsToAgent } from './skills.js';
import { CEO_BOOTSTRAP } from './templates/bootstrap-ceo.js';
import { buildAgentBootstrap } from './templates/bootstrap-agent.js';
import { getSharedTags } from './brain-culture.js';
import { readCulture } from './culture.js';
import { defaultIdentity as identityTemplate } from './templates/identity.js';
import { MEMORY_TEMPLATE } from './templates/memory.js';
import { USER_TEMPLATE } from './templates/user.js';
import { defaultEnvironment } from './templates/environment.js';
import { defaultHeartbeat as heartbeatTemplate } from './templates/heartbeat.js';
import { defaultRules as rulesTemplate } from './templates/rules.js';
import { buildThinClaudeMd } from './templates/claude-md.js';
import { buildHookSettings } from './templates/hook-settings.js';
import { inferKind } from './wtf-state.js';

export interface AgentSetupOpts {
  corpRoot: string;
  agentName: string;
  displayName: string;
  rank: Member['rank'];
  scope: Member['scope'];
  scopeId: string;
  spawnedBy: string;
  /** Explicit management supervisor. When set, persisted on the Member and used for hierarchy checks. */
  supervisorId?: string | null;
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
  /** Project name (resolved from scopeId) for project-scoped agents. */
  projectName?: string;
  /**
   * Registered harness name that executes this agent's turns. Persisted
   * in the agent's config.json and Member record. Optional; callers
   * typically resolve it from corp-level defaults before calling.
   */
  harness?: string;
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

  // Project-scoped agents live at projects/<project>/agents/<name>/
  // Corp-scoped agents live at agents/<name>/
  const agentRelDir = scope === 'project' && opts.projectName
    ? `projects/${opts.projectName}/agents/${agentName}/`
    : `agents/${agentName}/`;
  const agentAbsDir = join(corpRoot, agentRelDir);
  const memberId = makeMemberId(displayName);
  const now = new Date().toISOString();

  // Create workspace directories
  mkdirSync(join(agentAbsDir, 'brain'), { recursive: true });
  mkdirSync(join(agentAbsDir, 'skills'), { recursive: true });

  // Sync corp-level skills to agent workspace
  try { syncSkillsToAgent(corpRoot, agentRelDir); } catch {}


  // Write workspace files. Filenames align with OpenClaw's recognized
  // bootstrap basename set (AGENTS.md, TOOLS.md) so OpenClaw auto-loads
  // them into the system prompt; Claude Code's CLAUDE.md @imports the
  // same names. The internal variable/template names keep "rules" and
  // "environment" for semantic clarity (these are rules + env info,
  // regardless of the AGENTS.md / TOOLS.md filesystem handle).
  const templateHarness = (opts.harness === 'claude-code' ? 'claude-code' : 'openclaw') as 'claude-code' | 'openclaw';
  writeFileSync(join(agentAbsDir, 'SOUL.md'), soulContent, 'utf-8');
  writeFileSync(join(agentAbsDir, 'AGENTS.md'), agentsContent ?? rulesTemplate({ rank, harness: templateHarness }), 'utf-8');
  writeFileSync(join(agentAbsDir, 'HEARTBEAT.md'), heartbeatContent ?? heartbeatTemplate(rank), 'utf-8');
  writeFileSync(join(agentAbsDir, 'MEMORY.md'), MEMORY_TEMPLATE, 'utf-8');
  writeFileSync(join(agentAbsDir, 'IDENTITY.md'), identityContent ?? identityTemplate(displayName, rank), 'utf-8');
  writeFileSync(join(agentAbsDir, 'USER.md'), userContent ?? USER_TEMPLATE, 'utf-8');
  writeFileSync(join(agentAbsDir, 'TOOLS.md'), defaultEnvironment({
    corpRoot,
    agentDir: agentAbsDir,
    projectName: opts.projectName,
    harness: templateHarness,
  }), 'utf-8');

  // CLAUDE.md — only for agents on the claude-code harness. Project 0.7
  // architecture: thin survival-anchor shell, no @import of AGENTS.md or
  // TOOLS.md. The corp manual + situational context come dynamically
  // via `cc-cli wtf` fired by the SessionStart / PreCompact hooks
  // configured in .claude/settings.json (written below).
  //
  // OpenClaw agents skip CLAUDE.md — the OpenClaw harness will prepend
  // wtf output at dispatch time instead (same content, different trigger).
  // That harness integration lands in a follow-up PR; for now OpenClaw
  // agents still boot via the legacy fragments pipeline.
  //
  // AGENTS.md + TOOLS.md writes above remain unchanged — their files
  // still get created on disk for backward compatibility with system
  // agents composed via buildCeoAgents + defaultRules that haven't been
  // migrated yet. The thin CLAUDE.md simply doesn't @import them, so
  // they're stale-but-harmless until 0.7.5 rewire cleans them up on
  // existing workspaces.
  if (templateHarness === 'claude-code') {
    const kind = inferKind(rank);
    const corpName = corpRoot.split(/[/\\]/).pop() ?? 'corp';
    writeFileSync(
      join(agentAbsDir, 'CLAUDE.md'),
      buildThinClaudeMd({
        kind,
        displayName,
        role: rank,
        corpName,
        workspacePath: agentAbsDir,
      }),
      'utf-8',
    );

    // .claude/settings.json — hook wiring. SessionStart + Stop for
    // both kinds; PreCompact + UserPromptSubmit for Partners only.
    // Until 0.7.3 ships `cc-cli audit`, the Stop hook command will
    // fail to find the subcommand and exit non-zero — but Claude
    // Code hooks tolerate missing commands (they log + continue), so
    // this is safe to ship ahead of 0.7.3.
    const claudeDir = join(agentAbsDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settings = buildHookSettings({ kind, agentSlug: agentName });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify(settings, null, 2) + '\n',
      'utf-8',
    );
  }
  // CEO gets the founding conversation guide; hired agents get the absorption shield
  // with culture vocabulary injected at hire time when available
  let bootstrapContent = CEO_BOOTSTRAP;
  if (rank !== 'master') {
    let sharedTags: string[] = [];
    try {
      sharedTags = getSharedTags(corpRoot).map(t => t.tag);
    } catch { /* culture data unavailable — fine, bootstrap works without it */ }

    // Resolve hiring agent's display name from members.json
    let hiringAgentName: string | undefined;
    if (opts.spawnedBy) {
      try {
        const allMembers = readConfig<Array<{ id: string; displayName: string }>>(join(corpRoot, MEMBERS_JSON));
        const spawner = allMembers.find(m => m.id === opts.spawnedBy);
        if (spawner) hiringAgentName = spawner.displayName;
      } catch { /* name resolution failed — fine, bootstrap works without it */ }
    }

    let hasCulture = false;
    try {
      hasCulture = readCulture(corpRoot) !== null;
    } catch { /* fine, bootstrap works without it */ }

    bootstrapContent = buildAgentBootstrap({
      sharedTags: sharedTags.length > 0 ? sharedTags : undefined,
      hiringAgentName,
      hasCulture,
    });
  }
  writeFileSync(join(agentAbsDir, 'BOOTSTRAP.md'), bootstrapContent, 'utf-8');

  // Agent config
  const agentConfig: AgentConfig = {
    memberId,
    displayName,
    model,
    provider,
    port: null,
    scope,
    scopeId,
    ...(opts.harness ? { harness: opts.harness } : {}),
  };
  writeConfig(join(agentAbsDir, 'config.json'), agentConfig);

  // OpenClaw state directory (only for locally-spawned agents, not remote)
  if (!remote) {
    const openclawStateDir = join(agentAbsDir, '.openclaw');
    mkdirSync(join(openclawStateDir, 'agents', 'main', 'agent'), { recursive: true });

    // Generate a unique gateway token for this agent
    const gatewayToken = makeGatewayToken();

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
    ...(opts.supervisorId ? { supervisorId: opts.supervisorId } : {}),
    createdAt: now,
    ...(opts.harness ? { harness: opts.harness } : {}),
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
    id: makeChannelId(channelName),
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

// All workspace file templates are now in shared/src/templates/
