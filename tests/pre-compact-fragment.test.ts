import { describe, it, expect } from 'vitest';
import { preCompactSignalFragment } from '../packages/daemon/src/fragments/pre-compact-signal.js';
import type { FragmentContext } from '../packages/daemon/src/fragments/types.js';

/**
 * Fragment gating for Project 1.7. The math primitive + builder each
 * own their own suites; this file covers the four-way `applies` gate
 * and confirms `render` surfaces the threshold summary.
 */

function baseCtx(overrides: Partial<FragmentContext> = {}): FragmentContext {
  return {
    agentDir: '/tmp/fake',
    corpRoot: '/tmp/corp',
    channelName: 'general',
    channelMembers: [],
    corpMembers: [],
    recentHistory: [],
    agentDisplayName: 'Toast',
    channelKind: 'direct',
    supervisorName: 'Mark',
    agentKind: 'partner',
    harness: 'claude-code',
    sessionTokens: 160_000,
    sessionModel: 'claude-haiku-4-5-20251001',
    ...overrides,
  };
}

describe('preCompactSignalFragment — gating', () => {
  it('fires for Partner + claude-code + tokens in signal window', () => {
    expect(preCompactSignalFragment.applies(baseCtx())).toBe(true);
  });

  it('does NOT fire for Employee', () => {
    expect(preCompactSignalFragment.applies(baseCtx({ agentKind: 'employee' }))).toBe(false);
  });

  it('does NOT fire for Partner on openclaw harness', () => {
    expect(preCompactSignalFragment.applies(baseCtx({ harness: 'openclaw' }))).toBe(false);
  });

  it('does NOT fire when sessionTokens is undefined (first turn, no snapshot)', () => {
    expect(preCompactSignalFragment.applies(baseCtx({ sessionTokens: undefined }))).toBe(false);
  });

  it('does NOT fire when sessionModel is undefined', () => {
    expect(preCompactSignalFragment.applies(baseCtx({ sessionModel: undefined }))).toBe(false);
  });

  it('does NOT fire well below ourSignalAt (50k in a 200k window)', () => {
    expect(preCompactSignalFragment.applies(baseCtx({ sessionTokens: 50_000 }))).toBe(false);
  });

  it('does NOT fire once past autoCompactAt (windows is [ourSignalAt, autoCompactAt))', () => {
    // 200k window: autoCompactAt = 167_000. 170k is past the window — the
    // signal fragment should NOT fire (missed our runway; Claude Code is
    // about to autocompact imminently).
    expect(preCompactSignalFragment.applies(baseCtx({ sessionTokens: 170_000 }))).toBe(false);
  });

  it('fires exactly at ourSignalAt boundary (150k in a 200k window)', () => {
    expect(preCompactSignalFragment.applies(baseCtx({ sessionTokens: 150_000 }))).toBe(true);
  });

  it('does NOT fire exactly at autoCompactAt (window is half-open)', () => {
    expect(preCompactSignalFragment.applies(baseCtx({ sessionTokens: 167_000 }))).toBe(false);
  });

  it('fires for a 1M model at 955k tokens (scales with context window)', () => {
    expect(
      preCompactSignalFragment.applies(
        baseCtx({ sessionTokens: 955_000, sessionModel: 'claude-opus-4-7' }),
      ),
    ).toBe(true);
  });
});

describe('preCompactSignalFragment — render', () => {
  it('includes the formatted threshold summary', () => {
    const out = preCompactSignalFragment.render(baseCtx({ sessionTokens: 160_000 }));
    expect(out).toMatch(/\d+k \/ 180k tokens/);
    expect(out).toMatch(/\d+% full/);
    expect(out).toMatch(/until autocompact/);
  });

  it('tells the Partner to crystallize via cc-cli observe', () => {
    const out = preCompactSignalFragment.render(baseCtx());
    expect(out).toContain('cc-cli observe');
    expect(out).toContain('Crystallize now');
  });

  it('names CHECKPOINT as the Partner-equivalent-of-handoff category', () => {
    const out = preCompactSignalFragment.render(baseCtx());
    expect(out).toContain('CHECKPOINT');
  });

  it('mentions BRAIN/ as durable storage', () => {
    const out = preCompactSignalFragment.render(baseCtx());
    expect(out).toContain('BRAIN/');
  });

  it('does NOT suggest cc-cli handoff — renamed to cc-cli done during 0.7.3', () => {
    const out = preCompactSignalFragment.render(baseCtx());
    expect(out).not.toMatch(/cc-cli\s+handoff/);
  });

  it('references the real Casket-moving commands (done / hand / chain-walker)', () => {
    const out = preCompactSignalFragment.render(baseCtx());
    expect(out).toContain('cc-cli done');
    expect(out).toContain('cc-cli hand');
  });

  it('has order=5 — renders before workspace/context/history fragments', () => {
    expect(preCompactSignalFragment.order).toBe(5);
  });
});
