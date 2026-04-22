import { describe, it, expect } from 'vitest';
import {
  buildHookSettings,
  type HookSettingsOpts,
} from '../../packages/shared/src/templates/hook-settings.js';

/**
 * Tests for the Project 0.7.2 Claude Code hook-settings generator.
 * Pure function; no I/O. These pin the load-bearing invariants that
 * agent-setup will rely on when writing \`.claude/settings.json\` at
 * hire time in a follow-up PR.
 */

function partnerOpts(overrides: Partial<HookSettingsOpts> = {}): HookSettingsOpts {
  return { kind: 'partner', agentSlug: 'ceo', ...overrides };
}

function employeeOpts(overrides: Partial<HookSettingsOpts> = {}): HookSettingsOpts {
  return { kind: 'employee', agentSlug: 'toast', ...overrides };
}

describe('buildHookSettings — top-level shape', () => {
  it('produces { hooks: {...} } (Claude Code settings.json schema)', () => {
    const out = buildHookSettings(partnerOpts());
    expect(out).toHaveProperty('hooks');
    expect(typeof out.hooks).toBe('object');
  });

  it('Partners get 4 hook events wired (SessionStart, PreCompact, Stop, UserPromptSubmit)', () => {
    const { hooks } = buildHookSettings(partnerOpts());
    const keys = Object.keys(hooks).sort();
    expect(keys).toEqual(['PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  });

  it('Employees get 2 hook events wired (SessionStart + Stop only)', () => {
    const { hooks } = buildHookSettings(employeeOpts());
    const keys = Object.keys(hooks).sort();
    expect(keys).toEqual(['SessionStart', 'Stop']);
  });

  it('Employees explicitly omit PreCompact (per-step handoff model, not compaction)', () => {
    const { hooks } = buildHookSettings(employeeOpts());
    expect(hooks.PreCompact).toBeUndefined();
  });

  it('Employees explicitly omit UserPromptSubmit (founder DMs go to Partners, not Employees)', () => {
    const { hooks } = buildHookSettings(employeeOpts());
    expect(hooks.UserPromptSubmit).toBeUndefined();
  });
});

describe('buildHookSettings — each hook command shape', () => {
  it('each hook entry is an array with one { command } object', () => {
    const { hooks } = buildHookSettings(partnerOpts());
    for (const key of ['SessionStart', 'PreCompact', 'Stop', 'UserPromptSubmit'] as const) {
      expect(Array.isArray(hooks[key])).toBe(true);
      expect(hooks[key]).toHaveLength(1);
      expect(hooks[key]![0]).toHaveProperty('command');
      expect(typeof hooks[key]![0]!.command).toBe('string');
    }
  });

  it('SessionStart fires `cc-cli wtf --agent <slug> --hook`', () => {
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'ceo' }));
    expect(hooks.SessionStart![0]!.command).toBe('cc-cli wtf --agent ceo --hook');
  });

  it('PreCompact (Partner) fires `cc-cli wtf --agent <slug> --hook` — refreshes context before compaction so summary survives', () => {
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'ceo' }));
    expect(hooks.PreCompact![0]!.command).toBe('cc-cli wtf --agent ceo --hook');
  });

  it('Stop fires `cc-cli audit --agent <slug>` — audit gate', () => {
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'ceo' }));
    expect(hooks.Stop![0]!.command).toBe('cc-cli audit --agent ceo');
  });

  it('Stop is present for BOTH kinds (audit gate applies to everyone)', () => {
    const partner = buildHookSettings(partnerOpts());
    const employee = buildHookSettings(employeeOpts());
    expect(partner.hooks.Stop).toBeDefined();
    expect(employee.hooks.Stop).toBeDefined();
  });

  it('UserPromptSubmit (Partner) fires `cc-cli inbox check --agent <slug> --inject`', () => {
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'ceo' }));
    expect(hooks.UserPromptSubmit![0]!.command).toBe('cc-cli inbox check --agent ceo --inject');
  });
});

describe('buildHookSettings — slug interpolation', () => {
  it('interpolates the agent slug into every hook command', () => {
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'herald' }));
    for (const key of ['SessionStart', 'PreCompact', 'Stop', 'UserPromptSubmit'] as const) {
      expect(hooks[key]![0]!.command).toContain('--agent herald');
    }
  });

  it('handles slugs with hyphens correctly (e.g. "backend-engineer")', () => {
    const { hooks } = buildHookSettings(employeeOpts({ agentSlug: 'backend-engineer' }));
    expect(hooks.SessionStart![0]!.command).toBe('cc-cli wtf --agent backend-engineer --hook');
    expect(hooks.Stop![0]!.command).toBe('cc-cli audit --agent backend-engineer');
  });
});

describe('buildHookSettings — serialization sanity', () => {
  it('round-trips through JSON.stringify + parse without loss', () => {
    const original = buildHookSettings(partnerOpts());
    const serialized = JSON.stringify(original, null, 2);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual(original);
  });

  it('serialized output is valid JSON (no function values, no undefined leaks)', () => {
    const serialized = JSON.stringify(buildHookSettings(partnerOpts()));
    // Would throw if any illegal JSON value snuck through
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});

describe('buildHookSettings — determinism', () => {
  it('same opts produce equal output', () => {
    const opts = partnerOpts();
    expect(buildHookSettings(opts)).toEqual(buildHookSettings(opts));
  });

  it('output does not mutate shared state between calls (each call returns a fresh object)', () => {
    const a = buildHookSettings(partnerOpts({ agentSlug: 'a' }));
    const b = buildHookSettings(partnerOpts({ agentSlug: 'b' }));
    // If the function reused an internal object, b's mutation would bleed into a
    expect(a.hooks.SessionStart![0]!.command).toContain('--agent a');
    expect(b.hooks.SessionStart![0]!.command).toContain('--agent b');
  });
});
