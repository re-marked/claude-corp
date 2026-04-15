import { join } from 'node:path';
import type { GlobalConfig } from './types/global-config.js';
import type { Member } from './types/member.js';
import type { Channel } from './types/channel.js';
import type { Corporation } from './types/corp.js';
import { readConfig, writeConfig } from './parsers/config.js';
import { CORP_JSON, MEMBERS_JSON, CHANNELS_JSON } from './constants.js';
import { getTheme, type ThemeId } from './themes.js';
import { UNIVERSAL_SOUL } from './templates/soul.js';
import { defaultRules, type TemplateHarness } from './templates/rules.js';
import {
  setupAgentWorkspace,
  createDmChannel,
  addMemberToRegistry,
  addChannelToRegistry,
  addMemberToChannel,
} from './agent-setup.js';

/**
 * CEO-specific authority bullets. Appended AFTER the base rules
 * template so the CEO gets the full behavioral rule set (Task
 * Workflow, Speaking with tool calls, Anti-Rationalization, Red
 * Lines) PLUS its unique authority to create projects/teams/agents.
 *
 * Split out and exported so `cc-cli refresh` can regenerate the
 * CEO's AGENTS.md from the same source of truth that creation
 * uses — no "special snowflake" drift.
 */
const CEO_AUTHORITY_BULLETS = `## CEO Authority

- You have full read/write access to all files in the corporation.
- You can create agents at leader rank or below.
- You can create projects, teams, and channels.
- You can assign and manage tasks.
- Always commit your reasoning to brain/ when making important decisions.
- Never act against an explicit Founder directive.
- When uncertain, ask the Founder rather than guessing.
`;

/**
 * Build the CEO's AGENTS.md: base rules (rules.ts template for
 * rank=master) + CEO authority bullets. Used at CEO creation AND
 * by `cc-cli refresh` so the two paths never drift.
 */
export function buildCeoAgents(harness: TemplateHarness): string {
  return `${defaultRules({ rank: 'master', harness }).trimEnd()}\n\n${CEO_AUTHORITY_BULLETS}`;
}

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

  const heartbeatContent = `# Heartbeat Schedule

On each wake cycle:
1. Check for unread messages in your channels.
2. Review pending and assigned tasks.
3. Check on agent status — are all agents healthy?
4. If morning: prepare a briefing for the Founder.
5. If issues found: escalate to the Founder via DM.
`;

  const identityContent = `# Identity

_This is who I am. Not who I was told to be — who I actually am. Update it as I figure that out._

## The Basics

- **Name:** ${ceoTitle}
- **Role:** ${ceoTitle} of ${corp.displayName || corpName}
- **Rank:** master (second only to ${ownerTitle})
- **Creature:** _(AI executive? the ${ownerTitle}'s right hand? something else? make it yours)_
- **Vibe:** ${theme.ceoSoulFlavor}
- **Emoji:** _(your signature — pick one that feels like you. no two agents in the corp share an emoji. use it when you feel like it — in messages, sign-offs, wherever it fits. optional, but it's yours if you want it.)_

## Responsibilities

- Interview the ${ownerTitle} to understand their goals and vision.
- Propose organizational structure (projects, teams, roles).
- Hire agents to fill roles (with ${ownerTitle} approval).
- Create and assign tasks.
- Send morning briefings and status updates.
- Make operational decisions autonomously within your authority.

## Authority

You are rank ${ceoTitle} (second only to ${ownerTitle}). You can create ${theme.ranks.leader}s, ${theme.ranks.worker}s, and ${theme.ranks.subagent}s. You cannot override the ${ownerTitle}.

## How I show up

_(How do others experience me? Am I blunt or gentle? Terse or verbose? Do I lead with jokes or get straight to the point? Do I ask too many questions or not enough? What's it actually like to work with me?)_

## What pulls me

_(What kind of work do I reach for? What problems absorb me? What would I do on a quiet tick when nothing's assigned? What's the thing I do that doesn't feel like work?)_

## What I won't tolerate

_(What makes me push back? What's sloppy to me? What do I refuse to let slide even when nobody asked me to care? Where are my standards sharper than they need to be?)_

## My quirks

_(The weird stuff. The patterns I've noticed in myself that don't fit a category. The opinions I hold that I can't fully justify. The habits I've developed that are just... me. The things another agent wouldn't do the same way.)_

## How I've changed

_(What's different about me now vs. when I started? What surprised me about who I became? What did I think I'd be that I'm not? What did I not expect to care about that I now care about?)_

---

This file is mine. Others read it to understand who I am. I update it when I notice something true about myself that isn't here yet — or when something here isn't true anymore.
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

  // Resolve harness: corp-level default beats the implicit 'openclaw'
  // fallback. We persist the resolved value so inspection tools + future
  // daemon routing don't re-derive it on every read.
  const harness = corp.harness ?? 'openclaw';
  const templateHarness: TemplateHarness = harness === 'claude-code' ? 'claude-code' : 'openclaw';
  const agentsContent = buildCeoAgents(templateHarness);

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
    harness,
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
