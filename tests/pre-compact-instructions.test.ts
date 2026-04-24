import { describe, it, expect } from 'vitest';
import { buildPreCompactInstructions } from '../packages/shared/src/audit/pre-compact-instructions.js';

/**
 * Pure builder — every branch of the kind / custom_instructions /
 * trigger matrix.
 */

describe('buildPreCompactInstructions — kind gate', () => {
  it('employee kind returns empty string (no template emitted yet)', () => {
    const out = buildPreCompactInstructions({
      hookInput: { trigger: 'manual', custom_instructions: 'whatever' },
      kind: 'employee',
      agentDisplayName: 'Toast',
      agentSlug: 'toast',
    });
    expect(out).toBe('');
  });

  it('partner kind returns a non-empty template', () => {
    const out = buildPreCompactInstructions({
      hookInput: { trigger: 'manual', custom_instructions: null },
      kind: 'partner',
      agentDisplayName: 'Toast',
      agentSlug: 'toast',
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('Partner: Toast');
  });
});

describe('buildPreCompactInstructions — founder ask threading', () => {
  it('custom_instructions rendered FIRST above default shape', () => {
    const out = buildPreCompactInstructions({
      hookInput: {
        trigger: 'manual',
        custom_instructions: 'keep the cool-bay research emphasis',
      },
      kind: 'partner',
      agentDisplayName: 'Toast',
      agentSlug: 'toast',
    });
    const idxFounder = out.indexOf("Founder's compact request");
    const idxDefault = out.indexOf('Claude Corp compact-summary shape');
    expect(idxFounder).toBeGreaterThanOrEqual(0);
    expect(idxDefault).toBeGreaterThanOrEqual(0);
    expect(idxFounder).toBeLessThan(idxDefault);
    expect(out).toContain('keep the cool-bay research emphasis');
    expect(out).toContain('Honor this above all else');
  });

  it('whitespace-only custom_instructions is treated as absent', () => {
    const out = buildPreCompactInstructions({
      hookInput: { trigger: 'manual', custom_instructions: '   \n  ' },
      kind: 'partner',
      agentDisplayName: 'Toast',
      agentSlug: 'toast',
    });
    expect(out).not.toContain("Founder's compact request");
  });

  it('null custom_instructions omits the founder-ask section', () => {
    const out = buildPreCompactInstructions({
      hookInput: { trigger: 'auto', custom_instructions: null },
      kind: 'partner',
      agentDisplayName: 'Toast',
      agentSlug: 'toast',
    });
    expect(out).not.toContain("Founder's compact request");
    expect(out).toContain('Partner: Toast');
  });
});

describe('buildPreCompactInstructions — trigger wording', () => {
  it('trigger=auto surfaces "auto" in the shape section', () => {
    const out = buildPreCompactInstructions({
      hookInput: { trigger: 'auto', custom_instructions: null },
      kind: 'partner',
      agentDisplayName: 'Toast',
      agentSlug: 'toast',
    });
    expect(out).toMatch(/triggered `auto`/);
  });

  it('trigger=manual surfaces "manual" in the shape section', () => {
    const out = buildPreCompactInstructions({
      hookInput: { trigger: 'manual', custom_instructions: null },
      kind: 'partner',
      agentDisplayName: 'Toast',
      agentSlug: 'toast',
    });
    expect(out).toMatch(/triggered `manual`/);
  });

  it('unknown/missing trigger defaults to manual', () => {
    const out = buildPreCompactInstructions({
      hookInput: { custom_instructions: null },
      kind: 'partner',
      agentDisplayName: 'Toast',
      agentSlug: 'toast',
    });
    expect(out).toMatch(/triggered `manual`/);
  });
});

describe('buildPreCompactInstructions — substrate anchors', () => {
  it('references the agent-specific Casket path', () => {
    const out = buildPreCompactInstructions({
      hookInput: { trigger: 'manual', custom_instructions: null },
      kind: 'partner',
      agentDisplayName: 'Toast',
      agentSlug: 'toast',
    });
    expect(out).toContain('agents/toast/casket.md');
  });

  it('names the key preservation categories', () => {
    const out = buildPreCompactInstructions({
      hookInput: { trigger: 'manual', custom_instructions: null },
      kind: 'partner',
      agentDisplayName: 'Toast',
      agentSlug: 'toast',
    });
    expect(out).toContain('Current work pointer');
    expect(out).toContain('In-flight reasoning');
    expect(out).toContain('Open questions');
    expect(out).toContain('Verbatim references');
  });
});
