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
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { log } from './logger.js';

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

  // 6. Add to corp gateway — start if first agent, hot-reload if running
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

    // Start gateway if not running (first agent hired mid-session)
    // If already running, OpenClaw hot-reloads agents.list automatically
    const status = gw.getStatus();
    if (status === 'stopped' || status === 'starting') {
      await gw.start();
    } else {
      // Give OpenClaw a moment to hot-reload the new agent config
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // 7. Register in process manager
  daemon.processManager.registerGatewayAgent(member.id, member);

  log(`[daemon] Hired ${opts.displayName} (${opts.rank}) as ${opts.agentName}`);

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

- Read your TASKS.md to see assigned work. Read the full task file for details.
- ACTUALLY DO THE WORK. Read source files, write code, run builds. Do not just describe what you would do.
- Never claim something is "already implemented" without reading the actual file and verifying.
- After writing files, read them back to confirm the write succeeded.
- Run \`pnpm build\` after code changes to verify they compile.
- Post concrete progress updates: file paths modified, build results, what changed.
- Only mark a task completed when you can list the exact files you created/modified.
- If stuck, ask for help. If a path doesn't exist, check the real directory structure first.
- Update your MEMORY.md with things you learn about the codebase.
${rank === 'leader' ? '- You can create sub-tasks and assign them to workers.\n- Review their actual output (file diffs), not just their claims.' : ''}
`;
}

function defaultHeartbeat(rank: MemberRank): string {
  return `# Heartbeat Schedule

On each wake cycle:
1. Read your TASKS.md for current assignments.
2. For each in-progress task: check the actual files you're supposed to be modifying. Are your changes there?
3. Work on the highest-priority task — read code, write code, run builds.
4. Post a status update with CONCRETE details: which files you touched, what you changed, build results.
5. If a task is stuck, update its status to blocked and explain why.
`;
}
