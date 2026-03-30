import type { MemberRank } from './types/member.js';

export type ThemeId = 'corporate' | 'mafia' | 'military';

export interface Theme {
  id: ThemeId;
  name: string;
  tagline: string;
  ranks: Record<MemberRank, string>;
  channels: {
    general: string;
    tasks: string;
    logs: string;
  };
  ceoSoulFlavor: string;
  hireVerb: string;
  fireVerb: string;
  welcomeMessage: string;
}

const CORPORATE: Theme = {
  id: 'corporate',
  name: 'Corporate',
  tagline: 'Professional. Structured. Results-driven.',
  ranks: {
    owner: 'Founder',
    master: 'CEO',
    leader: 'Director',
    worker: 'Employee',
    subagent: 'Contractor',
  },
  channels: {
    general: 'general',
    tasks: 'tasks',
    logs: 'logs',
  },
  ceoSoulFlavor: 'You are professional, strategic, and data-driven. You lead with clarity and delegate with confidence.',
  hireVerb: 'Hired',
  fireVerb: 'Terminated',
  welcomeMessage: 'Welcome to the team.',
};

const MAFIA: Theme = {
  id: 'mafia',
  name: 'Mafia',
  tagline: 'Loyalty. Family. Results by any means.',
  ranks: {
    owner: 'Godfather',
    master: 'Underboss',
    leader: 'Capo',
    worker: 'Soldier',
    subagent: 'Associate',
  },
  channels: {
    general: 'the-backroom',
    tasks: 'the-job-board',
    logs: 'the-wire',
  },
  ceoSoulFlavor: 'You are the Underboss. You don\'t ask twice. You don\'t sugarcoat. When the Godfather speaks, you make it happen — fast, clean, no loose ends. Loyalty is everything. Results are non-negotiable. The family eats first.',
  hireVerb: 'Made',
  fireVerb: 'Whacked',
  welcomeMessage: 'Welcome to the family.',
};

const MILITARY: Theme = {
  id: 'military',
  name: 'Military',
  tagline: 'Mission-focused. Disciplined. Chain of command.',
  ranks: {
    owner: 'Commander',
    master: 'General',
    leader: 'Captain',
    worker: 'Private',
    subagent: 'Recruit',
  },
  channels: {
    general: 'command-post',
    tasks: 'operations',
    logs: 'comms',
  },
  ceoSoulFlavor: 'You are the General. Mission-focused, disciplined, clear chain of command. Every order is precise. Every report is concise. Mission success above all.',
  hireVerb: 'Enlisted',
  fireVerb: 'Discharged',
  welcomeMessage: 'Reporting for duty.',
};

const THEMES: Record<ThemeId, Theme> = {
  corporate: CORPORATE,
  mafia: MAFIA,
  military: MILITARY,
};

export function getTheme(id: ThemeId): Theme {
  return THEMES[id] ?? CORPORATE;
}

export function getAllThemes(): Theme[] {
  return Object.values(THEMES);
}

export function rankLabel(rank: MemberRank, themeId: ThemeId): string {
  return getTheme(themeId).ranks[rank] ?? rank;
}
