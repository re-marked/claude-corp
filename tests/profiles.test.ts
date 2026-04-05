import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadProfiles,
  getProfile,
  validateProfile,
  formatProfile,
  DEFAULT_PROFILES,
} from '../packages/daemon/src/slumber-profiles.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'claude-corp-test-profiles');

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

describe('SLUMBER profiles', () => {
  it('loadProfiles() installs 4 defaults on first access', () => {
    const profiles = loadProfiles(TEST_DIR);
    expect(profiles).toHaveLength(4);
    expect(profiles.map(p => p.id)).toContain('night-owl');
    expect(profiles.map(p => p.id)).toContain('school-day');
    expect(profiles.map(p => p.id)).toContain('sprint');
    expect(profiles.map(p => p.id)).toContain('guard');
  });

  it('getProfile() returns the correct profile by ID', () => {
    loadProfiles(TEST_DIR); // Install defaults
    const sprint = getProfile(TEST_DIR, 'sprint');
    expect(sprint).not.toBeNull();
    expect(sprint!.name).toBe('Sprint');
    expect(sprint!.icon).toBe('⚡');
    expect(sprint!.tickIntervalMs).toBe(2 * 60 * 1000);
    expect(sprint!.budgetTicks).toBe(200);
    expect(sprint!.conscription).toBe('all-agents');
  });

  it('getProfile() returns null for unknown ID', () => {
    loadProfiles(TEST_DIR);
    expect(getProfile(TEST_DIR, 'nonexistent')).toBeNull();
  });

  it('each profile has a unique icon', () => {
    const icons = DEFAULT_PROFILES.map(p => p.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('each profile has mood and focus strings', () => {
    for (const p of DEFAULT_PROFILES) {
      expect(p.mood.length).toBeGreaterThan(50);
      expect(p.focus.length).toBeGreaterThan(30);
    }
  });

  it('validateProfile() catches missing senderId', () => {
    expect(validateProfile({ id: '', name: 'test', tickIntervalMs: 60000, mood: 'test' }))
      .toContain('id must be');
  });

  it('validateProfile() catches tick interval too short', () => {
    expect(validateProfile({ id: 'test', name: 'test', tickIntervalMs: 1000, mood: 'test' }))
      .toContain('tickIntervalMs must be >= 30s');
  });

  it('validateProfile() returns null for valid profile', () => {
    expect(validateProfile({
      id: 'custom',
      name: 'Custom',
      tickIntervalMs: 60000,
      mood: 'Be productive',
    })).toBeNull();
  });

  it('formatProfile() includes icon and name', () => {
    const sprint = DEFAULT_PROFILES.find(p => p.id === 'sprint')!;
    const formatted = formatProfile(sprint);
    expect(formatted).toContain('⚡');
    expect(formatted).toContain('Sprint');
    expect(formatted).toContain('sprint');
  });
});
