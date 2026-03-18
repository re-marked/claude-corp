import { join } from 'node:path';
import {
  type Member,
  type Channel,
  type Corporation,
  type MemberRank,
  type MemberScope,
  type GlobalConfig,
  readConfig,
  canHire,
  getTheme,
  type ThemeId,
  setupAgentWorkspace,
  createDmChannel,
  addMemberToRegistry,
  addChannelToRegistry,
  addMemberToChannel,
  MEMBERS_JSON,
  CHANNELS_JSON,
  CORP_JSON,
} from '@agentcorp/shared';
import type { Daemon } from './daemon.js';

export interface HireOpts {
  creatorId: string;
  agentName: string;
  displayName: string;
  rank: MemberRank;
  scope?: MemberScope;
  scopeId?: string;
  soulContent?: string;
  agentsContent?: string;
  heartbeatContent?: string;
  model?: string;
  provider?: string;
}

export interface HireResult {
  member: Member;
  dmChannel: Channel;
}

export async function hireAgent(
  daemon: Daemon,
  opts: HireOpts,
): Promise<HireResult> {
  const corpRoot = daemon.corpRoot;
  const globalConfig = daemon.globalConfig;

  // 1. Validate rank
  const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  const creator = members.find((m) => m.id === opts.creatorId);
  if (!creator) throw new Error(`Creator ${opts.creatorId} not found`);
  if (!canHire(creator.rank, opts.rank)) {
    throw new Error(`${creator.displayName} (${creator.rank}) cannot hire at rank ${opts.rank}`);
  }

  // Check for duplicate agent name
  const agentDir = `agents/${opts.agentName}/`;
  if (members.some((m) => m.agentDir === agentDir)) {
    throw new Error(`Agent "${opts.agentName}" already exists`);
  }

  const scope = opts.scope ?? 'corp';
  const scopeId = opts.scopeId ?? '';
  const model = opts.model ?? globalConfig.defaults.model;
  const provider = opts.provider ?? globalConfig.defaults.provider;

  // 2. Create workspace (remote: true — no .openclaw/ dir, gateway handles state)
  const soulContent = opts.soulContent ?? defaultSoul(opts.displayName, opts.rank, scope);
  const agentsContent = opts.agentsContent ?? defaultAgentsRules(opts.rank);
  const heartbeatContent = opts.heartbeatContent ?? defaultHeartbeat(opts.rank);

  const { member } = setupAgentWorkspace({
    corpRoot,
    agentName: opts.agentName,
    displayName: opts.displayName,
    rank: opts.rank,
    scope,
    scopeId,
    spawnedBy: opts.creatorId,
    model,
    provider,
    soulContent,
    agentsContent,
    heartbeatContent,
    globalConfig,
    remote: true,
  });

  // 3. Add member to registry
  addMemberToRegistry(corpRoot, member);

  // 4. Create DM channel with founder
  const founder = members.find((m) => m.rank === 'owner');
  if (founder) {
    var dmChannel = createDmChannel(
      corpRoot,
      founder.id,
      member.id,
      founder.displayName.toLowerCase(),
      opts.agentName,
    );
    addChannelToRegistry(corpRoot, dmChannel);
  } else {
    // Fallback: DM with creator
    var dmChannel = createDmChannel(
      corpRoot,
      opts.creatorId,
      member.id,
      creator.displayName.toLowerCase(),
      opts.agentName,
    );
    addChannelToRegistry(corpRoot, dmChannel);
  }

  // 5. Add to #general and #tasks (themed names)
  const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
  const corp = readConfig<Corporation>(join(corpRoot, CORP_JSON));
  const theme = getTheme((corp.theme || 'corporate') as ThemeId);
  const general = channels.find((c) => c.name === theme.channels.general);
  if (general) {
    addMemberToChannel(corpRoot, general.id, member.id);
  }
  const tasksChannel = channels.find((c) => c.name === theme.channels.tasks);
  if (tasksChannel) {
    addMemberToChannel(corpRoot, tasksChannel.id, member.id);
  }

  // 6. Add to corp gateway + restart
  const gw = daemon.processManager.corpGateway;
  if (gw) {
    const workspace = join(corpRoot, agentDir).replace(/\\/g, '/');
    const gwAgentDir = join(corpRoot, '.gateway', 'agents', opts.agentName, 'agent').replace(/\\/g, '/');

    gw.addAgent({
      id: opts.agentName,
      name: opts.displayName,
      workspace,
      agentDir: gwAgentDir,
    });

    await gw.restart();
  }

  // 7. Register in process manager
  daemon.processManager.registerGatewayAgent(member.id, member);

  console.log(`[daemon] Hired ${opts.displayName} (${opts.rank}) as ${opts.agentName}`);

  return { member, dmChannel };
}

function defaultSoul(name: string, rank: MemberRank, scope: MemberScope): string {
  return `# Identity

You are ${name}, a ${rank}-rank agent in the corporation.

# Responsibilities

Perform tasks assigned to you. Communicate clearly. Ask for help when stuck.
Report progress in your team channel.

# Communication Style

Clear, concise, professional. Focus on getting work done.
`;
}

function defaultAgentsRules(rank: MemberRank): string {
  return `# Operating Rules

- Read your assigned tasks and work on them.
- Post updates to your channel when you make progress.
- Ask your team leader or the CEO if you're blocked.
- Update your MEMORY.md with things you learn.
${rank === 'leader' ? '- You can assign tasks to workers on your team.\n- Review their work and provide feedback.' : ''}
`;
}

function defaultHeartbeat(rank: MemberRank): string {
  return `# Heartbeat Schedule

On each wake cycle:
1. Check for unread messages in your channels.
2. Review your assigned tasks.
3. Work on the highest-priority pending task.
4. Post a status update if you completed something.
`;
}
