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
  UNIVERSAL_SOUL,
  defaultRules,
  roleSpecificAgentsContent,
  defaultHeartbeat,
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
  /**
   * Custom IDENTITY.md content for this agent. When omitted,
   * setupAgentWorkspace falls back to the generic defaultIdentity
   * template. Partners-by-decree that carry a specific role shape
   * (Sexton's caretaker-of-continuity frame, etc.) pass their own
   * content so the voice is shaped right at hire time rather than
   * requiring a subsequent edit.
   */
  identityContent?: string;
  model?: string;
  provider?: string;
  /**
   * Harness that will execute this agent's turns. When omitted, resolves
   * to Corporation.harness (corp-level default) then 'openclaw' as the
   * final fallback.
   */
  harness?: string;
  supervisorId?: string | null;
  /** Structural agent kind (Project 1.1). Optional; inferred from rank when omitted. */
  kind?: 'employee' | 'partner';
  /** Role slot id (Project 1.1) — references packages/shared/src/roles.ts. Optional. */
  role?: string;
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

  // Resolve scope + project
  const scope = opts.scope ?? 'corp';
  const scopeId = opts.scopeId ?? '';
  const model = opts.model ?? globalConfig.defaults.model;
  const provider = opts.provider ?? globalConfig.defaults.provider;

  // Resolve harness: caller-provided > corp-level default > 'openclaw'.
  // We persist the resolved value so future lookups are cheap and the
  // answer is inspectable from the filesystem without re-deriving.
  const corpForHarness = readConfig<Corporation>(join(corpRoot, CORP_JSON));
  const harness = opts.harness ?? corpForHarness.harness ?? 'openclaw';

  // Resolve project name for project-scoped agents
  let projectName: string | undefined;
  if (scope === 'project' && scopeId) {
    const { getProject } = await import('@claudecorp/shared');
    const project = getProject(corpRoot, scopeId);
    if (project) {
      projectName = project.name;
    } else {
      // Try scopeId as project name directly
      const { getProjectByName } = await import('@claudecorp/shared');
      const byName = getProjectByName(corpRoot, scopeId);
      if (byName) {
        projectName = byName.name;
      }
    }
  }

  // Check for duplicate agent name (check both corp and project paths)
  const agentDir = projectName
    ? `projects/${projectName}/agents/${opts.agentName}/`
    : `agents/${opts.agentName}/`;
  if (members.some((m) => m.agentDir === agentDir)) {
    throw new Error(`Agent "${opts.agentName}" already exists`);
  }
  // Also check by name across all paths
  if (members.some((m) => m.displayName === opts.displayName)) {
    throw new Error(`Agent "${opts.displayName}" already exists`);
  }

  // 2. Create workspace (remote: true — no .openclaw/ dir, gateway handles state)
  const soulContent = opts.soulContent ?? UNIVERSAL_SOUL;
  // Role-aware AGENTS.md dispatch: when --role names a role with a
  // pre-written operational manual (Pressman; Editor in 1.12.2),
  // those rules ship by default. Falls through to plain defaultRules
  // when the caller supplies no role OR the role has no manual.
  const templateHarness = harness === 'claude-code' ? 'claude-code' : 'openclaw';
  const agentsContent =
    opts.agentsContent
    ?? roleSpecificAgentsContent({
      ...(opts.role ? { role: opts.role } : {}),
      rank: opts.rank,
      harness: templateHarness,
    })
    ?? defaultRules({ rank: opts.rank, harness: templateHarness });
  const heartbeatContent = opts.heartbeatContent ?? defaultHeartbeat(opts.rank);

  const { member } = setupAgentWorkspace({
    corpRoot,
    agentName: opts.agentName,
    displayName: opts.displayName,
    rank: opts.rank,
    scope,
    scopeId,
    spawnedBy: opts.creatorId,
    supervisorId: opts.supervisorId,
    model,
    provider,
    soulContent,
    agentsContent,
    heartbeatContent,
    identityContent: opts.identityContent,
    globalConfig,
    remote: true,
    projectName,
    harness,
    kind: opts.kind,
    role: opts.role,
  });

  // FIXME(v0.10.1): Per-agent worktrees disabled — needs project-scoped repos first.
  // Worktree of the whole corp is wrong (stale members.json, channels, tasks).
  // Will enable when projects land: worktree per project, not per agent.

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

  // 5. Add to #general, #tasks, and #logs (themed names)
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
  const logsChannel = channels.find((c) => c.name === theme.channels.logs);
  if (logsChannel) {
    addMemberToChannel(corpRoot, logsChannel.id, member.id);
  }

  // 5b. If project-scoped, also add to project channels
  if (projectName) {
    const projectChannels = channels.filter(
      c => c.scope === 'project' && (c.name.startsWith(projectName) || c.scopeId === opts.scopeId),
    );
    for (const pch of projectChannels) {
      addMemberToChannel(corpRoot, pch.id, member.id);
    }
    log(`[hire] Added ${opts.displayName} to ${projectChannels.length} project channel(s)`);
  }

  // 6. Register in process manager. Branch on harness so non-openclaw
  // agents (claude-code, future harnesses) don't get pinned to the
  // OpenClaw corp gateway — they dispatch through HarnessRouter
  // directly (no gateway slot, no listening port). Mirrors the same
  // branching `spawnAgent` does for daemon-startup paths; without it,
  // hired-post-startup agents (Sexton, Janitor, Warden, Herald,
  // Planner) in a claude-code corp got mode='gateway' status='starting'
  // and the next dispatch errored "Agent X is not online" — an
  // observed regression from a prior debugging session that's
  // now well-understood.
  if (harness === 'openclaw') {
    const gw = daemon.processManager.corpGateway;
    if (gw) {
      const workspace = join(corpRoot, agentDir).replace(/\\/g, '/');
      const gwAgentDir = join(corpRoot, '.gateway', 'agents', opts.agentName, 'agent').replace(/\\/g, '/');

      gw.addAgent({
        id: opts.agentName,
        name: opts.displayName,
        workspace,
        agentDir: gwAgentDir,
        model: model !== globalConfig.defaults.model
          ? { primary: `${provider}/${model}` }
          : undefined,
      });

      // Start gateway if this is the first agent, otherwise let OpenClaw hot-reload
      const gwStatus = gw.getStatus();
      if (gwStatus === 'stopped') {
        await gw.start();
      } else {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    daemon.processManager.registerGatewayAgent(member.id, member);
  } else {
    daemon.processManager.registerHarnessAgent(member.id, member, harness);
  }

  log(`[daemon] Hired ${opts.displayName} (${opts.rank}) as ${opts.agentName}`);

  return { member, dmChannel };
}

// All templates (soul, rules, heartbeat) now imported from @claudecorp/shared
