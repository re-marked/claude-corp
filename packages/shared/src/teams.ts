import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Team } from './types/team.js';
import type { Channel } from './types/channel.js';
import type { Project } from './types/project.js';
import { readConfig, readConfigOr, writeConfig } from './parsers/config.js';
import { generateId } from './id.js';
import { addChannelToRegistry } from './agent-setup.js';
import { CHANNELS_JSON, MESSAGES_JSONL } from './constants.js';

const TEAMS_JSON = 'teams.json';

export interface CreateTeamOpts {
  projectId: string;
  name: string;
  description?: string;
  leaderId: string;
  createdBy: string;
}

export function createTeam(corpRoot: string, opts: CreateTeamOpts): Team {
  const id = generateId();
  const now = new Date().toISOString();

  const team: Team = {
    id,
    name: opts.name.toLowerCase().replace(/\s+/g, '-'),
    description: opts.description ?? '',
    projectId: opts.projectId,
    leaderMemberId: opts.leaderId,
    parentId: null,
    status: 'active',
    memberIds: [opts.leaderId],
    createdBy: opts.createdBy,
    createdAt: now,
  };

  // Save to teams.json
  const teamsPath = join(corpRoot, TEAMS_JSON);
  const teams = readConfigOr<Team[]>(teamsPath, []);
  teams.push(team);
  writeConfig(teamsPath, teams);

  // Find project name for channel naming
  const projects = readConfigOr<Project[]>(join(corpRoot, 'projects.json'), []);
  const project = projects.find((p) => p.id === opts.projectId);
  const projectName = project?.name ?? 'unknown';

  // Create team channel
  const channel: Channel = {
    id: generateId(),
    name: `${projectName}-${team.name}`,
    kind: 'team',
    scope: 'team',
    scopeId: team.id,
    teamId: team.id,
    memberIds: [opts.leaderId],
    createdBy: opts.createdBy,
    path: `channels/${projectName}-${team.name}/`,
    createdAt: now,
  };

  mkdirSync(join(corpRoot, channel.path), { recursive: true });
  writeFileSync(join(corpRoot, channel.path, MESSAGES_JSONL), '', 'utf-8');
  addChannelToRegistry(corpRoot, channel);

  // Also add leader to project channels
  const allChannels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
  for (const ch of allChannels) {
    if (ch.scope === 'project' && ch.scopeId === opts.projectId) {
      if (!ch.memberIds.includes(opts.leaderId)) {
        ch.memberIds.push(opts.leaderId);
      }
    }
  }
  writeConfig(join(corpRoot, CHANNELS_JSON), allChannels);

  return team;
}

export function listTeams(corpRoot: string, projectId?: string): Team[] {
  const teams = readConfigOr<Team[]>(join(corpRoot, TEAMS_JSON), []);
  if (projectId) return teams.filter((t) => t.projectId === projectId);
  return teams;
}

export function getTeam(corpRoot: string, teamId: string): Team | undefined {
  return readConfigOr<Team[]>(join(corpRoot, TEAMS_JSON), []).find((t) => t.id === teamId);
}

export function addMemberToTeam(corpRoot: string, teamId: string, memberId: string): void {
  const teamsPath = join(corpRoot, TEAMS_JSON);
  const teams = readConfigOr<Team[]>(teamsPath, []);
  const team = teams.find((t) => t.id === teamId);
  if (team && !team.memberIds.includes(memberId)) {
    team.memberIds.push(memberId);
    writeConfig(teamsPath, teams);
  }

  // Add to team channel
  const allChannels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
  for (const ch of allChannels) {
    if (ch.teamId === teamId && !ch.memberIds.includes(memberId)) {
      ch.memberIds.push(memberId);
    }
  }
  writeConfig(join(corpRoot, CHANNELS_JSON), allChannels);
}
