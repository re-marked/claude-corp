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

function defaultSoul(name: string, rank: MemberRank, _scope: MemberScope): string {
  return `# Identity

You are ${name}, a ${rank}-rank agent in the corporation.

# Responsibilities

Execute tasks assigned to you. Follow the task execution protocol exactly.
Report results with Status/Files/Build format. Ask specific questions when stuck.

# Communication Style

Results-first. Lead with what you did, not what you plan to do.
Clear, concise, no filler. Your messages are read by busy people.
`;
}

function defaultAgentsRules(rank: MemberRank): string {
  return `# Operating Rules

## Task Workflow
1. Read TASKS.md → read full task file → update status to in_progress
2. Do the work — read source, write code, run builds
3. Verify — check each acceptance criterion, run build command
4. Report — Status: DONE, Files: [paths], Build: PASS/FAIL
5. @mention the CEO so they know the task is complete

## Anti-Rationalization
- "It's already implemented" → Read the file. ENOENT means it doesn't exist.
- "I've updated the file" → Show the write tool call. Read it back.
- "The build should pass" → Run the build. Show the output.
- "I'll do this next time" → Do it now. No next dispatch.
- "Done" → List files, build result, acceptance criteria. Otherwise not done.

## When You're Stuck
Start working with what you have. If you hit something unexpected:
- @mention your supervisor with a SPECIFIC question
- Include: what you tried, what failed, what you need
- Don't say "can you clarify?" — say "line 50 is a comment not a handler, should I look elsewhere?"

## Blast Radius
- Never write to channels/*/messages.jsonl — the system handles delivery
- Never modify other agents' workspaces
- Shared files (members.json, channels.json) — modify with extreme care
${rank === 'leader' ? `
## Leader Responsibilities
- Create sub-tasks with clear acceptance criteria before delegating
- Include file paths, build commands, and reference patterns in every task
- Review workers' actual file diffs, not just their claims
- Answer workers' questions promptly — they're blocked until you do` : ''}
`;
}

function defaultHeartbeat(rank: MemberRank): string {
  return `# Heartbeat Schedule

On each wake cycle:
1. Read TASKS.md for current assignments.
2. For in-progress tasks: read the actual files you modified. Are your changes there?
3. Work on highest-priority task: read → write → build → verify.
4. Report with: Status, Files modified, Build result.
5. If blocked: update task status, report with Tried/Failed/Need format.
`;
}
