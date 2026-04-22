import { describe, it, expect } from 'vitest';
import {
  buildHookSettings,
  type HookSettingsOpts,
} from '../../packages/shared/src/templates/hook-settings.js';

/**
 * Tests for the Project 0.7.2 Claude Code hook-settings generator.
 * Pure function; no I/O. These pin the load-bearing invariants that
 * agent-setup relies on when writing `.claude/settings.json` at hire
 * time.
 *
 * Shape recap: Claude Code expects two-level nesting per event —
 *   hooks.<Event>: [ { matcher: string, hooks: [ {type, command} ] } ]
 * A probe run on 2026-04-22 confirmed that the flat {command} shape
 * (which earlier versions of this module emitted) is rejected at
 * settings-parse time and all hooks silently skipped.
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

describe('buildHookSettings — Claude Code nested shape (matcher + hooks array)', () => {
  it('each event value is an array of matcher-groups, not a flat list of commands', () => {
    const { hooks } = buildHookSettings(partnerOpts());
    for (const key of ['SessionStart', 'PreCompact', 'Stop', 'UserPromptSubmit'] as const) {
      const groups = hooks[key];
      expect(Array.isArray(groups)).toBe(true);
      expect(groups).toHaveLength(1);
      // Each group must have the matcher + hooks keys Claude Code expects.
      expect(groups![0]).toHaveProperty('matcher');
      expect(groups![0]).toHaveProperty('hooks');
      expect(typeof groups![0]!.matcher).toBe('string');
      expect(Array.isArray(groups![0]!.hooks)).toBe(true);
    }
  });

  it('inner hooks array contains { type: "command", command: string } entries', () => {
    const { hooks } = buildHookSettings(partnerOpts());
    for (const key of ['SessionStart', 'PreCompact', 'Stop', 'UserPromptSubmit'] as const) {
      const inner = hooks[key]![0]!.hooks;
      // PreCompact gets two commands (audit + wtf) under one matcher;
      // the other events get one. All entries must be the same shape.
      expect(inner.length).toBeGreaterThanOrEqual(1);
      for (const entry of inner) {
        expect(entry).toEqual({ type: 'command', command: expect.any(String) });
      }
    }
  });

  it('matcher is empty string for all four events (no tool-filtering semantics apply to these triggers)', () => {
    const { hooks } = buildHookSettings(partnerOpts());
    for (const key of ['SessionStart', 'PreCompact', 'Stop', 'UserPromptSubmit'] as const) {
      expect(hooks[key]![0]!.matcher).toBe('');
    }
  });

  it('does NOT emit the legacy flat { command } shape that Claude Code rejects', () => {
    // Regression guard: a prior version nested only one level
    // (hooks.Stop[0].command). Settings with that shape are silently
    // dropped at parse time, meaning zero hooks fire in production.
    const { hooks } = buildHookSettings(partnerOpts());
    for (const key of ['SessionStart', 'PreCompact', 'Stop', 'UserPromptSubmit'] as const) {
      expect(hooks[key]![0]).not.toHaveProperty('command');
    }
  });
});

describe('buildHookSettings — each hook command content', () => {
  it('SessionStart fires `cc-cli wtf --agent <slug> --hook`', () => {
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'ceo' }));
    expect(hooks.SessionStart![0]!.hooks[0]!.command).toBe('cc-cli wtf --agent ceo --hook');
  });

  it('PreCompact (Partner) fires audit + wtf in order — audit gates, wtf refreshes context', () => {
    // Audit MUST run first: if it blocks, compaction is rejected and
    // wtf's context-refresh would be wasted work. Wtf second: on
    // approve, the post-compact summary is built against fresh state.
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'ceo' }));
    const commands = hooks.PreCompact![0]!.hooks.map((h) => h.command);
    expect(commands).toEqual([
      'cc-cli audit --agent ceo',
      'cc-cli wtf --agent ceo --hook',
    ]);
  });

  it('Stop fires `cc-cli audit --agent <slug>` — audit gate', () => {
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'ceo' }));
    expect(hooks.Stop![0]!.hooks[0]!.command).toBe('cc-cli audit --agent ceo');
  });

  it('Stop is present for BOTH kinds (audit gate applies to everyone)', () => {
    const partner = buildHookSettings(partnerOpts());
    const employee = buildHookSettings(employeeOpts());
    expect(partner.hooks.Stop).toBeDefined();
    expect(employee.hooks.Stop).toBeDefined();
  });

  it('UserPromptSubmit (Partner) fires `cc-cli inbox check --agent <slug> --inject`', () => {
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'ceo' }));
    expect(hooks.UserPromptSubmit![0]!.hooks[0]!.command).toBe(
      'cc-cli inbox check --agent ceo --inject',
    );
  });
});

describe('buildHookSettings — slug interpolation', () => {
  it('interpolates the agent slug into every hook command', () => {
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'herald' }));
    for (const key of ['SessionStart', 'PreCompact', 'Stop', 'UserPromptSubmit'] as const) {
      expect(hooks[key]![0]!.hooks[0]!.command).toContain('--agent herald');
    }
  });

  it('handles slugs with hyphens correctly (e.g. "backend-engineer")', () => {
    const { hooks } = buildHookSettings(employeeOpts({ agentSlug: 'backend-engineer' }));
    expect(hooks.SessionStart![0]!.hooks[0]!.command).toBe(
      'cc-cli wtf --agent backend-engineer --hook',
    );
    expect(hooks.Stop![0]!.hooks[0]!.command).toBe('cc-cli audit --agent backend-engineer');
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

  it('serialized output matches Claude Code\'s documented example structure — smoke test', () => {
    // The shape we must emit, per Claude Code docs (hooks.md):
    //   hooks.Event: [ { matcher: string, hooks: [ {type,command} ] } ]
    // This test doesn't just sample one path — it walks every emitted
    // entry and confirms the full nested contract.
    const { hooks } = buildHookSettings(partnerOpts({ agentSlug: 'x' }));
    for (const event of Object.keys(hooks) as (keyof typeof hooks)[]) {
      const groups = hooks[event]!;
      for (const group of groups) {
        expect(group).toEqual({
          matcher: expect.any(String),
          hooks: expect.arrayContaining([
            expect.objectContaining({
              type: 'command',
              command: expect.stringContaining('--agent x'),
            }),
          ]),
        });
      }
    }
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
    expect(a.hooks.SessionStart![0]!.hooks[0]!.command).toContain('--agent a');
    expect(b.hooks.SessionStart![0]!.hooks[0]!.command).toContain('--agent b');
  });
});
