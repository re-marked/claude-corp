import { describe, it, expect } from 'vitest';
import {
  buildWtfHeader,
  type WtfHeaderOpts,
  type WtfInboxSummary,
} from '../../packages/shared/src/templates/wtf-header.js';

/**
 * Pure-template tests for the wtf situational header. No I/O; caller owns
 * clock + Casket read + inbox query. These tests pin the structural
 * contract the \`cc-cli wtf\` command (0.7.1 C3) assembles into the final
 * system-reminder block.
 */

function emptyInbox(): WtfInboxSummary {
  return { tier3Count: 0, tier2Count: 0, tier1Count: 0 };
}

function partnerOpts(overrides: Partial<WtfHeaderOpts> = {}): WtfHeaderOpts {
  return {
    kind: 'partner',
    displayName: 'CEO',
    role: 'CEO',
    workspacePath: '/home/mark/.claudecorp/my-corporation/agents/ceo',
    corpMdPath: '/home/mark/.claudecorp/my-corporation/agents/ceo/CORP.md',
    generatedAt: '2026-04-22T14:30:00.000Z',
    inboxSummary: emptyInbox(),
    ...overrides,
  };
}

function employeeOpts(overrides: Partial<WtfHeaderOpts> = {}): WtfHeaderOpts {
  return {
    kind: 'employee',
    displayName: 'Toast',
    role: 'Backend Engineer',
    workspacePath: '/home/mark/.claudecorp/my-corporation/projects/platform/agents/toast',
    corpMdPath: '/home/mark/.claudecorp/my-corporation/projects/platform/agents/toast/CORP.md',
    generatedAt: '2026-04-22T14:30:00.000Z',
    inboxSummary: emptyInbox(),
    ...overrides,
  };
}

describe('buildWtfHeader — identity line', () => {
  it('opens with "You are <name>, <role> (<kind>)."', () => {
    const partner = buildWtfHeader(partnerOpts());
    expect(partner).toContain('You are CEO, CEO (partner).');

    const employee = buildWtfHeader(employeeOpts());
    expect(employee).toContain('You are Toast, Backend Engineer (employee).');
  });

  it('workspace path appears on its own line', () => {
    const out = buildWtfHeader(partnerOpts());
    expect(out).toMatch(/Sandbox: \/home\/mark\/\.claudecorp\/my-corporation\/agents\/ceo/);
  });
});

describe('buildWtfHeader — current task block', () => {
  it('shows "none" fallback + escalation hint when no current task', () => {
    const out = buildWtfHeader(partnerOpts());
    expect(out).toContain('Current task: none.');
    expect(out).toMatch(/Check your INBOX and TASKS/i);
  });

  it('renders current task with chit id + title when present', () => {
    const out = buildWtfHeader(
      partnerOpts({
        currentTask: { chitId: 'chit-t-1f4b9c2e', title: 'Wire cc-cli chit show' },
      }),
    );
    expect(out).toContain('Current task: chit-t-1f4b9c2e — Wire cc-cli chit show');
  });
});

describe('buildWtfHeader — inbox block', () => {
  it('says "Inbox: empty." when all tiers are zero', () => {
    const out = buildWtfHeader(partnerOpts({ inboxSummary: emptyInbox() }));
    expect(out).toContain('Inbox: empty.');
  });

  it('renders the "ambient only, auto-expire" case without cluttering', () => {
    const out = buildWtfHeader(
      partnerOpts({ inboxSummary: { tier3Count: 0, tier2Count: 0, tier1Count: 5 } }),
    );
    expect(out).toMatch(/Inbox: 5 ambient/);
    expect(out).toMatch(/auto-expire/);
    // Doesn't pretend there are unresolved items
    expect(out).not.toMatch(/unresolved/);
  });

  it('renders unresolved count (tier3 + tier2) with tier breakdown', () => {
    const out = buildWtfHeader(
      partnerOpts({
        inboxSummary: {
          tier3Count: 1,
          tier2Count: 2,
          tier1Count: 0,
          tier3Peek: [{ from: 'mark', subject: 'what is the corp status?', ageLabel: '3h ago' }],
          tier2Peek: [
            { from: 'herald', subject: 'chits status?', ageLabel: '20m ago' },
            { from: 'hr', subject: 'onboarding check', ageLabel: '1h ago' },
          ],
        },
      }),
    );
    expect(out).toContain('Inbox: 3 unresolved');
    expect(out).toContain('[T3] 1 critical');
    expect(out).toContain('[T2] 2 direct');
  });

  it('includes ambient addendum when mixed tier + ambient', () => {
    const out = buildWtfHeader(
      partnerOpts({ inboxSummary: { tier3Count: 1, tier2Count: 0, tier1Count: 5 } }),
    );
    expect(out).toMatch(/\+5 ambient auto-expiring/);
  });

  it('renders tier 3 peek items (founder DMs and such are high-visibility)', () => {
    const out = buildWtfHeader(
      partnerOpts({
        inboxSummary: {
          tier3Count: 1,
          tier2Count: 0,
          tier1Count: 0,
          tier3Peek: [{ from: 'mark', subject: 'corp status?', ageLabel: '3h ago' }],
        },
      }),
    );
    expect(out).toContain('• mark — "corp status?" (3h ago)');
  });

  it('flags Tier 3 as audit-blocking so the agent sees consequences', () => {
    const out = buildWtfHeader(
      partnerOpts({ inboxSummary: { tier3Count: 1, tier2Count: 0, tier1Count: 0 } }),
    );
    expect(out).toMatch(/audit will block completion while unresolved/i);
  });
});

describe('buildWtfHeader — handoff block (Employee-only)', () => {
  it('renders predecessor handoff XML when Employee has one', () => {
    const out = buildWtfHeader(
      employeeOpts({
        handoffXml: '<handoff><current-step>chit-t-abc</current-step><next-action>run the build</next-action></handoff>',
      }),
    );
    expect(out).toContain('Handoff from predecessor session:');
    expect(out).toContain('<handoff>');
    expect(out).toContain('<next-action>run the build</next-action>');
  });

  it('omits handoff section when Employee has no predecessor', () => {
    const out = buildWtfHeader(employeeOpts());
    expect(out).not.toContain('Handoff from predecessor');
  });

  it('omits handoff section when handoffXml is empty string (no stale empty tags)', () => {
    const out = buildWtfHeader(employeeOpts({ handoffXml: '   ' }));
    expect(out).not.toContain('Handoff from predecessor');
  });

  it('Partners never render handoff, even if caller passes one by accident', () => {
    const out = buildWtfHeader(
      partnerOpts({ handoffXml: '<handoff>should not appear</handoff>' }),
    );
    expect(out).not.toContain('Handoff from predecessor');
    expect(out).not.toContain('should not appear');
  });
});

describe('buildWtfHeader — footer', () => {
  it('includes the generated timestamp from opts', () => {
    const out = buildWtfHeader(partnerOpts({ generatedAt: '2026-04-22T14:30:00.000Z' }));
    expect(out).toContain('Generated: 2026-04-22T14:30:00.000Z');
  });

  it('points at CORP.md path so the agent can re-read without re-running', () => {
    const out = buildWtfHeader(
      partnerOpts({ corpMdPath: '/custom/path/CORP.md' }),
    );
    expect(out).toContain('CORP.md at: /custom/path/CORP.md');
  });

  it('ends with the re-run instruction (survival hint for disorientation)', () => {
    const out = buildWtfHeader(partnerOpts());
    expect(out).toMatch(/Re-run `cc-cli wtf` any time/);
  });
});

describe('buildWtfHeader — determinism', () => {
  it('same opts produce identical output (no Date.now() or randomness inside)', () => {
    const opts = partnerOpts({
      currentTask: { chitId: 'chit-t-aaaaaaaa', title: 'test' },
      inboxSummary: { tier3Count: 2, tier2Count: 1, tier1Count: 0 },
    });
    const a = buildWtfHeader(opts);
    const b = buildWtfHeader(opts);
    expect(a).toBe(b);
  });

  it('output ends with a trailing newline (for concatenation into system-reminder block)', () => {
    expect(buildWtfHeader(partnerOpts()).endsWith('\n')).toBe(true);
    expect(buildWtfHeader(employeeOpts()).endsWith('\n')).toBe(true);
  });
});

describe('buildWtfHeader — full shape', () => {
  it('Partner with full state renders all sections in order', () => {
    const out = buildWtfHeader(
      partnerOpts({
        currentTask: { chitId: 'chit-t-11111111', title: 'Ship 0.7.1' },
        inboxSummary: {
          tier3Count: 1,
          tier2Count: 1,
          tier1Count: 3,
          tier3Peek: [{ from: 'mark', subject: 'How is 0.7 going?', ageLabel: '10m ago' }],
          tier2Peek: [{ from: 'herald', subject: 'digest ready', ageLabel: '5m ago' }],
        },
      }),
    );

    const idxIdentity = out.indexOf('You are CEO');
    const idxSandbox = out.indexOf('Sandbox:');
    const idxCurrentTask = out.indexOf('Current task:');
    const idxInbox = out.indexOf('Inbox:');
    const idxFooter = out.indexOf('Generated:');

    expect(idxIdentity).toBe(0);
    expect(idxIdentity).toBeLessThan(idxSandbox);
    expect(idxSandbox).toBeLessThan(idxCurrentTask);
    expect(idxCurrentTask).toBeLessThan(idxInbox);
    expect(idxInbox).toBeLessThan(idxFooter);
  });

  it('Employee with predecessor handoff places handoff between inbox and footer', () => {
    const out = buildWtfHeader(
      employeeOpts({
        currentTask: { chitId: 'chit-t-22222222', title: 'Continue migration' },
        handoffXml: '<handoff><next-action>do the thing</next-action></handoff>',
        inboxSummary: emptyInbox(),
      }),
    );

    const idxInbox = out.indexOf('Inbox:');
    const idxHandoff = out.indexOf('Handoff from predecessor');
    const idxFooter = out.indexOf('Generated:');

    expect(idxInbox).toBeGreaterThan(-1);
    expect(idxHandoff).toBeGreaterThan(idxInbox);
    expect(idxFooter).toBeGreaterThan(idxHandoff);
  });
});
