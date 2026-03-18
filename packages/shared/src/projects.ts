import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, ProjectType } from './types/project.js';
import type { Channel } from './types/channel.js';
import { readConfig, readConfigOr, writeConfig } from './parsers/config.js';
import { generateId } from './id.js';
import { addChannelToRegistry } from './agent-setup.js';
import { CHANNELS_JSON, MESSAGES_JSONL } from './constants.js';

const PROJECTS_JSON = 'projects.json';

export interface CreateProjectOpts {
  name: string;
  displayName?: string;
  type: ProjectType;
  path?: string | null;
  lead?: string | null;
  description?: string;
  createdBy: string;
}

export function createProject(corpRoot: string, opts: CreateProjectOpts): Project {
  const id = generateId();
  const now = new Date().toISOString();

  const project: Project = {
    id,
    name: opts.name.toLowerCase().replace(/\s+/g, '-'),
    displayName: opts.displayName ?? opts.name,
    type: opts.type,
    path: opts.path ?? null,
    lead: opts.lead ?? null,
    description: opts.description ?? '',
    createdAt: now,
  };

  // Create project directory (for workspace type or deliverables)
  const projectDir = join(corpRoot, 'projects', project.name);
  mkdirSync(projectDir, { recursive: true });
  if (project.type === 'workspace') {
    mkdirSync(join(projectDir, 'deliverables'), { recursive: true });
  }

  // Save to projects.json
  const projectsPath = join(corpRoot, PROJECTS_JSON);
  const projects = readConfigOr<Project[]>(projectsPath, []);
  projects.push(project);
  writeConfig(projectsPath, projects);

  // Create project channels
  const generalChannel: Channel = {
    id: generateId(),
    name: `${project.name}-general`,
    kind: 'broadcast',
    scope: 'project',
    scopeId: project.id,
    teamId: null,
    memberIds: [],
    createdBy: opts.createdBy,
    path: `channels/${project.name}-general/`,
    createdAt: now,
  };

  const tasksChannel: Channel = {
    id: generateId(),
    name: `${project.name}-tasks`,
    kind: 'system',
    scope: 'project',
    scopeId: project.id,
    teamId: null,
    memberIds: [],
    createdBy: opts.createdBy,
    path: `channels/${project.name}-tasks/`,
    createdAt: now,
  };

  // Create channel directories + empty JSONL
  for (const ch of [generalChannel, tasksChannel]) {
    mkdirSync(join(corpRoot, ch.path), { recursive: true });
    writeFileSync(join(corpRoot, ch.path, MESSAGES_JSONL), '', 'utf-8');
    addChannelToRegistry(corpRoot, ch);
  }

  // Add founder + lead to project channels
  const members = readConfig<{ id: string; rank: string }[]>(join(corpRoot, 'members.json'));
  const founder = members.find((m) => m.rank === 'owner');
  if (founder) {
    const channelsPath = join(corpRoot, CHANNELS_JSON);
    const allChannels = readConfig<Channel[]>(channelsPath);
    for (const ch of [generalChannel, tasksChannel]) {
      const existing = allChannels.find((c) => c.id === ch.id);
      if (existing && !existing.memberIds.includes(founder.id)) {
        existing.memberIds.push(founder.id);
      }
      if (project.lead && existing && !existing.memberIds.includes(project.lead)) {
        existing.memberIds.push(project.lead);
      }
    }
    writeConfig(channelsPath, allChannels);
  }

  return project;
}

export function listProjects(corpRoot: string): Project[] {
  const projectsPath = join(corpRoot, PROJECTS_JSON);
  return readConfigOr<Project[]>(projectsPath, []);
}

export function getProject(corpRoot: string, projectId: string): Project | undefined {
  return listProjects(corpRoot).find((p) => p.id === projectId);
}

export function getProjectByName(corpRoot: string, name: string): Project | undefined {
  return listProjects(corpRoot).find((p) => p.name === name);
}
