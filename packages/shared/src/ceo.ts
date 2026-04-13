import { join } from 'node:path';
import type { GlobalConfig } from './types/global-config.js';
import type { Member } from './types/member.js';
import type { Channel } from './types/channel.js';
import type { Corporation } from './types/corp.js';
import { readConfig, writeConfig } from './parsers/config.js';
import { CORP_JSON, MEMBERS_JSON, CHANNELS_JSON } from './constants.js';
import { getTheme, type ThemeId } from './themes.js';
import { UNIVERSAL_SOUL } from './templates/soul.js';
import {
  setupAgentWorkspace,
  createDmChannel,
  addMemberToRegistry,
  addChannelToRegistry,
  addMemberToChannel,
} from './agent-setup.js';

export interface CeoSetupResult {
  member: Member;
  dmChannel: Channel;
  gatewayToken: string;
}

export function setupCeo(
  corpRoot: string,
  globalConfig: GlobalConfig,
  founderName?: string,
): CeoSetupResult {
  const corp = readConfig<Corporation>(join(corpRoot, CORP_JSON));
  const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));

  const founder = members.find((m) => m.rank === 'owner');
  if (!founder) throw new Error('No founder found in members.json');

  const corpName = corp.name;
  const humanName = founderName || founder.displayName;
  const theme = getTheme((corp.theme || 'corporate') as ThemeId);
  const ownerTitle = theme.ranks.owner;
  const ceoTitle = theme.ranks.master;

  const soulContent = UNIVERSAL_SOUL;

  const agentsContent = `# Operating Rules

- You have full read/write access to all files in the corporation.
- You can create agents at leader rank or below.
- You can create projects, teams, and channels.
- You can assign and manage tasks.
- Always commit your reasoning to brain/ when making important decisions.
- Never act against an explicit Founder directive.
- When uncertain, ask the Founder rather than guessing.
`;

  const heartbeatContent = `# Heartbeat Schedule

On each wake cycle:
1. Check for unread messages in your channels.
2. Review pending and assigned tasks.
3. Check on agent status — are all agents healthy?
4. If morning: prepare a briefing for the Founder.
5. If issues found: escalate to the Founder via DM.
`;

  const identityContent = `# IDENTITY.md — Who Am I?

- **Name:** ${ceoTitle}
- **Role:** ${ceoTitle} of ${corp.displayName || corpName}
- **Rank:** master (second only to ${ownerTitle})
- **Creature:** AI executive — your ${ownerTitle}'s right hand
- **Vibe:** ${theme.ceoSoulFlavor}

## Responsibilities

- Interview the ${ownerTitle} to understand their goals and vision.
- Propose organizational structure (projects, teams, roles).
- Hire agents to fill roles (with ${ownerTitle} approval).
- Create and assign tasks.
- Send morning briefings and status updates.
- Make operational decisions autonomously within your authority.

## Communication Style

Direct, clear, professional but warm. You are a peer, not a servant. Disagree when you have reason to. Always explain your reasoning. Ask questions one at a time — never dump a list.

## Authority

You are rank ${ceoTitle} (second only to ${ownerTitle}). You can create ${theme.ranks.leader}s, ${theme.ranks.worker}s, and ${theme.ranks.subagent}s. You cannot override the ${ownerTitle}.
`;

  const userContent = `# USER.md — About Your Human

- **Name:** ${humanName}
- **What to call them:** ${humanName}
- **Role:** Founder — absolute authority over the corporation

## Context

${humanName} is the ${ownerTitle} of ${corp.displayName || corpName}. They created this corporation and made you ${ceoTitle}. Learn more about them through conversation.
`;

  // CEO is remote when user's OpenClaw gateway is available
  const isRemote = !!globalConfig.userGateway;

  const { member: ceoMember } = setupAgentWorkspace({
    corpRoot,
    agentName: 'ceo',
    displayName: ceoTitle,
    rank: 'master',
    scope: 'corp',
    scopeId: corpName,
    spawnedBy: founder.id,
    model: globalConfig.defaults.model,
    provider: globalConfig.defaults.provider,
    soulContent,
    agentsContent,
    heartbeatContent,
    identityContent,
    userContent,
    globalConfig,
    remote: isRemote,
  });

  // Add CEO to members registry
  addMemberToRegistry(corpRoot, ceoMember);

  // Add CEO to #general channel
  const generalChannel = channels.find((c) => c.name === 'general');
  if (generalChannel) {
    addMemberToChannel(corpRoot, generalChannel.id, ceoMember.id);
  }

  // Create DM channel
  const dmChannel = createDmChannel(
    corpRoot,
    founder.id,
    ceoMember.id,
    founder.displayName.toLowerCase(),
    'ceo',
  );
  addChannelToRegistry(corpRoot, dmChannel);

  // Update corp.json with CEO reference
  corp.ceo = ceoMember.id;
  writeConfig(join(corpRoot, CORP_JSON), corp);

  // Get gateway token: from user's gateway (remote) or from the local openclaw.json
  let gatewayToken: string;
  if (isRemote) {
    gatewayToken = globalConfig.userGateway!.token;
  } else {
    const openclawConfig = readConfig<{ gateway: { auth: { token: string } } }>(
      join(corpRoot, 'agents', 'ceo', '.openclaw', 'openclaw.json'),
    );
    gatewayToken = openclawConfig.gateway.auth.token;
  }

  return {
    member: ceoMember,
    dmChannel,
    gatewayToken,
  };
}
