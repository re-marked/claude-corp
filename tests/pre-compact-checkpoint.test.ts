import { describe, it, expect } from 'vitest';
import {
  buildCheckpointObservation,
  type CheckpointBuilderInput,
} from '../packages/shared/src/audit/pre-compact-checkpoint.js';

/**
 * Pure builder — exhaustive coverage of the checkpoint content shape,
 * kind gate, founder-ask threading, casket handling, assistant-text
 * excerpt selection + truncation, and observation-field structure.
 *
 * Integration (writeAutoCheckpoint in audit.ts actually calling
 * createChit) deferred — thin plumbing over already-tested primitives
 * (parseTranscript, resolveCurrentTask, createChit). Review catches
 * wiring bugs faster than mechanical I/O tests.
 */

function baseInput(overrides: Partial<CheckpointBuilderInput> = {}): CheckpointBuilderInput {
  return {
    hookInput: { trigger: 'manual', custom_instructions: null },
    kind: 'partner',
    agentDisplayName: 'Toast',
    agentSlug: 'toast',
    casket: { chitId: 'chit-t-abc12345', title: 'Wire pre-compact hook to audit' },
    recent: { assistantText: ['I was reviewing the audit branch.'] },
    nowIso: '2026-04-23T18:05:23.000Z',
    ...overrides,
  };
}

describe('buildCheckpointObservation — kind gate', () => {
  it('employee returns null (no auto-checkpoint yet)', () => {
    const out = buildCheckpointObservation(baseInput({ kind: 'employee' }));
    expect(out).toBeNull();
  });

  it('partner returns a populated spec', () => {
    const out = buildCheckpointObservation(baseInput());
    expect(out).not.toBeNull();
    expect(out!.body).toContain('Pre-Compact Checkpoint — Toast');
  });
});

describe('buildCheckpointObservation — observation field structure', () => {
  it('category is NOTICE (chit-level vocabulary — CHECKPOINT is not a valid chit category)', () => {
    const out = buildCheckpointObservation(baseInput())!;
    expect(out.fields.observation.category).toBe('NOTICE');
  });

  it('subject is the agent slug (self-witnessing)', () => {
    const out = buildCheckpointObservation(baseInput())!;
    expect(out.fields.observation.subject).toBe('toast');
  });

  it('importance is 3 — moderate, ambient self-record', () => {
    const out = buildCheckpointObservation(baseInput())!;
    expect(out.fields.observation.importance).toBe(3);
  });

  it('title names the trigger', () => {
    const auto = buildCheckpointObservation(baseInput({ hookInput: { trigger: 'auto' } }))!;
    const manual = buildCheckpointObservation(baseInput({ hookInput: { trigger: 'manual' } }))!;
    expect(auto.fields.observation.title).toContain('auto');
    expect(manual.fields.observation.title).toContain('manual');
  });

  it('scope is agent:<slug>', () => {
    const out = buildCheckpointObservation(baseInput())!;
    expect(out.scope).toBe('agent:toast');
  });

  it('createdBy is the agent slug (chit authored by the Partner themselves)', () => {
    const out = buildCheckpointObservation(baseInput())!;
    expect(out.createdBy).toBe('toast');
  });

  it('ephemeral is false — observations-at-compact-boundary live forever as soul material', () => {
    const out = buildCheckpointObservation(baseInput())!;
    expect(out.ephemeral).toBe(false);
  });
});

describe('buildCheckpointObservation — tags', () => {
  it('always tagged with from-log:CHECKPOINT, auto-checkpoint, pre-compact', () => {
    const out = buildCheckpointObservation(baseInput())!;
    expect(out.tags).toContain('from-log:CHECKPOINT');
    expect(out.tags).toContain('auto-checkpoint');
    expect(out.tags).toContain('pre-compact');
  });

  it('trigger:auto baked into tags when auto-compacted', () => {
    const out = buildCheckpointObservation(
      baseInput({ hookInput: { trigger: 'auto' } }),
    )!;
    expect(out.tags).toContain('trigger:auto');
  });

  it('trigger:manual baked into tags when manually /compact typed', () => {
    const out = buildCheckpointObservation(
      baseInput({ hookInput: { trigger: 'manual' } }),
    )!;
    expect(out.tags).toContain('trigger:manual');
  });

  it('trigger defaults to manual when hookInput.trigger is absent', () => {
    const out = buildCheckpointObservation(
      baseInput({ hookInput: {} }),
    )!;
    expect(out.tags).toContain('trigger:manual');
  });
});

describe('buildCheckpointObservation — founder ask threading', () => {
  it('renders founder ask as blockquote when custom_instructions present', () => {
    const out = buildCheckpointObservation(
      baseInput({
        hookInput: {
          trigger: 'manual',
          custom_instructions: 'preserve the cool-bay research emphasis',
        },
      }),
    )!;
    expect(out.body).toContain('Founder ask');
    expect(out.body).toMatch(/> preserve the cool-bay research emphasis/);
  });

  it('emits "_(none)_" marker when custom_instructions is null', () => {
    const out = buildCheckpointObservation(
      baseInput({ hookInput: { trigger: 'manual', custom_instructions: null } }),
    )!;
    expect(out.body).toContain('Founder ask:** _(none)_');
  });

  it('whitespace-only custom_instructions treated as absent', () => {
    const out = buildCheckpointObservation(
      baseInput({ hookInput: { trigger: 'manual', custom_instructions: '   \n  ' } }),
    )!;
    expect(out.body).toContain('_(none)_');
  });

  it('founder ask preserved in observation.context field', () => {
    const out = buildCheckpointObservation(
      baseInput({
        hookInput: {
          trigger: 'manual',
          custom_instructions: 'keep the orchestration focus',
        },
      }),
    )!;
    expect(out.fields.observation.context).toBe('keep the orchestration focus');
  });

  it('context is null when no founder ask', () => {
    const out = buildCheckpointObservation(
      baseInput({ hookInput: { trigger: 'auto', custom_instructions: null } }),
    )!;
    expect(out.fields.observation.context).toBeNull();
  });
});

describe('buildCheckpointObservation — casket anchor', () => {
  it('renders chit id + title when casket has both', () => {
    const out = buildCheckpointObservation(baseInput())!;
    expect(out.body).toContain('chit-t-abc12345');
    expect(out.body).toContain('Wire pre-compact hook to audit');
  });

  it('renders just the chit id when title is null', () => {
    const out = buildCheckpointObservation(
      baseInput({ casket: { chitId: 'chit-t-xyz99999', title: null } }),
    )!;
    expect(out.body).toContain('chit-t-xyz99999');
    expect(out.body).not.toMatch(/"null"/);
  });

  it('says "idle — no active task" when casket is null', () => {
    const out = buildCheckpointObservation(baseInput({ casket: null }))!;
    expect(out.body).toContain('idle — no active task');
  });
});

describe('buildCheckpointObservation — recent activity excerpts', () => {
  it('renders the last 3 assistant-text blocks as blockquotes', () => {
    const out = buildCheckpointObservation(
      baseInput({
        recent: {
          assistantText: [
            'first turn — too old to surface',
            'second turn',
            'third turn',
            'fourth turn',
            'fifth turn (most recent)',
          ],
        },
      }),
    )!;
    expect(out.body).toContain('Last intent');
    expect(out.body).toMatch(/> third turn/);
    expect(out.body).toMatch(/> fourth turn/);
    expect(out.body).toMatch(/> fifth turn/);
    expect(out.body).not.toMatch(/> first turn/);
    expect(out.body).not.toMatch(/> second turn/);
  });

  it('truncates excerpts longer than 600 chars with an ellipsis', () => {
    const longText = 'x'.repeat(700);
    const out = buildCheckpointObservation(
      baseInput({ recent: { assistantText: [longText] } }),
    )!;
    expect(out.body).toMatch(/…/);
    // blockquote line should be ≤ 602 (`> ` prefix + 600 chars including ellipsis)
    const quoteLine = out.body.split('\n').find((line) => line.startsWith('> xxx'));
    expect(quoteLine).toBeTruthy();
    expect(quoteLine!.length).toBeLessThanOrEqual(602);
  });

  it('skips empty-string and whitespace-only excerpts', () => {
    const out = buildCheckpointObservation(
      baseInput({
        recent: {
          assistantText: ['   ', '', 'real content'],
        },
      }),
    )!;
    expect(out.body).toMatch(/> real content/);
    // No stray empty blockquotes (a bare `> ` line would be an empty excerpt leaking through)
    expect(out.body).not.toMatch(/^> $/m);
  });

  it('omits the Last intent section entirely when recent is null', () => {
    const out = buildCheckpointObservation(baseInput({ recent: null }))!;
    expect(out.body).not.toContain('Last intent');
  });

  it('omits the Last intent section when assistantText is empty', () => {
    const out = buildCheckpointObservation(
      baseInput({ recent: { assistantText: [] } }),
    )!;
    expect(out.body).not.toContain('Last intent');
  });
});

describe('buildCheckpointObservation — timestamp threading', () => {
  it('uses the injected nowIso verbatim in the body', () => {
    const out = buildCheckpointObservation(
      baseInput({ nowIso: '2026-04-23T12:34:56.789Z' }),
    )!;
    expect(out.body).toContain('2026-04-23T12:34:56.789Z');
  });

  it('defaults nowIso to a valid ISO string when omitted', () => {
    const { nowIso: _nowIso, ...rest } = baseInput();
    void _nowIso;
    const out = buildCheckpointObservation(rest)!;
    const isoMatch = out.body.match(/`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)`/);
    expect(isoMatch).toBeTruthy();
  });
});
