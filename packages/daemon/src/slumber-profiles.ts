/**
 * SLUMBER Profiles — presets that change how the corporation behaves
 * during autonomous mode. Not just interval tweaks — each profile
 * injects a distinct mood, focus, and pacing into the CEO's behavior.
 *
 * Profiles are stored in slumber-profiles.json at corp root.
 * Default profiles are installed on first use.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────

export interface SlumberProfile {
  /** Unique slug (e.g., 'night-owl', 'sprint') */
  id: string;
  /** Display name */
  name: string;
  /** One-line description */
  description: string;
  /** Tick interval in ms (how often CEO checks in) */
  tickIntervalMs: number;
  /** Default duration in ms (null = indefinite) */
  durationMs: number | null;
  /** Max ticks before auto-stop (null = unlimited) */
  budgetTicks: number | null;
  /**
   * Mood — injected into the tick <context> tag. Changes how the CEO
   * communicates and what it prioritizes. This is what makes profiles
   * feel genuinely different, not just interval changes.
   */
  mood: string;
  /**
   * Focus directive — tells the CEO what to prioritize during this
   * SLUMBER session. Injected into the first tick.
   */
  focus: string;
  /**
   * Conscription strategy:
   * - 'ceo-only': just the CEO (light monitoring)
   * - 'active-contracts': CEO + leaders/workers on active contracts
   * - 'all-agents': everyone gets ticks (maximum throughput)
   */
  conscription: 'ceo-only' | 'active-contracts' | 'all-agents';
  /** Whether this is a built-in profile (can't be deleted) */
  builtin: boolean;
}

// ── Default Profiles ───────────────────────────────────────────────

export const DEFAULT_PROFILES: SlumberProfile[] = [
  {
    id: 'night-owl',
    name: 'Night Owl',
    description: 'Deep work while you sleep — long intervals, quiet focus, no rush',
    tickIntervalMs: 15 * 60 * 1000, // 15 minutes
    durationMs: 8 * 60 * 60 * 1000, // 8 hours
    budgetTicks: null,
    mood: [
      'The corp is in Night Owl mode. The Founder is asleep.',
      'Work quietly and deeply. Take your time with each task.',
      'No urgency — quality over speed. Think before acting.',
      'Write detailed observations. The Founder reads them in the morning.',
      'If you hit a blocker, note it and move on. Don\'t spin.',
    ].join(' '),
    focus: [
      'Focus on deep work: code reviews, research, writing documentation,',
      'refactoring, and tasks that benefit from uninterrupted concentration.',
      'Avoid noisy operations (hiring, creating contracts) unless critical.',
    ].join(' '),
    conscription: 'active-contracts',
    builtin: true,
  },
  {
    id: 'school-day',
    name: 'School Day',
    description: 'CEO manages the corp while Mark is at school — moderate pace, full delegation',
    tickIntervalMs: 10 * 60 * 1000, // 10 minutes
    durationMs: 7 * 60 * 60 * 1000, // 7 hours (8am-3pm)
    budgetTicks: null,
    mood: [
      'The Founder is at school and won\'t be checking in.',
      'You have full autonomy. Run the corp like it\'s yours.',
      'Delegate actively — hire workers if needed, hand tasks, review work.',
      'Make decisions confidently. The Founder trusts your judgment.',
      'Prepare a thorough briefing for when they return.',
    ].join(' '),
    focus: [
      'Full CEO mode: manage projects, delegate to team leads,',
      'review completed work, unblock stuck agents, keep momentum.',
      'Create tasks for any gaps you identify. Hire if understaffed.',
      'The Founder expects progress when they return, not questions.',
    ].join(' '),
    conscription: 'all-agents',
    builtin: true,
  },
  {
    id: 'sprint',
    name: 'Sprint',
    description: 'Maximum throughput — fast ticks, all agents, aggressive execution',
    tickIntervalMs: 2 * 60 * 1000, // 2 minutes
    durationMs: 2 * 60 * 60 * 1000, // 2 hours
    budgetTicks: 200,
    mood: [
      'SPRINT MODE. Maximum velocity. Every tick counts.',
      'Move fast. Ship fast. Review fast. Don\'t overthink.',
      'If a task takes more than 2 ticks, break it down or delegate.',
      'Bias toward shipping over perfecting.',
      'Checkpoint every 5 ticks — brief, numbers only.',
    ].join(' '),
    focus: [
      'Ship as much as possible in the sprint window.',
      'Prioritize: in-progress tasks first, then pending, then new work.',
      'Every agent should be busy. If someone is idle, hand them work.',
      'Track: tasks started, tasks completed, blockers hit.',
    ].join(' '),
    conscription: 'all-agents',
    builtin: true,
  },
  {
    id: 'guard',
    name: 'Guard Duty',
    description: 'Light monitoring — just watch for problems, don\'t start new work',
    tickIntervalMs: 30 * 60 * 1000, // 30 minutes
    durationMs: null, // indefinite
    budgetTicks: null,
    mood: [
      'Guard duty. You\'re watching the fort, not building it.',
      'Check agent health. Check for errors. Check for blockers.',
      'If everything is fine, SLEEP. Don\'t create work that doesn\'t exist.',
      'Only act on genuine problems — crashed agents, failed builds, P0 blockers.',
      'Be the night watchman, not the night shift.',
    ].join(' '),
    focus: [
      'Monitor only: agent health, error logs, blocker escalations.',
      'Do NOT start new tasks, hire agents, or create contracts.',
      'If a critical issue appears, fix it. Otherwise, SLEEP.',
    ].join(' '),
    conscription: 'ceo-only',
    builtin: true,
  },
];

// ── Storage ────────────────────────────────────────────────────────

const PROFILES_FILE = 'slumber-profiles.json';

/** Load profiles from disk. Installs defaults on first access. */
export function loadProfiles(corpRoot: string): SlumberProfile[] {
  const filePath = join(corpRoot, PROFILES_FILE);

  if (!existsSync(filePath)) {
    // First access — install defaults
    writeFileSync(filePath, JSON.stringify(DEFAULT_PROFILES, null, 2), 'utf-8');
    log(`[slumber] Installed ${DEFAULT_PROFILES.length} default profiles`);
    return [...DEFAULT_PROFILES];
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as SlumberProfile[];
  } catch {
    return [...DEFAULT_PROFILES];
  }
}

/** Save profiles to disk. */
export function saveProfiles(corpRoot: string, profiles: SlumberProfile[]): void {
  const filePath = join(corpRoot, PROFILES_FILE);
  writeFileSync(filePath, JSON.stringify(profiles, null, 2), 'utf-8');
}

/** Get a profile by ID. */
export function getProfile(corpRoot: string, id: string): SlumberProfile | null {
  const profiles = loadProfiles(corpRoot);
  return profiles.find(p => p.id === id) ?? null;
}

/** Add or update a custom profile. */
export function upsertProfile(corpRoot: string, profile: SlumberProfile): void {
  const profiles = loadProfiles(corpRoot);
  const idx = profiles.findIndex(p => p.id === profile.id);
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }
  saveProfiles(corpRoot, profiles);
}

/** Delete a custom profile (can't delete builtins). */
export function deleteProfile(corpRoot: string, id: string): boolean {
  const profiles = loadProfiles(corpRoot);
  const profile = profiles.find(p => p.id === id);
  if (!profile || profile.builtin) return false;
  saveProfiles(corpRoot, profiles.filter(p => p.id !== id));
  return true;
}

/** Format a profile for display. */
export function formatProfile(p: SlumberProfile): string {
  const duration = p.durationMs
    ? `${Math.round(p.durationMs / 3_600_000)}h`
    : 'indefinite';
  const interval = p.tickIntervalMs >= 3_600_000
    ? `${Math.round(p.tickIntervalMs / 3_600_000)}h`
    : `${Math.round(p.tickIntervalMs / 60_000)}m`;
  const budget = p.budgetTicks ? `${p.budgetTicks} ticks max` : 'unlimited';

  return [
    `${p.name} (${p.id})${p.builtin ? ' [built-in]' : ''}`,
    `  ${p.description}`,
    `  Interval: ${interval} · Duration: ${duration} · Budget: ${budget}`,
    `  Conscription: ${p.conscription}`,
    `  Mood: "${p.mood.slice(0, 80)}..."`,
  ].join('\n');
}
