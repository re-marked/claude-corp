import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// --- Color Palette Definitions ---

export interface ColorPalette {
  name: string;
  // Brand
  primary: string;
  secondary: string;
  // Semantic
  success: string;
  warning: string;
  danger: string;
  info: string;
  // Neutral
  text: string;
  subtle: string;
  muted: string;
  border: string;
  borderActive: string;
  // Identity — hierarchy-based
  user: string;        // Founder
  ceo: 'rainbow';
  agentLeader: string; // leaders, directors
  agentWorker: string; // workers, subagents
  system: string;
}

/** Resolve agent color by rank */
export function agentColor(palette: ColorPalette, rank?: string): string {
  if (rank === 'master') return palette.primary; // CEO uses primary (but rainbow overrides in rendering)
  if (rank === 'leader') return palette.agentLeader;
  return palette.agentWorker;
}

// --- Palettes ---

const CORAL: ColorPalette = {
  name: 'coral',
  primary: '#E07B56',
  secondary: '#F0C674',
  success: '#6CC490',
  warning: '#F0C674',
  danger: '#E05A5A',
  info: '#6BAED6',
  text: '#E2E2E2',
  subtle: '#9E9E9E',
  muted: '#5A5A5A',
  border: '#3A3A3A',
  borderActive: '#E07B56',
  user: '#6CC490',
  ceo: 'rainbow',
  agentLeader: '#E07B56',
  agentWorker: '#6BAED6',
  system: '#5A5A5A',
};

const ROSE: ColorPalette = {
  name: 'rose',
  // Brand — vibrant rose
  primary: '#D4728C',
  secondary: '#D4A87E',
  // Semantic — harmonized with rose
  success: '#7EC8A0',
  warning: '#D4A87E',
  danger: '#D47070',
  info: '#A090C0',
  // Neutral — rose-tinted grays
  text: '#E8E0E4',
  subtle: '#A89BA0',
  muted: '#706468',
  border: '#443E40',
  borderActive: '#D4728C',
  // Identity — rose hierarchy
  user: '#E0A8B8',       // warm light rose — Founder stands out
  ceo: 'rainbow',
  agentLeader: '#C888A0', // medium rose — leaders
  agentWorker: '#9AAEC0', // rose-tinged slate — workers
  system: '#706468',
};

const LAVENDER: ColorPalette = {
  name: 'lavender',
  primary: '#A78BDB',
  secondary: '#D4B96A',
  success: '#7ED4A6',
  warning: '#E8B87E',
  danger: '#DB7E7E',
  info: '#5BBFB5',
  text: '#E4E2EA',
  subtle: '#9A98A4',
  muted: '#5A5864',
  border: '#3A3842',
  borderActive: '#A78BDB',
  user: '#DB8BA7',
  ceo: 'rainbow',
  agentLeader: '#A78BDB',
  agentWorker: '#5BBFB5',
  system: '#5A5864',
};

const INDIGO: ColorPalette = {
  name: 'indigo',
  primary: '#6B7FD7',
  secondary: '#D4B96A',
  success: '#5CB88A',
  warning: '#D4A94E',
  danger: '#D46B6B',
  info: '#6B9FD7',
  text: '#E0E0E8',
  subtle: '#9898A8',
  muted: '#585868',
  border: '#383848',
  borderActive: '#6B7FD7',
  user: '#7EC8A0',
  ceo: 'rainbow',
  agentLeader: '#6B7FD7',
  agentWorker: '#D4B96A',
  system: '#585868',
};

const MONO: ColorPalette = {
  name: 'mono',
  primary: '#CCCCCC',
  secondary: '#AAAAAA',
  success: '#6ABF69',
  warning: '#D4C44A',
  danger: '#D45A5A',
  info: '#CCCCCC',
  text: '#E8E8E8',
  subtle: '#999999',
  muted: '#555555',
  border: '#383838',
  borderActive: '#CCCCCC',
  user: '#E8E8E8',
  ceo: 'rainbow',
  agentLeader: '#CCCCCC',
  agentWorker: '#AAAAAA',
  system: '#555555',
};

export const PALETTES: Record<string, ColorPalette> = {
  coral: CORAL,
  rose: ROSE,
  lavender: LAVENDER,
  indigo: INDIGO,
  mono: MONO,
};

export const PALETTE_NAMES = Object.keys(PALETTES) as string[];

// --- Theme State ---

const THEME_PATH = join(homedir(), '.claudecorp', '.theme');

function loadThemeName(): string {
  try {
    if (existsSync(THEME_PATH)) {
      const name = readFileSync(THEME_PATH, 'utf-8').trim();
      if (PALETTES[name]) return name;
    }
  } catch {}
  return 'coral';
}

export function saveTheme(name: string): void {
  if (!PALETTES[name]) return;
  try { writeFileSync(THEME_PATH, name, 'utf-8'); } catch {}
  Object.assign(COLORS, PALETTES[name]!);
  Object.assign(STATUS, buildStatus());
  Object.assign(TASK_STATUS, buildTaskStatus());
  Object.assign(PRIORITY, buildPriority());
}

export function currentThemeName(): string {
  return loadThemeName();
}

// --- Live palette ---

const initial = PALETTES[loadThemeName()]!;
export const COLORS: ColorPalette = { ...initial };

function buildStatus() {
  return {
    active: { icon: '\u25CF', color: COLORS.success },
    working: { icon: '\u25CF', color: COLORS.info },
    idle: { icon: '\u25CB', color: COLORS.warning },
    suspended: { icon: '\u25CB', color: COLORS.muted },
    archived: { icon: '\u2013', color: COLORS.muted },
    offline: { icon: '\u25CB', color: COLORS.muted },
    // Project 1.11: slot has an active crash-loop breaker. Filled
    // square in danger color — visually distinct from healthy and
    // idle so tripped slots catch the eye in role rollups.
    broken: { icon: '■', color: COLORS.danger },
  };
}

function buildTaskStatus() {
  return {
    pending: { icon: '\u25CB', color: COLORS.muted },
    assigned: { icon: '\u25CF', color: COLORS.warning },
    in_progress: { icon: '\u25CF', color: COLORS.info },
    blocked: { icon: '\u25CF', color: COLORS.danger },
    completed: { icon: '\u2713', color: COLORS.success },
    failed: { icon: '\u2717', color: COLORS.danger },
    cancelled: { icon: '\u2013', color: COLORS.muted },
  };
}

function buildPriority() {
  return {
    critical: COLORS.danger,
    high: COLORS.primary,
    normal: COLORS.text,
    low: COLORS.muted,
  };
}

export const STATUS = buildStatus();
export const TASK_STATUS = buildTaskStatus();
export const PRIORITY = buildPriority();
export const BORDER_STYLE = 'round' as const;
