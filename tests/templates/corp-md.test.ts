import { describe, it, expect } from 'vitest';
import { buildCorpMd, type CorpMdOpts } from '../../packages/shared/src/templates/corp-md.js';

/**
 * Pure-template tests for CORP.md rendering. No I/O — the renderer takes
 * options and returns a string. These tests pin the structural contract
 * the \`cc-cli wtf\` command (0.7.1) relies on.
 */

function partnerOpts(overrides: Partial<CorpMdOpts> = {}): CorpMdOpts {
  return {
    kind: 'partner',
    agentSlug: 'ceo',
    displayName: 'CEO',
    role: 'CEO',
    corpName: 'my-corporation',
    workspacePath: '/home/mark/.claudecorp/my-corporation/agents/ceo',
    ...overrides,
  };
}

function employeeOpts(overrides: Partial<CorpMdOpts> = {}): CorpMdOpts {
  return {
    kind: 'employee',
    agentSlug: 'toast',
    displayName: 'Toast',
    role: 'Backend Engineer',
    corpName: 'my-corporation',
    workspacePath: '/home/mark/.claudecorp/my-corporation/projects/platform/agents/toast',
    rolePreBrainPath: '/home/mark/.claudecorp/my-corporation/roles/backend-engineer/pre-brain/',
    ...overrides,
  };
}

describe('buildCorpMd — structural sanity', () => {
  it('starts with the corp-name heading', () => {
    const partnerOut = buildCorpMd(partnerOpts());
    const employeeOut = buildCorpMd(employeeOpts());
    expect(partnerOut.startsWith('# my-corporation — Orchestration Manual')).toBe(true);
    expect(employeeOut.startsWith('# my-corporation — Orchestration Manual')).toBe(true);
  });

  it('opens with the "everything you need to know" framing', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('everything you need to know to work in this corp');
  });

  it('ends with a trailing newline (for clean file concatenation)', () => {
    expect(buildCorpMd(partnerOpts()).endsWith('\n')).toBe(true);
    expect(buildCorpMd(employeeOpts()).endsWith('\n')).toBe(true);
  });

  it('is non-empty for both kinds', () => {
    expect(buildCorpMd(partnerOpts()).length).toBeGreaterThan(500);
    expect(buildCorpMd(employeeOpts()).length).toBeGreaterThan(500);
  });
});

describe('buildCorpMd — required section headings', () => {
  const requiredSections = [
    '## Architecture',
    '## Roles',
    '## The Two Non-Negotiables',
    '## Core Concepts',
    '## Chit Lifecycle',
    '## Task Complexity',
    '## Session Model',
    '## Commands Quick Reference',
    '## Communication',
    '## The Audit Gate',
    '## Write Down What Matters',
    '## BRAIN',
    '## Coordinating Contracts (Partner)',
    '## Executing a Task (Worker)',
    '## File Paths',
    '## Common Patterns',
    '## Red Lines',
    '## Common Mistakes',
  ];

  it.each(requiredSections)('contains "%s" section for Partners', (heading) => {
    expect(buildCorpMd(partnerOpts())).toContain(heading);
  });

  it.each(requiredSections)('contains "%s" section for Employees', (heading) => {
    expect(buildCorpMd(employeeOpts())).toContain(heading);
  });

  it('kind-specific section header appears exactly once per kind', () => {
    const partner = buildCorpMd(partnerOpts());
    const employee = buildCorpMd(employeeOpts());
    expect(partner).toContain('## You are a Partner');
    expect(partner).not.toContain('## You are an Employee');
    expect(employee).toContain('## You are an Employee');
    expect(employee).not.toContain('## You are a Partner');
  });
});

describe('buildCorpMd — the Two Non-Negotiables (load-bearing)', () => {
  it('names both rules with their canonical titles', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('### 1. The Casket Imperative');
    expect(out).toContain('### 2. The Audit Gate');
  });

  it('Casket Imperative content is unambiguous about immediate execution', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/If your Casket has work, execute it immediately/);
    expect(out).toMatch(/Dispatch IS your assignment/);
  });

  it('Audit Gate content lists the specific items the hook checks', () => {
    const out = buildCorpMd(partnerOpts());
    // All the items must appear in the rule text so agents know what to prepare
    expect(out).toMatch(/acceptance criterion/i);
    expect(out).toMatch(/re-read it/);
    expect(out).toMatch(/Build ran/);
    expect(out).toMatch(/Tests ran/);
    expect(out).toMatch(/Git status/);
    expect(out).toMatch(/Tier 3 inbox/);
  });

  it('rules appear identically across kinds (they are the corp-wide non-negotiables)', () => {
    const partner = buildCorpMd(partnerOpts());
    const employee = buildCorpMd(employeeOpts());
    const extract = (s: string) => {
      const start = s.indexOf('## The Two Non-Negotiables');
      const end = s.indexOf('\n## ', start + 1);
      return s.slice(start, end);
    };
    expect(extract(partner)).toBe(extract(employee));
  });
});

describe('buildCorpMd — Partner-specific content', () => {
  it('describes compaction-based session model, not handoff', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/compaction/i);
    expect(out).toMatch(/\/compact/);
    expect(out).toMatch(/PreCompact/);
  });

  it('mentions durable soul files the Partner owns', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('SOUL.md');
    expect(out).toContain('IDENTITY.md');
    expect(out).toContain('USER.md');
    expect(out).toContain('MEMORY.md');
    expect(out).toContain('BRAIN/');
  });

  it('mentions founder-can-DM-directly (UserPromptSubmit hook path)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/DMed directly by the founder/i);
    expect(out).toMatch(/UserPromptSubmit/);
  });

  it('does NOT describe handoff-based session model (Employee-only)', () => {
    const out = buildCorpMd(partnerOpts());
    // The words appear in general lifecycle content, so target the specific
    // "cycle per step" language that's Employee-only.
    expect(out).not.toMatch(/cycle per step/i);
    expect(out).not.toMatch(/self-chosen name/);
  });
});

describe('buildCorpMd — Employee-specific content', () => {
  it('describes per-step session cycling with handoff via WORKLOG', () => {
    const out = buildCorpMd(employeeOpts());
    expect(out).toMatch(/per-step/i);
    expect(out).toContain('WORKLOG.md');
    expect(out).toContain('hand-complete');
    expect(out).toContain('Dredge');
  });

  it('explicitly states the Employee has no slot-level SOUL/IDENTITY/BRAIN', () => {
    const out = buildCorpMd(employeeOpts());
    expect(out).toMatch(/no slot-level SOUL/);
    expect(out).toMatch(/identity IS your role/i);
  });

  it('references the role-level pre-BRAIN path from options', () => {
    const out = buildCorpMd(employeeOpts());
    expect(out).toContain('/home/mark/.claudecorp/my-corporation/roles/backend-engineer/pre-brain/');
  });

  it('notes Employees cannot be DMed directly by the founder (Partners broker)', () => {
    const out = buildCorpMd(employeeOpts());
    expect(out).toMatch(/cannot be DMed directly by the founder/i);
    expect(out).toMatch(/Partners broker/i);
  });

  it('falls back to placeholder pre-BRAIN path if none provided', () => {
    const out = buildCorpMd(employeeOpts({ rolePreBrainPath: undefined }));
    expect(out).toContain('<corp>/roles/<role>/pre-brain/');
  });
});

describe('buildCorpMd — interpolation', () => {
  it('interpolates corpName into the heading', () => {
    const out = buildCorpMd(partnerOpts({ corpName: 'acme-corp' }));
    expect(out).toContain('# acme-corp — Orchestration Manual');
    expect(out).toContain('~/.claudecorp/acme-corp/');
  });

  it('interpolates workspacePath into file-paths section', () => {
    const weirdPath = '/custom/workspace/path';
    const out = buildCorpMd(partnerOpts({ workspacePath: weirdPath }));
    expect(out).toContain(`${weirdPath}/SOUL.md`);
    expect(out).toContain(`${weirdPath}/CORP.md`);
    expect(out).toContain(`${weirdPath}/chits/observation/`);
  });

  it('interpolates displayName into Employee section (they use their slot name)', () => {
    const out = buildCorpMd(employeeOpts({ displayName: 'Copper' }));
    expect(out).toContain('Your name is `Copper`');
  });
});

describe('buildCorpMd — determinism', () => {
  it('is purely deterministic: same opts produce identical output', () => {
    const opts = partnerOpts();
    const a = buildCorpMd(opts);
    const b = buildCorpMd(opts);
    expect(a).toBe(b);
  });

  it('includes no timestamps, random ids, or Date.now() leakage (wtf command owns those)', () => {
    const out = buildCorpMd(partnerOpts());
    // A liberal check: if any Date/ISO-shaped string appears, something leaked.
    // The template is pure reference content — no "as of <timestamp>" inline.
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('buildCorpMd — section ordering (canonical sequence)', () => {
  // Renumber the rules and an agent reads section-by-section — if "Red Lines"
  // appears before "The Two Non-Negotiables" because someone reordered the
  // function calls, the reading flow breaks. Pin the order explicitly.
  const canonicalOrder = [
    '# ',
    'This file contains everything',
    '## Architecture',
    '## Roles',
    '## The Two Non-Negotiables',
    '## Core Concepts',
    '## Chit Lifecycle',
    '## Task Complexity',
    '## Session Model',
    '## Commands Quick Reference',
    '## Communication',
    '## The Audit Gate',
    '## File Paths',
    '## Common Patterns',
    '## Red Lines',
    '## Common Mistakes',
  ] as const;

  function assertCanonicalOrder(out: string) {
    const positions = canonicalOrder.map((marker) => ({ marker, idx: out.indexOf(marker) }));
    for (const p of positions) {
      expect(p.idx, `missing marker: ${p.marker}`).toBeGreaterThan(-1);
    }
    for (let i = 1; i < positions.length; i++) {
      expect(
        positions[i]!.idx,
        `"${positions[i]!.marker}" should appear after "${positions[i - 1]!.marker}"`,
      ).toBeGreaterThan(positions[i - 1]!.idx);
    }
  }

  it('Partner output follows canonical section order', () => {
    assertCanonicalOrder(buildCorpMd(partnerOpts()));
  });

  it('Employee output follows canonical section order', () => {
    assertCanonicalOrder(buildCorpMd(employeeOpts()));
  });

  it('kind-specific section appears between Chit Lifecycle and Task Complexity', () => {
    const partner = buildCorpMd(partnerOpts());
    const lifecycleIdx = partner.indexOf('## Chit Lifecycle');
    const partnerSectionIdx = partner.indexOf('## You are a Partner');
    const complexityIdx = partner.indexOf('## Task Complexity');
    expect(lifecycleIdx).toBeLessThan(partnerSectionIdx);
    expect(partnerSectionIdx).toBeLessThan(complexityIdx);
  });
});

describe('buildCorpMd — shared sections identical across kinds', () => {
  // Sections that are corp-wide and must not diverge between Partner/Employee
  // renderings. Drift between kinds here = agents working from conflicting
  // rulebooks.
  const sharedSections = [
    '## Architecture',
    '## Roles',
    '## The Two Non-Negotiables',
    '## Core Concepts',
    '## Chit Lifecycle',
    '## Task Complexity',
    '## Communication',
    '## The Audit Gate',
    '## Write Down What Matters',
    '## BRAIN',
    '## Coordinating Contracts (Partner)',
    '## Executing a Task (Worker)',
    '## Common Patterns',
    '## Red Lines',
    '## Common Mistakes',
  ];

  it.each(sharedSections)('section "%s" is identical between kinds', (heading) => {
    const partner = buildCorpMd(partnerOpts());
    const employee = buildCorpMd(employeeOpts());
    const extract = (s: string) => {
      const start = s.indexOf(heading);
      const end = s.indexOf('\n## ', start + 1);
      return s.slice(start, end === -1 ? undefined : end);
    };
    const partnerSection = extract(partner);
    const employeeSection = extract(employee);
    expect(partnerSection).toBe(employeeSection);
  });

  it('Commands Quick Reference lists the full expected CLI surface', () => {
    const out = buildCorpMd(partnerOpts());
    // Load-bearing commands agents will reach for constantly
    expect(out).toContain('cc-cli wtf');
    expect(out).toContain('cc-cli chit');
    expect(out).toContain('cc-cli task');
    expect(out).toContain('cc-cli observe');
    expect(out).toContain('cc-cli hand');
    expect(out).toContain('cc-cli inbox');
    expect(out).toContain('cc-cli hand-complete');
  });
});

describe('buildCorpMd — 0.7.2.1 fragment-port content (load-bearing pieces)', () => {
  // These pin the specific content ported from fragments so a future edit
  // to CORP.md can't silently drop the rules we migrated.

  it('Communication/Broadcast discipline — brevity + directive compliance (from debate-protocol)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('### Broadcast discipline');
    expect(out).toMatch(/keep responses concise/);
    // Phrase wraps across a newline in the template; match halves separately
    expect(out).toMatch(/Continued debate after a/);
    expect(out).toMatch(/noise, not diligence/);
  });

  it('Communication/Response shape — three-beat pattern + HIGH/LOW + worth-sending filter (from checkpoint + output-efficiency)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('### Response shape');
    expect(out).toMatch(/Acknowledge/);
    expect(out).toMatch(/HIGH:/);
    expect(out).toMatch(/LOW:/);
    expect(out).toMatch(/\*\*Worth sending:\*\*/);
    expect(out).toMatch(/\*\*Not worth sending:\*\*/);
  });

  it('Communication/Go direct — don\'t-route-through-CEO rule (from agent-communication)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('### Go direct');
    expect(out).toMatch(/don't route through a Partner/);
    expect(out).toMatch(/peer-to-peer/);
  });

  it('Communication/Asking the founder — <askFounder> XML pattern (from channel-etiquette)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('### Asking the founder a question');
    expect(out).toContain('<askFounder>');
    expect(out).toContain('<question>');
    expect(out).toMatch(/type="score"/);
    expect(out).toMatch(/type="multi"/);
  });

  it('Red Lines — three-tier structure (from blast-radius)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('### Write freely');
    expect(out).toContain('### Modify with care');
    expect(out).toContain('### Never');
  });

  it('Red Lines/Modify with care — locks.json protocol (from file-locking)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/Lock before writing any shared file/);
    expect(out).toContain('locks.json');
    expect(out).toMatch(/30 min/);
  });

  it('Common Mistakes — "got it, I\'ll remember" deflection (from fix-now)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/Deferring fixable feedback/);
    expect(out).toMatch(/got it, I'll remember/);
  });

  it('Common Mistakes — silent workarounds are hidden failures (from escalation-chain)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/Working around a problem instead of reporting it/);
    expect(out).toMatch(/BLOCKED is honest/);
  });

  it('Common Patterns — blocker Tried/Failed/Need shape (from blocker-escalation)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/Tried:/);
    expect(out).toMatch(/Failed:/);
    expect(out).toMatch(/Need:/);
  });

  it('Common Patterns — review feedback loop (from failure-recovery)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/I got FAIL'd on my work/);
    expect(out).toMatch(/Evidence decides, not hierarchy/);
  });

  it('Common Patterns — escalation chain + don\'t skip levels (from escalation-chain)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/Don't skip levels/);
    expect(out).toMatch(/nobody between us can help/);
  });

  it('Write Down What Matters — survives/does-not-survive lists (from context-persistence)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/If you didn't write it down, it doesn't exist after compaction/);
    expect(out).toMatch(/What survives compaction/);
    expect(out).toMatch(/What does NOT survive/);
  });

  it('Write Down What Matters — summarize large results + per-tool extract (from tool-result-management)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('### Summarize large tool results');
    expect(out).toContain('### What to extract per tool');
    expect(out).toMatch(/After reading a file/);
    expect(out).toMatch(/After a build\/typecheck/);
  });

  it('Core Concepts — Scratchpad concept (from scratchpad)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/\*\*Scratchpad\*\*/);
    expect(out).toMatch(/Channels = talking\. Scratchpad = making/);
  });

  it('BRAIN section — frontmatter schema + memory types + sources (from brain)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('## BRAIN');
    expect(out).toMatch(/Browseable, Reflective, Authored, Indexed Notes/);
    expect(out).toMatch(/founder-preference/);
    expect(out).toMatch(/last_validated/);
  });

  it('Coordinating Contracts (Partner) — 4-phase workflow + BANNED/GOOD synthesis (from coordinator)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toContain('## Coordinating Contracts (Partner)');
    expect(out).toMatch(/Research/);
    expect(out).toMatch(/Synthesis/);
    expect(out).toMatch(/BANNED:/);
    expect(out).toMatch(/GOOD:/);
  });

  it('Coordinating Contracts — Create→Hand workflow + blockedBy + Loops/Crons + Hiring (from delegation)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/Create → Hand workflow/);
    expect(out).toMatch(/blockedBy/);
    expect(out).toMatch(/\*\*Loop\*\*/);
    expect(out).toMatch(/\*\*Cron\*\*/);
    expect(out).toMatch(/### Hiring/);
  });

  it('Coordinating Contracts — CEO/master reporting + triage (from ceo-reporting)', () => {
    const out = buildCorpMd(partnerOpts());
    expect(out).toMatch(/If you're the CEO \(master rank\)/);
    expect(out).toMatch(/What happened/);
    expect(out).toMatch(/Proactive triage/);
  });

  it('Executing a Task (Worker) — 6-step flow (from task-execution)', () => {
    const out = buildCorpMd(employeeOpts());
    expect(out).toContain('## Executing a Task (Worker)');
    expect(out).toMatch(/Read the full task chit/);
    expect(out).toMatch(/Mark in_progress/);
    expect(out).toMatch(/Do the work/);
    expect(out).toMatch(/Verify/);
    expect(out).toMatch(/Complete/);
    expect(out).toMatch(/Report/);
  });

  it('Executing a Task — "specificity is respect" for clarifications (from receiving-delegation)', () => {
    const out = buildCorpMd(employeeOpts());
    expect(out).toMatch(/specificity is the respect/);
    expect(out).toMatch(/Bad:/);
    expect(out).toMatch(/Good:/);
  });
});
