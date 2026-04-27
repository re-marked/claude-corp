import { describe, it, expect } from 'vitest';
import {
  ROLES,
  getRole,
  isKnownRole,
  roleIds,
  partnerRoles,
  employeeRoles,
} from '../packages/shared/src/roles.js';

/**
 * Role registry invariants for Project 1.1. The registry is pure
 * data — these tests lock the load-bearing structural properties
 * so a future edit adding / renaming entries can't silently drift.
 */

describe('role registry', () => {
  it('has at least 12 entries (initial seed)', () => {
    expect(ROLES.length).toBeGreaterThanOrEqual(12);
  });

  it('every id is kebab-case', () => {
    for (const r of ROLES) {
      expect(r.id, `role id "${r.id}"`).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it('every id is unique', () => {
    const ids = ROLES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every displayName is a non-empty string', () => {
    for (const r of ROLES) {
      expect(r.displayName.length).toBeGreaterThan(0);
    }
  });

  it('tier ∈ {decree, role-lead, worker}', () => {
    for (const r of ROLES) {
      expect(['decree', 'role-lead', 'worker']).toContain(r.tier);
    }
  });

  it('defaultKind is consistent with tier (decree + role-lead → partner; worker → employee)', () => {
    for (const r of ROLES) {
      if (r.tier === 'decree' || r.tier === 'role-lead') {
        expect(r.defaultKind, `${r.id} (${r.tier})`).toBe('partner');
      } else if (r.tier === 'worker') {
        expect(r.defaultKind, `${r.id} (${r.tier})`).toBe('employee');
      }
    }
  });

  it('description, purpose, communication are all non-empty', () => {
    for (const r of ROLES) {
      expect(r.description.length, `${r.id}.description`).toBeGreaterThan(0);
      expect(r.purpose.length, `${r.id}.purpose`).toBeGreaterThan(0);
      expect(r.communication.length, `${r.id}.communication`).toBeGreaterThan(0);
    }
  });

  it('contains the corp-sacred Partners by decree (CEO, Herald, HR, Adviser, Sexton)', () => {
    // Project 1.12: Janitor retired; Pressman + Editor took over the
    // merge-lane work as worker-tier Employees. Decree count went
    // from 6 to 5.
    const decrees = ROLES.filter((r) => r.tier === 'decree').map((r) => r.id);
    for (const required of ['ceo', 'herald', 'hr', 'adviser', 'sexton']) {
      expect(decrees).toContain(required);
    }
    // Affirmatively check janitor is gone — guards against
    // accidental resurrection in the registry.
    expect(decrees).not.toContain('janitor');
  });
});

describe('registry helpers', () => {
  it('getRole returns the entry for a known id', () => {
    const ceo = getRole('ceo');
    expect(ceo).toBeDefined();
    expect(ceo!.displayName).toBe('CEO');
  });

  it('getRole returns undefined for unknown id (no throw)', () => {
    expect(getRole('nonexistent-role')).toBeUndefined();
  });

  it('isKnownRole accepts known ids, rejects unknown', () => {
    expect(isKnownRole('backend-engineer')).toBe(true);
    expect(isKnownRole('nonexistent-role')).toBe(false);
  });

  it('roleIds() returns every registered id', () => {
    const ids = roleIds();
    expect(ids.length).toBe(ROLES.length);
    for (const r of ROLES) {
      expect(ids).toContain(r.id);
    }
  });

  it('partnerRoles() filters to defaultKind=partner', () => {
    const partners = partnerRoles();
    for (const r of partners) {
      expect(r.defaultKind).toBe('partner');
    }
  });

  it('employeeRoles() filters to defaultKind=employee', () => {
    const employees = employeeRoles();
    for (const r of employees) {
      expect(r.defaultKind).toBe('employee');
    }
  });

  it('partnerRoles + employeeRoles partition the registry', () => {
    expect(partnerRoles().length + employeeRoles().length).toBe(ROLES.length);
  });
});
