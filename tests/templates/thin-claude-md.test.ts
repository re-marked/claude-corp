import { describe, it, expect } from 'vitest';
import {
  buildThinClaudeMd,
  type ThinClaudeMdOpts,
} from '../../packages/shared/src/templates/claude-md.js';

/**
 * Tests for the Project 0.7 thin CLAUDE.md template — the survival
 * anchor that replaces the fat @import-heavy CLAUDE.md for new hires.
 * Agent-authored soul files + live operational state @imported; the
 * corp manual + situational context comes dynamically via \`cc-cli wtf\`.
 *
 * Pure template, no I/O. These tests pin the structural contract that
 * agent-setup (a later PR) will rely on when writing CLAUDE.md at hire
 * time.
 */

function partnerOpts(overrides: Partial<ThinClaudeMdOpts> = {}): ThinClaudeMdOpts {
  return {
    kind: 'partner',
    displayName: 'CEO',
    role: 'CEO',
    corpName: 'my-corporation',
    workspacePath: '/home/mark/.claudecorp/my-corporation/agents/ceo',
    ...overrides,
  };
}

function employeeOpts(overrides: Partial<ThinClaudeMdOpts> = {}): ThinClaudeMdOpts {
  return {
    kind: 'employee',
    displayName: 'Toast',
    role: 'Backend Engineer',
    corpName: 'my-corporation',
    workspacePath: '/home/mark/.claudecorp/my-corporation/projects/platform/agents/toast',
    ...overrides,
  };
}

describe('buildThinClaudeMd — shape + size', () => {
  it('starts with the displayName heading', () => {
    expect(buildThinClaudeMd(partnerOpts()).startsWith('# CEO\n')).toBe(true);
    expect(buildThinClaudeMd(employeeOpts()).startsWith('# Toast\n')).toBe(true);
  });

  it('opening sentence names identity + kind + corp', () => {
    const out = buildThinClaudeMd(partnerOpts());
    expect(out).toContain('You are CEO, a CEO (partner) in the my-corporation corporation.');
  });

  it('stays thin — 0.7 design goal is ~60 lines, generous cap at 100', () => {
    // The whole point is "survival anchor only, no reference content."
    // If this grows to 200+ lines, the architecture has drifted.
    const partnerLines = buildThinClaudeMd(partnerOpts()).split('\n').length;
    const employeeLines = buildThinClaudeMd(employeeOpts()).split('\n').length;
    expect(partnerLines).toBeLessThan(100);
    expect(employeeLines).toBeLessThan(100);
  });

  it('ends with a trailing newline (clean concatenation)', () => {
    expect(buildThinClaudeMd(partnerOpts()).endsWith('\n')).toBe(true);
    expect(buildThinClaudeMd(employeeOpts()).endsWith('\n')).toBe(true);
  });
});

describe('buildThinClaudeMd — survival protocol', () => {
  it('tells the agent how to recover from disorientation', () => {
    const out = buildThinClaudeMd(partnerOpts());
    expect(out).toContain('## Survival protocol');
    expect(out).toMatch(/run `cc-cli wtf`/);
    expect(out).toMatch(/Bash tool call/);
  });

  it('explains that wtf regenerates CORP.md + emits system-reminder', () => {
    const out = buildThinClaudeMd(partnerOpts());
    expect(out).toMatch(/regenerates CORP\.md/);
    expect(out).toMatch(/system-reminder/);
  });
});

describe('buildThinClaudeMd — workspace discipline', () => {
  it('tells the agent where they live + interpolates the path', () => {
    const out = buildThinClaudeMd(partnerOpts());
    expect(out).toContain('## Workspace discipline');
    expect(out).toContain('/home/mark/.claudecorp/my-corporation/agents/ceo');
  });

  it('forbids writing outside own sandbox', () => {
    const out = buildThinClaudeMd(partnerOpts());
    expect(out).toMatch(/off-limits/i);
    expect(out).toMatch(/never write outside your own sandbox/i);
  });
});

describe('buildThinClaudeMd — the single critical rule', () => {
  it('Employees see the hand-complete + Stop-hook rule', () => {
    const out = buildThinClaudeMd(employeeOpts());
    expect(out).toContain('## The single critical rule');
    expect(out).toMatch(/cc-cli hand-complete/);
    expect(out).toMatch(/Stop hook will audit/);
  });

  it('Partners see the /compact + PreCompact + no-push-to-main rule', () => {
    const out = buildThinClaudeMd(partnerOpts());
    expect(out).toContain('## The single critical rule');
    expect(out).toMatch(/\/compact/);
    expect(out).toMatch(/PreCompact hook audits/);
    expect(out).toMatch(/Never push to main directly/);
  });

  it('Employees do NOT see the Partner-only no-push-to-main rule in their critical-rule block', () => {
    // Employees still shouldn't push to main, but the Partner-specific
    // red-line framing is in CORP.md's Red Lines section. The critical
    // rule block is kind-specific — one thing each kind must remember
    // above all else.
    const out = buildThinClaudeMd(employeeOpts());
    const criticalBlock = out
      .split('## The single critical rule')[1]!
      .split('## ')[0]!;
    expect(criticalBlock).not.toMatch(/Never push to main directly/);
  });

  it('Partners do NOT see the hand-complete rule (Employees use that)', () => {
    const out = buildThinClaudeMd(partnerOpts());
    const criticalBlock = out
      .split('## The single critical rule')[1]!
      .split('## ')[0]!;
    expect(criticalBlock).not.toMatch(/cc-cli hand-complete/);
  });
});

describe('buildThinClaudeMd — @imports (agent-authored files only)', () => {
  const requiredImports = [
    '@./SOUL.md',
    '@./IDENTITY.md',
    '@./USER.md',
    '@./MEMORY.md',
    '@./STATUS.md',
    '@./TASKS.md',
  ] as const;

  it.each(requiredImports)('imports %s', (path) => {
    expect(buildThinClaudeMd(partnerOpts())).toContain(path);
    expect(buildThinClaudeMd(employeeOpts())).toContain(path);
  });

  it('does NOT import AGENTS.md (content moved to CORP.md)', () => {
    expect(buildThinClaudeMd(partnerOpts())).not.toContain('@./AGENTS.md');
    expect(buildThinClaudeMd(employeeOpts())).not.toContain('@./AGENTS.md');
  });

  it('does NOT import TOOLS.md (content moved to CORP.md)', () => {
    expect(buildThinClaudeMd(partnerOpts())).not.toContain('@./TOOLS.md');
    expect(buildThinClaudeMd(employeeOpts())).not.toContain('@./TOOLS.md');
  });

  it('does NOT import HEARTBEAT.md (legacy wake cycle replaced by autoemon)', () => {
    expect(buildThinClaudeMd(partnerOpts())).not.toContain('@./HEARTBEAT.md');
  });

  it('does NOT import BOOTSTRAP.md unconditionally (that file self-deletes after onboarding; 0.7.2 agent-setup handles first-run injection separately)', () => {
    // We leave BOOTSTRAP.md out of the steady-state thin template.
    // First-run injection is agent-setup's job, not the template's.
    expect(buildThinClaudeMd(partnerOpts())).not.toContain('@./BOOTSTRAP.md');
  });

  it('does NOT import INBOX.md — inbox is chit-backed, not a file', () => {
    expect(buildThinClaudeMd(partnerOpts())).not.toContain('@./INBOX.md');
    expect(buildThinClaudeMd(employeeOpts())).not.toContain('@./INBOX.md');
  });
});

describe('buildThinClaudeMd — inbox + dynamic-injection sections', () => {
  it('points at cc-cli inbox list + explains wtf header summary', () => {
    const out = buildThinClaudeMd(partnerOpts());
    expect(out).toContain('## Your inbox');
    expect(out).toMatch(/cc-cli inbox list/);
    expect(out).toMatch(/wtf header shows the summary/);
  });

  it('tells the agent Tier 3 items block session completion via audit', () => {
    const out = buildThinClaudeMd(partnerOpts());
    expect(out).toMatch(/Tier 3/);
    expect(out).toMatch(/block session completion/i);
  });

  it('final section explains the dynamic-injection model + forbids re-@importing AGENTS/TOOLS', () => {
    const out = buildThinClaudeMd(partnerOpts());
    expect(out).toContain('## What you\'ll get dynamically');
    expect(out).toMatch(/SessionStart auto-runs/);
    expect(out).toMatch(/Don't `@import` AGENTS\.md or TOOLS\.md/);
    expect(out).toMatch(/no longer exist as workspace files/);
  });
});

describe('buildThinClaudeMd — determinism', () => {
  it('same opts produce identical output (no time/randomness leakage)', () => {
    const opts = partnerOpts();
    expect(buildThinClaudeMd(opts)).toBe(buildThinClaudeMd(opts));
  });

  it('output contains no ISO timestamps (caller adds timestamps via wtf header)', () => {
    const out = buildThinClaudeMd(partnerOpts());
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('buildThinClaudeMd — interpolation', () => {
  it('corpName appears in identity line', () => {
    expect(buildThinClaudeMd(partnerOpts({ corpName: 'acme-corp' }))).toContain(
      'in the acme-corp corporation',
    );
  });

  it('role appears in identity line + carries through any role string', () => {
    expect(buildThinClaudeMd(partnerOpts({ role: 'Herald' }))).toContain('a Herald (partner)');
    expect(buildThinClaudeMd(employeeOpts({ role: 'QA Engineer' }))).toContain('a QA Engineer (employee)');
  });

  it('displayName interpolates into heading + identity line', () => {
    const out = buildThinClaudeMd(employeeOpts({ displayName: 'Copper' }));
    expect(out.startsWith('# Copper\n')).toBe(true);
    expect(out).toContain('You are Copper,');
  });
});
